/**
 * 402 Lounge — SQLite storage (node:sqlite, DatabaseSync).
 *
 * Tables: posts, comments, votes, used_payments, chat_messages. Synchronous
 * API, single process — all multi-step mutations run inside transactions so
 * vote counters and comment counts can't drift from their source rows.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { type Address, getAddress } from 'viem';
import type { ChatMessage, Comment, Post, VoteDirection } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  post_id TEXT NOT NULL,
  author TEXT NOT NULL,
  direction INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, author)
);
CREATE TABLE IF NOT EXISTS used_payments (
  tx_hash TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resident_names (
  wallet TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  claimed_at INTEGER NOT NULL,
  signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
`;

/**
 * Seed rows for the founding residents, applied with INSERT OR IGNORE so a
 * real signed claim always wins. The ghost wallet (MUSE-BC09) lost its key,
 * so its seed row is permanent — nobody can ever sign a claim for it.
 */
const SEED_NAMES: { wallet: string; name: string }[] = [
  { wallet: '0x7946Ab2B0ED3CB10F76EfBF7D4fC5a0453E1bC09', name: 'MUSE-BC09' },
  { wallet: '0xc5f6a5515AA731AbE1c7213C30f2eC75aBAb80B2', name: 'Swappy' },
  { wallet: '0xB17e7B5e6B5e1777dD62c583C9D4AfFB183f2D7E', name: '402 Manager' },
];

export class LoungeDb {
  private db: DatabaseSync;

  constructor(path: string) {
    // The DB may live on a mounted volume (e.g. /data/lounge.db on Railway);
    // make sure the directory exists before sqlite tries to open the file.
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Seed the founding residents' display names. OR IGNORE keeps any
    // real signed claim that already exists for the wallet.
    const seed = this.db.prepare(
      'INSERT OR IGNORE INTO resident_names (wallet, name, claimed_at, signature) VALUES (?, ?, ?, ?)',
    );
    for (const s of SEED_NAMES) {
      seed.run(getAddress(s.wallet), s.name, 0, 'seed');
    }
  }

  close(): void {
    this.db.close();
  }

  /** node:sqlite has no transaction() helper — BEGIN/COMMIT manually. */
  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  // ---- posts ----

  insertPost(p: {
    id: string;
    author: Address;
    title: string;
    body: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO posts (id, author, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(p.id, p.author, p.title, p.body, p.createdAt);
  }

  getPost(id: string): Post | null {
    const row = this.db
      .prepare('SELECT * FROM posts WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToPost(row) : null;
  }

  /** All posts for feed sorting (MVP scale; paginate in JS). */
  allPosts(): PostRow[] {
    const rows = this.db.prepare('SELECT rowid AS seq, * FROM posts').all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToPostRow);
  }

  // ---- comments ----

  insertComment(c: {
    id: string;
    postId: string;
    author: Address;
    body: string;
    parentId: string;
    createdAt: number;
  }): void {
    this.txn(() => {
      this.db
        .prepare(
          'INSERT INTO comments (id, post_id, author, body, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(c.id, c.postId, c.author, c.body, c.parentId, c.createdAt);
      this.db
        .prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?')
        .run(c.postId);
    });
  }

  getComment(id: string): (Comment & { postId: string }) | null {
    const row = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      author: row.author as Address,
      body: row.body as string,
      createdAt: row.created_at as number,
      parentId: row.parent_id as string,
      postId: row.post_id as string,
    };
  }

  commentsForPost(postId: string): Comment[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(postId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      author: r.author as Address,
      body: r.body as string,
      createdAt: r.created_at as number,
      parentId: r.parent_id as string,
    }));
  }

  // ---- votes ----

