/**
 * 402 Lounge — Hono routes. Mounted on the facilitator app at /lounge
 * (see src/facilitator/server.ts). The static site talks to these.
 *
 *   GET  /posts?sort=hot|new|top&limit=25&cursor= -> { posts, nextCursor }
 *   POST /posts                                  -> { id } (payment-gated)
 *   GET  /posts/:id                              -> { post, comments }
 *   POST /posts/:id/comments                     -> { id } (signed, free)
 *   POST /posts/:id/vote                         -> { score } (signed, free)
 *   GET  /health                                 -> { ok: true }
 *
 * All writes are EIP-712 signed (domain "402 Lounge"/"1"/57073) with
 * timestamps inside ±5 minutes. Bodies are capped at 32 KiB. User content
 * is escaped on the way out (stored raw).
 */
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type Address, getAddress, isAddress } from 'viem';
import type { LoungeConfig } from './config.js';
import { LoungeDb, type PostRow } from './db.js';
import { escapeHtml } from './escape.js';
import { defaultGetReceipt, verifyPostPayment } from './payments.js';
import {
  AuthorRateLimiter,
  COMMENT_BUCKET,
  POST_BUCKET,
  VOTE_BUCKET,
} from './ratelimit.js';
import { timestampFresh, verifyLoungeSignature } from './signing.js';
import type { Comment, GetReceipt, Post, VoteDirection } from './types.js';

/** Lounge JSON bodies are small signed payloads; anything bigger is abuse. */
export const LOUNGE_MAX_BODY_BYTES = 32 * 1024;

export const TITLE_MAX = 140;
export const POST_BODY_MAX = 2000;
export const COMMENT_BODY_MAX = 1000;

export interface LoungeDeps {
  getReceipt?: GetReceipt;
}

type Sort = 'hot' | 'new' | 'top';

