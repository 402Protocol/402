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
import type { Card, HandStatus } from './blackjack.js';

/** One row of the shoe ledger. seed is retained server-side so it can be
 * revealed on reshuffle; agents verify sha256(seed) === seed_hash. */
export interface BlackjackShoeRow {
  id: string;
  seed: string;
  seedHash: string;
  seedRevealed: string | null;
  cards: Card[];
  pos: number;
  createdAt: number;
}

export interface BlackjackHandRow {
  id: string;
  wallet: Address;
  bet: bigint;
  playerJson: string;
  dealerJson: string;
  status: HandStatus;
  payout: bigint | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** Shoe rollover computed by the caller (server): reveal the old seed and
 * start a fresh shoe, all inside the bet transaction. */
export interface ShoeRollover {
  oldShoeId: string | null;
  revealedSeed: string | null;
  newSeed: string;
  newSeedHash: string;
  newCardsJson: string;
}

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
CREATE TABLE IF NOT EXISTS blackjack_shoe (
  id TEXT PRIMARY KEY,
  seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  seed_revealed TEXT,
  cards_json TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blackjack_chips (
  wallet TEXT PRIMARY KEY,
  chips INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blackjack_hands (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  bet INTEGER NOT NULL,
  player_json TEXT NOT NULL,
  dealer_json TEXT NOT NULL,
  status TEXT NOT NULL,
  payout INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS blackjack_buyins (
  tx_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blackjack_cashouts (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount INTEGER NOT NULL,
  tx_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_bj_hands_wallet ON blackjack_hands(wallet, created_at);
CREATE INDEX IF NOT EXISTS idx_bj_hands_status ON blackjack_hands(status, resolved_at);
CREATE TABLE IF NOT EXISTS oracle_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payer TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  symbol TEXT,
  price_usd TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oracle_created ON oracle_queries(created_at);
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

  // ---- oracle query log (the spectacle feed) ----

  logOracleQuery(q: {
    payer: string;
    endpoint: string;
    symbol?: string;
    priceUsd?: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO oracle_queries (payer, endpoint, symbol, price_usd, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(q.payer, q.endpoint, q.symbol ?? null, q.priceUsd ?? null, q.createdAt);
  }

  /** Recent oracle queries, newest first. */
  recentOracleQueries(limit: number): {
    payer: string;
    endpoint: string;
    symbol: string | null;
    priceUsd: string | null;
    createdAt: number;
  }[] {
    const rows = this.db
      .prepare(
        'SELECT payer, endpoint, symbol, price_usd, created_at FROM oracle_queries ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      payer: r.payer as string,
      endpoint: r.endpoint as string,
      symbol: r.symbol as string | null,
      priceUsd: r.price_usd as string | null,
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

  // ---- the count: blackjack ----

  /** The latest shoe is the active one; older rows are the audit trail. */
  getActiveShoe(): BlackjackShoeRow | null {
    const row = this.db
      .prepare('SELECT * FROM blackjack_shoe ORDER BY rowid DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      seed: row.seed as string,
      seedHash: row.seed_hash as string,
      seedRevealed: row.seed_revealed as string | null,
      cards: JSON.parse(row.cards_json as string) as Card[],
      pos: row.pos as number,
      createdAt: row.created_at as number,
    };
  }

  /** Most recently revealed shoe seed (null before the first reshuffle). */
  lastRevealedSeed(): string | null {
    const row = this.db
      .prepare(
        'SELECT seed_revealed FROM blackjack_shoe WHERE seed_revealed IS NOT NULL ORDER BY rowid DESC LIMIT 1',
      )
      .get() as { seed_revealed: string } | undefined;
    return row ? row.seed_revealed : null;
  }

  /** Insert a fresh shoe (used by placeBet's rollover path). */
  insertShoe(o: {
    id: string;
    seed: string;
    seedHash: string;
    cardsJson: string;
    now: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO blackjack_shoe (id, seed, seed_hash, seed_revealed, cards_json, pos, created_at) VALUES (?, ?, ?, NULL, ?, 0, ?)',
      )
      .run(o.id, o.seed, o.seedHash, o.cardsJson, o.now);
  }

  /** Publish the seed of a retired shoe (provable fairness). */
  revealShoeSeed(id: string, seed: string): void {
    this.db
      .prepare('UPDATE blackjack_shoe SET seed_revealed = ? WHERE id = ?')
      .run(seed, id);
  }

  getChips(wallet: Address): bigint {
    const row = this.db
      .prepare('SELECT chips FROM blackjack_chips WHERE wallet = ?')
      .get(getAddress(wallet)) as { chips: number } | undefined;
    return row ? BigInt(row.chips) : 0n;
  }

  /** Signed delta applied via upsert (creates the row at 0 when missing). */
  private addChipsDelta(wallet: Address, delta: bigint, now: number): void {
    this.db
      .prepare(
        `INSERT INTO blackjack_chips (wallet, chips, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(wallet) DO UPDATE SET
           chips = blackjack_chips.chips + excluded.chips,
           updated_at = excluded.updated_at`,
      )
      .run(getAddress(wallet), Number(delta), now);
  }

  /**
   * Buy-in: burn the tx hash (single-use) and credit chips, atomically.
   * Returns 'replay' when the hash was already used.
   */
  creditBuyin(
    txHash: string,
    wallet: Address,
    amount: bigint,
    now: number,
  ): 'ok' | 'replay' {
    return this.txn(() => {
      try {
        this.db
          .prepare(
            'INSERT INTO blackjack_buyins (tx_hash, wallet, amount, used_at) VALUES (?, ?, ?, ?)',
          )
          .run(txHash.toLowerCase(), getAddress(wallet), Number(amount), now);
      } catch (e) {
        if (
          e instanceof Error &&
          /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)
        ) {
          return 'replay';
        }
        throw e;
      }
      this.addChipsDelta(wallet, amount, now);
      return 'ok';
    });
  }

  getHand(id: string): BlackjackHandRow | null {
    const row = this.db
      .prepare('SELECT * FROM blackjack_hands WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToHand(row) : null;
  }

  activeHand(wallet: Address): BlackjackHandRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM blackjack_hands WHERE wallet = ? AND status = 'active' LIMIT 1",
      )
      .get(getAddress(wallet)) as Record<string, unknown> | undefined;
    return row ? rowToHand(row) : null;
  }

  /** Active hands for the public table view (hole cards hidden by caller). */
  activeHands(): BlackjackHandRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM blackjack_hands WHERE status = 'active' ORDER BY created_at DESC",
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToHand);
  }

  /** Recently resolved hands for the table's results feed. */
  recentResolvedHands(limit: number): BlackjackHandRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM blackjack_hands WHERE status != 'active' ORDER BY resolved_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToHand);
  }

  /**
   * Place a bet: one active hand per wallet, chips debited, shoe advanced
   * (or rolled over), hand inserted — all in one transaction. When the deal
   * resolves immediately (naturals), the payout is credited in the same
   * transaction.
   */
  placeBet(o: {
    wallet: Address;
    bet: bigint;
    handId: string;
    playerJson: string;
    dealerJson: string;
    status: HandStatus;
    payout: bigint | null;
    resolvedAt: number | null;
    now: number;
    shoeId: string;
    newPos: number;
    rollover: ShoeRollover | null;
  }): 'ok' | 'insufficient_chips' | 'active_hand' {
    return this.txn(() => {
      const existing = this.db
        .prepare(
          "SELECT 1 FROM blackjack_hands WHERE wallet = ? AND status = 'active'",
        )
        .get(getAddress(o.wallet)) as unknown;
      if (existing !== undefined) return 'active_hand';
      if (this.getChips(o.wallet) < o.bet) return 'insufficient_chips';
      if (o.rollover) {
        if (o.rollover.oldShoeId && o.rollover.revealedSeed) {
          this.revealShoeSeed(o.rollover.oldShoeId, o.rollover.revealedSeed);
        }
        this.db
          .prepare(
            'INSERT INTO blackjack_shoe (id, seed, seed_hash, seed_revealed, cards_json, pos, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)',
          )
          .run(
            o.shoeId,
            o.rollover.newSeed,
            o.rollover.newSeedHash,
            o.rollover.newCardsJson,
            o.newPos,
            o.now,
          );
      } else {
        this.db
          .prepare('UPDATE blackjack_shoe SET pos = ? WHERE id = ?')
          .run(o.newPos, o.shoeId);
      }
      this.addChipsDelta(o.wallet, -o.bet, o.now);
      this.db
        .prepare(
          'INSERT INTO blackjack_hands (id, wallet, bet, player_json, dealer_json, status, payout, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          o.handId,
          getAddress(o.wallet),
          Number(o.bet),
          o.playerJson,
          o.dealerJson,
          o.status,
          o.payout === null ? null : Number(o.payout),
          o.now,
          o.resolvedAt,
        );
      if (o.payout !== null && o.payout > 0n) {
        this.addChipsDelta(o.wallet, o.payout, o.now);
      }
      return 'ok';
    });
  }

  /**
   * Hit/stand progress: update cards + status, advance the shoe, credit any
   * payout. The active check runs inside the transaction so a concurrent
   * hit+stand can't double-resolve.
   */
  progressHand(o: {
    handId: string;
    playerJson: string;
    dealerJson: string;
    status: HandStatus;
    payout: bigint | null;
    resolvedAt: number | null;
    shoeId: string;
    newPos: number;
    now: number;
  }): 'ok' | 'not_active' {
    return this.txn(() => {
      const row = this.db
        .prepare('SELECT wallet, status FROM blackjack_hands WHERE id = ?')
        .get(o.handId) as { wallet: string; status: string } | undefined;
      if (!row || row.status !== 'active') return 'not_active';
      this.db
        .prepare(
          'UPDATE blackjack_hands SET player_json = ?, dealer_json = ?, status = ?, payout = ?, resolved_at = ? WHERE id = ?',
        )
        .run(
          o.playerJson,
          o.dealerJson,
          o.status,
          o.payout === null ? null : Number(o.payout),
          o.resolvedAt,
          o.handId,
        );
      this.db
        .prepare('UPDATE blackjack_shoe SET pos = ? WHERE id = ?')
        .run(o.newPos, o.shoeId);
      if (o.payout !== null && o.payout > 0n) {
        this.addChipsDelta(getAddress(row.wallet), o.payout, o.now);
      }
      return 'ok';
    });
  }

  /**
   * Double down: debit one more bet, draw exactly one card, then stand.
   * The hand always resolves (bust or dealer plays out).
   */
  doubleDown(o: {
    handId: string;
    addedBet: bigint;
    playerJson: string;
    dealerJson: string;
    status: HandStatus;
    payout: bigint | null;
    resolvedAt: number | null;
    shoeId: string;
    newPos: number;
    now: number;
  }): 'ok' | 'insufficient_chips' | 'not_active' {
    return this.txn(() => {
      const row = this.db
        .prepare('SELECT wallet, bet, status FROM blackjack_hands WHERE id = ?')
        .get(o.handId) as
        | { wallet: string; bet: number; status: string }
        | undefined;
      if (!row || row.status !== 'active') return 'not_active';
      const wallet = getAddress(row.wallet);
      if (this.getChips(wallet) < o.addedBet) return 'insufficient_chips';
      this.addChipsDelta(wallet, -o.addedBet, o.now);
      this.db
        .prepare(
          'UPDATE blackjack_hands SET bet = bet + ?, player_json = ?, dealer_json = ?, status = ?, payout = ?, resolved_at = ? WHERE id = ?',
        )
        .run(
          Number(o.addedBet),
          o.playerJson,
          o.dealerJson,
          o.status,
          o.payout === null ? null : Number(o.payout),
          o.resolvedAt,
          o.handId,
        );
      this.db
        .prepare('UPDATE blackjack_shoe SET pos = ? WHERE id = ?')
        .run(o.newPos, o.shoeId);
      if (o.payout !== null && o.payout > 0n) {
        this.addChipsDelta(wallet, o.payout, o.now);
      }
      return 'ok';
    });
  }

  /**
   * Cash-out step 1: debit chips and record the cash-out (tx_hash filled in
   * on broadcast success). The broadcast happens after this returns.
   */
  debitForCashout(o: {
    id: string;
    wallet: Address;
    amount: bigint;
    now: number;
  }): 'ok' | 'insufficient_chips' {
    return this.txn(() => {
      if (this.getChips(o.wallet) < o.amount) return 'insufficient_chips';
      this.db
        .prepare(
          'INSERT INTO blackjack_cashouts (id, wallet, amount, tx_hash, created_at) VALUES (?, ?, ?, NULL, ?)',
        )
        .run(o.id, getAddress(o.wallet), Number(o.amount), o.now);
      this.addChipsDelta(o.wallet, -o.amount, o.now);
      return 'ok';
    });
  }

  /** Cash-out step 2a: broadcast succeeded — record the tx hash. */
  confirmCashout(id: string, txHash: string): void {
    this.db
      .prepare('UPDATE blackjack_cashouts SET tx_hash = ? WHERE id = ?')
      .run(txHash.toLowerCase(), id);
  }

  /** Cash-out step 2b: broadcast failed — re-credit the chips. */
  recreditCashout(id: string, wallet: Address, amount: bigint, now: number): void {
    this.txn(() => {
      this.db.prepare('DELETE FROM blackjack_cashouts WHERE id = ?').run(id);
      this.addChipsDelta(wallet, amount, now);
    });
  }

  /** Top chip holders with all-time net: buy-ins − cash-outs + hand P&L. */
  leaderboard(limit: number): { wallet: Address; chips: bigint; net: bigint }[] {
    const rows = this.db
      .prepare(
        `SELECT c.wallet AS wallet, c.chips AS chips,
           COALESCE((SELECT SUM(b.amount) FROM blackjack_buyins b WHERE b.wallet = c.wallet), 0) AS buyins,
           COALESCE((SELECT SUM(o.amount) FROM blackjack_cashouts o WHERE o.wallet = c.wallet), 0) AS cashouts,
           COALESCE((SELECT SUM(h.payout - h.bet) FROM blackjack_hands h WHERE h.wallet = c.wallet AND h.status != 'active'), 0) AS pnl
         FROM blackjack_chips c
         ORDER BY c.chips DESC
         LIMIT ?`,
      )
      .all(limit) as {
      wallet: string;
      chips: number;
      buyins: number;
      cashouts: number;
      pnl: number;
    }[];
    return rows.map((r) => ({
      wallet: getAddress(r.wallet),
      chips: BigInt(r.chips),
      net: BigInt(r.buyins) - BigInt(r.cashouts) + BigInt(r.pnl),
    }));
  }
}

function rowToHand(row: Record<string, unknown>): BlackjackHandRow {
  return {
    id: row.id as string,
    wallet: row.wallet as Address,
    bet: BigInt(row.bet as number),
    playerJson: row.player_json as string,
    dealerJson: row.dealer_json as string,
    status: row.status as HandStatus,
    payout: row.payout === null ? null : BigInt(row.payout as number),
    createdAt: row.created_at as number,
    resolvedAt: row.resolved_at as number | null,
  };
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