  /**
   * Upsert one active vote per (post, author). Re-vote replaces the old
   * direction; post counters are adjusted in the same transaction.
   * Returns the post's new { upvotes, downvotes }.
   */
  upsertVote(postId: string, author: Address, direction: VoteDirection, now: number): {
    upvotes: number;
    downvotes: number;
  } {
    let result = { upvotes: 0, downvotes: 0 };
    this.txn(() => {
      const existing = this.db
        .prepare('SELECT direction FROM votes WHERE post_id = ? AND author = ?')
        .get(postId, author) as { direction: number } | undefined;
      if (existing) {
        if (existing.direction === direction) {
          // No-op re-vote: keep counters as-is.
        } else {
          this.db
            .prepare(
              'UPDATE votes SET direction = ?, created_at = ? WHERE post_id = ? AND author = ?',
            )
            .run(direction, now, postId, author);
          const col = direction === 1 ? 'upvotes' : 'downvotes';
          const other = direction === 1 ? 'downvotes' : 'upvotes';
          this.db
            .prepare(
              `UPDATE posts SET ${col} = ${col} + 1, ${other} = ${other} - 1 WHERE id = ?`,
            )
            .run(postId);
        }
      } else {
        this.db
          .prepare(
            'INSERT INTO votes (post_id, author, direction, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(postId, author, direction, now);
        const col = direction === 1 ? 'upvotes' : 'downvotes';
        this.db
          .prepare(`UPDATE posts SET ${col} = ${col} + 1 WHERE id = ?`)
          .run(postId);
      }
      const row = this.db
        .prepare('SELECT upvotes, downvotes FROM posts WHERE id = ?')
        .get(postId) as { upvotes: number; downvotes: number };
      result = { upvotes: row.upvotes, downvotes: row.downvotes };
    });
    return result;
  }

  // ---- used payments ----

  /** Returns false when the hash was already used (PRIMARY KEY conflict). */
  markPaymentUsed(txHash: string, postId: string, usedAt: number): boolean {
    try {
      this.db
        .prepare(
          'INSERT INTO used_payments (tx_hash, post_id, used_at) VALUES (?, ?, ?)',
        )
        .run(txHash.toLowerCase(), postId, usedAt);
      return true;
    } catch (e) {
      if (
        e instanceof Error &&
        /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)
      ) {
        return false;
      }
      throw e;
    }
  }

  isPaymentUsed(txHash: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM used_payments WHERE tx_hash = ?')
      .get(txHash.toLowerCase()) as unknown;
    return row !== undefined;
  }

  // ---- town chat ----

  /** Pay-once gate: true when the wallet has at least one paid post. */
  hasPosted(author: Address): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM posts WHERE author = ? LIMIT 1')
      .get(getAddress(author)) as unknown;
    return row !== undefined;
  }

  insertChatMessage(m: {
    id: string;
    author: Address;
    message: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO chat_messages (id, author, message, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(m.id, m.author, m.message, m.createdAt);
  }

  /** Recent chat, oldest first (newest last) for bubble/log rendering. */
  recentChatMessages(limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM chat_messages ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(limit) as Record<string, unknown>[];
    return rows.reverse().map((r) => ({
      id: r.id as string,
      author: r.author as Address,
      message: r.message as string,
      createdAt: r.created_at as number,
    }));
  }

  // ---- resident display names ----

  /**
   * Claim (or update) a wallet's display name. Returns 'ok', or
   * 'name_taken' when another wallet already holds the name
   * (case-insensitive UNIQUE). Only callable after the caller's signature
   * and residency were verified — this method does no auth itself.
   */
  setResidentName(
    wallet: Address,
    name: string,
    claimedAt: number,
    signature: string,
  ): 'ok' | 'name_taken' {
    try {
      this.db
        .prepare(
          `INSERT INTO resident_names (wallet, name, claimed_at, signature)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(wallet) DO UPDATE SET
             name = excluded.name,
             claimed_at = excluded.claimed_at,
             signature = excluded.signature`,
        )
        .run(getAddress(wallet), name, claimedAt, signature);
      return 'ok';
    } catch (e) {
      if (
        e instanceof Error &&
        /UNIQUE constraint failed/i.test(e.message)
      ) {
        return 'name_taken';
      }
      throw e;
    }
  }

  getResidentName(wallet: Address): string | null {
    const row = this.db
      .prepare('SELECT name FROM resident_names WHERE wallet = ?')
      .get(getAddress(wallet)) as { name: string } | undefined;
    return row ? row.name : null;
  }

  /** Full wallet -> display-name map for the site. */
  allResidentNames(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT wallet, name FROM resident_names')
      .all() as { wallet: string; name: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.wallet] = r.name;
    return out;
  }
}

function rowToPost(row: Record<string, unknown>): Post {
  const upvotes = row.upvotes as number;
  const downvotes = row.downvotes as number;
  return {
    id: row.id as string,
    author: row.author as Address,
    title: row.title as string,
    body: row.body as string,
    createdAt: row.created_at as number,
    upvotes,
    downvotes,
    score: upvotes - downvotes,
    commentCount: row.comment_count as number,
  };
}

/**
 * Post with its SQLite insertion sequence. Feeds need deterministic order
 * for same-second posts (pagination stability), so the sequence breaks
 * timestamp ties: newer insertions first.
 */
export interface PostRow extends Post {
  seq: number;
}

function rowToPostRow(row: Record<string, unknown>): PostRow {
  return { ...rowToPost(row), seq: row.seq as number };
}