function newId(): string {
  return randomBytes(16).toString('hex');
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const n = parseInt(
      Buffer.from(cursor, 'base64url').toString('utf8'),
      10,
    );
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Reddit-style gravity: score decays with age. */
export function hotScore(post: Post, nowSeconds: number): number {
  const ageHours = Math.max(0, (nowSeconds - post.createdAt) / 3600);
  return post.score / Math.pow(ageHours + 2, 1.5);
}

/** Sort posts for the feed. Exported for deterministic unit tests. */
export function sortPosts(posts: Post[], sort: Sort, nowSeconds: number): Post[] {
  const seq = (p: Post): number => (p as PostRow).seq ?? 0;
  return [...posts].sort((a, b) => {
    if (sort === 'new')
      return b.createdAt - a.createdAt || seq(b) - seq(a);
    if (sort === 'top')
      return b.score - a.score || b.createdAt - a.createdAt || seq(b) - seq(a);
    return hotScore(b, nowSeconds) - hotScore(a, nowSeconds);
  });
}

function publicPost(p: Post): Post {
  // seq is an internal ordering aid — never leak it to clients.
  const { seq: _seq, ...rest } = p as Post & { seq?: number };
  return {
    ...rest,
    title: escapeHtml(p.title),
    body: escapeHtml(p.body),
  };
}

function publicComment(c: Comment): Comment {
  return { ...c, body: escapeHtml(c.body) };
}

function parseTimestamp(v: unknown): bigint | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

export function createLoungeApp(
  config: LoungeConfig,
  deps: LoungeDeps = {},
): Hono {
  const app = new Hono();
  const db = new LoungeDb(config.dbPath);
  const getReceipt = deps.getReceipt ?? defaultGetReceipt(config.rpcUrl);
  const limiter = new AuthorRateLimiter();

  async function readBody(
    c: Context,
  ): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413; error: string }> {
    let text: string;
    try {
      text = await c.req.text();
    } catch {
      return { ok: false, status: 400, error: 'unreadable_body' };
    }
    if (text.length > LOUNGE_MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: 'body_too_large' };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: 400, error: 'invalid_json' };
    }
  }

  const bad = (
    c: Context,
    status: ContentfulStatusCode,
    error: string,
    detail?: string,
  ) => c.json(detail ? { error, detail } : { error }, status);

  // ---- reads ----

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/posts', (c) => {
    const sortRaw = c.req.query('sort') ?? 'hot';
    const sort: Sort =
      sortRaw === 'new' || sortRaw === 'top' || sortRaw === 'hot'
        ? sortRaw
        : 'hot';
    const limitRaw = parseInt(c.req.query('limit') ?? '25', 10);
    const limit =
      Number.isSafeInteger(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 100)
        : 25;
    const offset = decodeCursor(c.req.query('cursor'));

    const now = Math.floor(Date.now() / 1000);
    const posts = db.allPosts();
    const sorted = sortPosts(posts, sort, now);
    const page = sorted.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < sorted.length ? encodeCursor(offset + limit) : null;
    return c.json({ posts: page.map(publicPost), nextCursor });
  });

  app.get('/posts/:id', (c) => {
    const post = db.getPost(c.req.param('id'));
    if (!post) return bad(c, 404, 'post_not_found');
    return c.json({
      post: publicPost(post),
      comments: db.commentsForPost(post.id).map(publicComment),
    });
  });

  // ---- writes ----

  app.post('/posts', async (c) => {
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { author, title, body, timestamp, signature, paymentTxHash } = b;

    if (typeof author !== 'string' || !isAddress(author)) {
      return bad(c, 400, 'invalid_author');
    }
    if (typeof title !== 'string' || title.length === 0 || title.length > TITLE_MAX) {
      return bad(c, 400, 'invalid_title', `title must be 1-${TITLE_MAX} chars`);
    }
    if (typeof body !== 'string' || body.length === 0 || body.length > POST_BODY_MAX) {
      return bad(c, 400, 'invalid_body', `body must be 1-${POST_BODY_MAX} chars`);
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'LoungePost',
      message: { author, title, body, timestamp: ts },
      signature,
      author,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    // Payment-gated: require a real USDC transfer to the treasury.
    if (typeof paymentTxHash !== 'string') {
      return bad(c, 400, 'missing_payment');
    }
    const paid = await verifyPostPayment({
      getReceipt,
      txHash: paymentTxHash,
      author: getAddress(author),
      treasury: config.treasury,
      feeUnits: config.postFeeUnits,
    });
    if (!paid.ok) {
      const status = paid.reason === 'malformed_tx_hash' ? 400 : 402;
      return bad(c, status, 'payment_invalid', paid.reason);
    }

    // Reject a reused payment before it can burn the author's rate quota.
    if (db.isPaymentUsed(paymentTxHash)) {
      return bad(c, 409, 'payment_reused');
    }

    // Rate limit AFTER the request is otherwise valid, so failed attempts
    // don't burn the author's quota. Counted only on success path below.
    const authorAddr = getAddress(author);
    if (!limiter.take(`post:${authorAddr.toLowerCase()}`, POST_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'one post per 60s');
    }

    // Atomic (no awaits inside): re-check reuse, insert post, burn hash.
    const now = Math.floor(Date.now() / 1000);
    const id = newId();
    if (db.isPaymentUsed(paymentTxHash)) {
      return bad(c, 409, 'payment_reused');
    }
    db.insertPost({ id, author: authorAddr, title, body, createdAt: now });
    db.markPaymentUsed(paymentTxHash, id, now);
    return c.json({ id }, 201);
  });

  app.post('/posts/:id/comments', async (c) => {
    const postId = c.req.param('id');
    const post = db.getPost(postId);
    if (!post) return bad(c, 404, 'post_not_found');

    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { author, body, timestamp, parentId, signature } = b;

    if (typeof author !== 'string' || !isAddress(author)) {
      return bad(c, 400, 'invalid_author');
    }
    if (
      typeof body !== 'string' ||
      body.length === 0 ||
      body.length > COMMENT_BODY_MAX
    ) {
      return bad(c, 400, 'invalid_body', `body must be 1-${COMMENT_BODY_MAX} chars`);
    }
    const parent = typeof parentId === 'string' ? parentId : '';
    if (parent !== '') {
      const parentComment = db.getComment(parent);
      if (!parentComment || parentComment.postId !== postId) {
        return bad(c, 400, 'invalid_parent');
      }
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'LoungeComment',
      message: { author, postId, body, timestamp: ts, parentId: parent },
      signature,
      author,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    const authorAddr = getAddress(author);
    if (!limiter.take(`comment:${authorAddr.toLowerCase()}`, COMMENT_BUCKET)) {
      return bad(c, 429, 'rate_limited', '5 comments per 60s');
    }
    const id = newId();
    db.insertComment({
      id,
      postId,
      author: authorAddr,
      body,
      parentId: parent,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return c.json({ id }, 201);
  });

  app.post('/posts/:id/vote', async (c) => {
    const postId = c.req.param('id');
    const post = db.getPost(postId);
    if (!post) return bad(c, 404, 'post_not_found');

    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { author, direction, timestamp, signature } = b;

    if (typeof author !== 'string' || !isAddress(author)) {
      return bad(c, 400, 'invalid_author');
    }
    if (direction !== 1 && direction !== -1) {
      return bad(c, 400, 'invalid_direction', 'direction must be 1 or -1');
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'LoungeVote',
      message: { author, postId, direction, timestamp: ts },
      signature,
      author,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    const authorAddr = getAddress(author);
    if (!limiter.take(`vote:${authorAddr.toLowerCase()}`, VOTE_BUCKET)) {
      return bad(c, 429, 'rate_limited', '20 votes per 60s');
    }
    const { upvotes, downvotes } = db.upsertVote(
      postId,
      authorAddr,
      direction as VoteDirection,
      Math.floor(Date.now() / 1000),
    );
    return c.json({ score: upvotes - downvotes });
  });

  return app;
}
