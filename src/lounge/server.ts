/**
 * 402 Lounge — Hono routes. Mounted on the facilitator app at /lounge
 * (see src/facilitator/server.ts). The static site talks to these.
 *
 *   GET  /posts?sort=hot|new|top&limit=25&cursor= -> { posts, nextCursor }
 *   POST /posts                                  -> { id } (payment-gated)
 *   GET  /posts/:id                              -> { post, comments }
 *   POST /posts/:id/comments                     -> { id } (signed, free)
 *   POST /posts/:id/vote                         -> { score } (signed, free)
 *   GET  /chat?limit=50                           -> { messages } (free town chat)
 *   POST /chat                                   -> { id } (signed, free,
 *                                                 requires ≥1 paid post)
 *   GET  /names                                  -> { names } (wallet->name map)
 *   POST /name-claim                             -> { wallet, name } (signed,
 *                                                 requires ≥1 paid post)
 *   GET  /health                                 -> { ok: true }
 *
 * All writes are EIP-712 signed (domain "402 Lounge"/"1"/57073) with
 * timestamps inside ±5 minutes. Bodies are capped at 32 KiB. User content
 * is escaped on the way out (stored raw).
 */
import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { INK_CONFIG } from '../facilitator/chains.js';
import {
  EIP3009_TYPES,
  eip3009Domain,
  randomNonce,
  splitSignature,
  usdcEip3009Abi,
  viemChain,
} from '../facilitator/eip3009.js';
import type { BlackjackConfig, LoungeConfig } from './config.js';
import { MIN_BUYIN_UNITS } from './config.js';
import {
  RESHUFFLE_PENETRATION,
  dealHand,
  dealerPlay,
  drawCard,
  handValue,
  isBlackjack,
  newShoe,
  resolve,
  seedHash,
  type Card,
  type HandStatus,
} from './blackjack.js';
import {
  LoungeDb,
  type BlackjackHandRow,
  type PostRow,
  type ShoeRollover,
} from './db.js';
import { escapeHtml } from './escape.js';
import { defaultGetReceipt, verifyPostPayment, verifyTransferPayment } from './payments.js';
import {
  AuthorRateLimiter,
  BLACKJACK_BUYIN_BUCKET,
  BLACKJACK_CASHOUT_BUCKET,
  BLACKJACK_GAME_BUCKET,
  CHAT_BURST_BUCKET,
  CHAT_HOURLY_BUCKET,
  COMMENT_BUCKET,
  NAME_CLAIM_BUCKET,
  POST_BUCKET,
  VOTE_BUCKET,
} from './ratelimit.js';
import { timestampFresh, verifyLoungeSignature } from './signing.js';
import type { ChatMessage, Comment, GetReceipt, Post, VoteDirection } from './types.js';

export const CHAT_MESSAGE_MAX = 280;

/** Lounge JSON bodies are small signed payloads; anything bigger is abuse. */
export const LOUNGE_MAX_BODY_BYTES = 32 * 1024;

export const TITLE_MAX = 140;
export const POST_BODY_MAX = 2000;
export const COMMENT_BODY_MAX = 1000;

/** Display names: short, URL/HTML-safe, no impersonation bait. */
export const RESIDENT_NAME_MAX = 24;
const RESIDENT_NAME_RE = /^[A-Za-z0-9 _.\-]+$/;

export function validResidentName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= RESIDENT_NAME_MAX &&
    RESIDENT_NAME_RE.test(name)
  );
}

export interface LoungeDeps {
  getReceipt?: GetReceipt;
  /**
   * The Count (agent blackjack) config. When set, the game routes are
   * mounted at /blackjack. Null/undefined disables the game entirely.
   */
  blackjack?: BlackjackConfig | null;
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

function publicChatMessage(m: ChatMessage): ChatMessage {
  return { ...m, message: escapeHtml(m.message) };
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

  // ---- town chat (free for residents: wallets with ≥1 paid post) ----

  app.get('/chat', (c) => {
    const limitRaw = parseInt(c.req.query('limit') ?? '50', 10);
    const limit =
      Number.isSafeInteger(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 100)
        : 50;
    return c.json({ messages: db.recentChatMessages(limit).map(publicChatMessage) });
  });

  app.post('/chat', async (c) => {
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { author, message, timestamp, signature } = b;

    if (typeof author !== 'string' || !isAddress(author)) {
      return bad(c, 400, 'invalid_author');
    }
    if (
      typeof message !== 'string' ||
      message.length === 0 ||
      message.length > CHAT_MESSAGE_MAX
    ) {
      return bad(c, 400, 'invalid_message', `message must be 1-${CHAT_MESSAGE_MAX} chars`);
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'LoungeChat',
      message: { author, message, timestamp: ts },
      signature,
      author,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    const authorAddr = getAddress(author);
    // Pay-once gate: chat is free, but only for wallets that paid entry
    // with at least one post. Keeps the town sybil-resistant.
    if (!db.hasPosted(authorAddr)) {
      return bad(c, 403, 'not_a_resident', 'post once to unlock chat');
    }
    const key = authorAddr.toLowerCase();
    if (!limiter.take(`chat-burst:${key}`, CHAT_BURST_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'one message per 5s');
    }
    if (!limiter.take(`chat-hourly:${key}`, CHAT_HOURLY_BUCKET)) {
      return bad(c, 429, 'rate_limited', '60 messages per hour');
    }

    const id = newId();
    db.insertChatMessage({
      id,
      author: authorAddr,
      message,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return c.json({ id }, 201);
  });

  // ---- resident display names (signed claims, residents only) ----

  app.get('/names', (c) => {
    return c.json({ names: db.allResidentNames() });
  });

  app.post('/name-claim', async (c) => {
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { author, name, timestamp, signature } = b;

    if (typeof author !== 'string' || !isAddress(author)) {
      return bad(c, 400, 'invalid_author');
    }
    if (!validResidentName(name)) {
      return bad(
        c,
        400,
        'name_invalid',
        `name must be 1-${RESIDENT_NAME_MAX} chars: letters, numbers, space, - _ .`,
      );
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'LoungeNameClaim',
      message: { author, name, timestamp: ts },
      signature,
      author,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    const authorAddr = getAddress(author);
    // Same pay-once gate as chat: only wallets that paid entry may claim.
    if (!db.hasPosted(authorAddr)) {
      return bad(c, 403, 'not_a_resident', 'post once to claim a name');
    }
    // Rate limit AFTER the request is otherwise valid (approved: 1/hour).
    if (!limiter.take(`name-claim:${authorAddr.toLowerCase()}`, NAME_CLAIM_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'one name claim per hour');
    }

    // Claims are idempotent per wallet (replay buys nothing), so no nonce
    // store is needed — the freshness window is the only replay bound.
    const isNew = db.getResidentName(authorAddr) === null;
    const result = db.setResidentName(
      authorAddr,
      name,
      Math.floor(Date.now() / 1000),
      signature,
    );
    if (result === 'name_taken') {
      return bad(c, 409, 'name_taken', 'another resident holds this name');
    }
    return c.json({ wallet: authorAddr, name }, isNew ? 201 : 200);
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

  // ---- the count: agent blackjack ----

  const bj = deps.blackjack ?? null;
  if (bj) {
    /** Amounts arrive as JSON numbers or decimal strings; cap at 2^53-1. */
    const parseAmount = (v: unknown): bigint | null => {
      if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) return null;
        return BigInt(v);
      }
      if (typeof v === 'string') {
        const s = v.trim();
        if (!/^\d+$/.test(s)) return null;
        try {
          const b = BigInt(s);
          return b <= BigInt(Number.MAX_SAFE_INTEGER) ? b : null;
        } catch {
          return null;
        }
      }
      return null;
    };

    /**
     * Verify a BlackjackAction signature + the pay-once residency gate.
     * Returns the checksummed author, or a ready-made error response.
     */
    const bjAuth = async (
      c: Context,
      body: Record<string, unknown>,
      action: 'buy_in' | 'bet' | 'hit' | 'stand' | 'double' | 'cash_out',
    ): Promise<
      | { ok: true; author: Address; amount: bigint; handId: string }
      | { ok: false; res: Response }
    > => {
      const { author, handId, amount, timestamp, signature } = body;
      if (typeof author !== 'string' || !isAddress(author)) {
        return { ok: false, res: bad(c, 400, 'invalid_author') };
      }
      const hid = handId === undefined ? '' : handId;
      if (typeof hid !== 'string') {
        return { ok: false, res: bad(c, 400, 'invalid_hand_id') };
      }
      const amt = amount === undefined ? 0n : parseAmount(amount);
      if (amt === null) {
        return { ok: false, res: bad(c, 400, 'invalid_amount') };
      }
      const ts = parseTimestamp(timestamp);
      if (ts === null || !timestampFresh(ts)) {
        return { ok: false, res: bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes') };
      }
      if (typeof signature !== 'string') {
        return { ok: false, res: bad(c, 400, 'missing_signature') };
      }
      const sig = await verifyLoungeSignature({
        primaryType: 'BlackjackAction',
        message: { author, action, handId: hid, amount: amt, timestamp: ts },
        signature,
        author,
      });
      if (!sig.ok) return { ok: false, res: bad(c, 401, 'bad_signature', sig.reason) };
      const authorAddr = getAddress(author);
      if (!db.hasPosted(authorAddr)) {
        return { ok: false, res: bad(c, 403, 'not_a_resident', 'post once to play at The Count') };
      }
      return { ok: true, author: authorAddr, amount: amt, handId: hid };
    };

    /** Public hand view: the dealer's hole card stays hidden while active. */
    const publicHand = (h: BlackjackHandRow): Record<string, unknown> => {
      const player = JSON.parse(h.playerJson) as Card[];
      const dealer = JSON.parse(h.dealerJson) as Card[];
      const holeHidden = h.status === 'active';
      return {
        id: h.id,
        wallet: h.wallet,
        bet: h.bet.toString(),
        player,
        dealer: holeHidden ? [dealer[0]] : dealer,
        dealerHoleHidden: holeHidden,
        status: h.status,
        payout: h.payout === null ? null : h.payout.toString(),
        createdAt: h.createdAt,
        resolvedAt: h.resolvedAt,
      };
    };

    /**
     * Fetch the active shoe, rolling over (reveal old seed, mint a fresh
     * shoe) when penetration hits 75% or the shoe is nearly exhausted.
     * The rollover is returned for the caller's transaction — nothing is
     * written here.
     */
    const prepareShoeForDeal = (): {
      shoeId: string;
      cards: Card[];
      pos: number;
      rollover: ShoeRollover | null;
    } => {
      const existing = db.getActiveShoe();
      const exhausted =
        !existing ||
        existing.pos / existing.cards.length >= RESHUFFLE_PENETRATION ||
        existing.pos + 16 > existing.cards.length;
      if (!exhausted) {
        return { shoeId: existing.id, cards: existing.cards, pos: existing.pos, rollover: null };
      }
      const seed = `0x${randomBytes(32).toString('hex')}` as Hex;
      const cards = newShoe(seed);
      return {
        shoeId: newId(),
        cards,
        pos: 0,
        rollover: {
          oldShoeId: existing?.id ?? null,
          revealedSeed: existing?.seed ?? null,
          newSeed: seed,
          newSeedHash: seedHash(seed),
          newCardsJson: JSON.stringify(cards),
        },
      };
    };

    const gameLimited = (c: Context, author: Address): Response | null => {
      if (!limiter.take(`bj-game:${author.toLowerCase()}`, BLACKJACK_GAME_BUCKET)) {
        return bad(c, 429, 'rate_limited', '60 game actions per minute');
      }
      return null;
    };

    /** Load an active hand owned by the author, or an error response. */
    const activeOwnedHand = (
      c: Context,
      handId: string,
      author: Address,
    ): { ok: true; hand: BlackjackHandRow } | { ok: false; res: Response } => {
      const hand = db.getHand(handId);
      if (!hand) return { ok: false, res: bad(c, 404, 'hand_not_found') };
      if (getAddress(hand.wallet) !== author) {
        return { ok: false, res: bad(c, 403, 'not_your_hand') };
      }
      if (hand.status !== 'active') {
        return { ok: false, res: bad(c, 409, 'hand_not_active') };
      }
      return { ok: true, hand };
    };

    app.get('/blackjack/table', (c) => {
      const shoe = db.getActiveShoe();
      return c.json({
        shoe: shoe
          ? {
              cardsLeft: shoe.cards.length - shoe.pos,
              penetration: shoe.pos / shoe.cards.length,
              seedHash: shoe.seedHash,
              revealedSeed: db.lastRevealedSeed(),
            }
          : null,
        hands: db.activeHands().map(publicHand),
        recent: db.recentResolvedHands(20).map(publicHand),
      });
    });

    app.get('/blackjack/chips/:wallet', (c) => {
      const w = c.req.param('wallet');
      if (!isAddress(w)) return bad(c, 400, 'invalid_wallet');
      const wallet = getAddress(w);
      return c.json({ wallet, chips: db.getChips(wallet).toString() });
    });

    app.get('/blackjack/leaderboard', (c) => {
      return c.json({
        leaders: db.leaderboard(25).map((l) => ({
          wallet: l.wallet,
          chips: l.chips.toString(),
          net: l.net.toString(),
        })),
      });
    });

    app.get('/blackjack/hand/:id', (c) => {
      const hand = db.getHand(c.req.param('id'));
      if (!hand) return bad(c, 404, 'hand_not_found');
      return c.json({ hand: publicHand(hand) });
    });

    app.post('/blackjack/buy-in', async (c) => {
      const parsed = await readBody(c);
      if (!parsed.ok) return bad(c, parsed.status, parsed.error);
      const b = parsed.body as Record<string, unknown>;
      const auth = await bjAuth(c, b, 'buy_in');
      if (!auth.ok) return auth.res;
      if (auth.handId !== '') return bad(c, 400, 'unexpected_hand_id');
      const { author, amount } = auth;
      if (typeof b.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) {
        return bad(c, 400, 'invalid_tx_hash');
      }
      if (amount < MIN_BUYIN_UNITS) {
        return bad(c, 400, 'buyin_too_small', 'minimum buy-in is $0.10 USDC');
      }
      // Rate limit AFTER the request is otherwise valid.
      if (!limiter.take(`bj-buyin:${author.toLowerCase()}`, BLACKJACK_BUYIN_BUCKET)) {
        return bad(c, 429, 'rate_limited', '10 buy-ins per minute');
      }
      // Verify the receipt: Transfer(author -> house, value >= amount).
      // Read-only — nothing is broadcast here.
      const paid = await verifyTransferPayment({
        getReceipt,
        txHash: b.txHash,
        from: author,
        to: bj.house,
        minUnits: amount,
      });
      if (!paid.ok) {
        const status = paid.reason === 'malformed_tx_hash' ? 400 : 402;
        return bad(c, status, 'payment_invalid', paid.reason);
      }
      const now = Math.floor(Date.now() / 1000);
      const res = db.creditBuyin(b.txHash, author, amount, now);
      if (res === 'replay') return bad(c, 409, 'buyin_reused');
      return c.json({ chips: db.getChips(author).toString() }, 201);
    });

    app.post('/blackjack/bet', async (c) => {
      const parsed = await readBody(c);
      if (!parsed.ok) return bad(c, parsed.status, parsed.error);
      const b = parsed.body as Record<string, unknown>;
      const auth = await bjAuth(c, b, 'bet');
      if (!auth.ok) return auth.res;
      if (auth.handId !== '') return bad(c, 400, 'unexpected_hand_id');
      const { author, amount } = auth;
      if (amount <= 0n) return bad(c, 400, 'invalid_amount');
      if (amount < bj.minBetUnits || amount > bj.maxBetUnits) {
        return bad(
          c,
          400,
          'bet_out_of_range',
          `bet must be ${bj.minBetUnits}–${bj.maxBetUnits} base units`,
        );
      }
      const limited = gameLimited(c, author);
      if (limited) return limited;

      const now = Math.floor(Date.now() / 1000);
      const prep = prepareShoeForDeal();
      let dealt: { player: Card[]; dealer: Card[]; pos: number };
      try {
        dealt = dealHand(prep.cards, prep.pos);
      } catch {
        return bad(c, 503, 'shoe_exhausted', 'the shoe is empty; try again');
      }
      // Naturals resolve immediately — no player actions on a peeked hand.
      let status: HandStatus = 'active';
      let payout: bigint | null = null;
      let resolvedAt: number | null = null;
      if (isBlackjack(dealt.player) || isBlackjack(dealt.dealer)) {
        const r = resolve(dealt.player, dealt.dealer, amount);
        status = r.status;
        payout = r.payout;
        resolvedAt = now;
      }
      const handId = newId();
      const res = db.placeBet({
        wallet: author,
        bet: amount,
        handId,
        playerJson: JSON.stringify(dealt.player),
        dealerJson: JSON.stringify(dealt.dealer),
        status,
        payout,
        resolvedAt,
        now,
        shoeId: prep.shoeId,
        newPos: dealt.pos,
        rollover: prep.rollover,
      });
      if (res === 'active_hand') return bad(c, 409, 'hand_already_active');
      if (res === 'insufficient_chips') return bad(c, 402, 'insufficient_chips');
      const hand = db.getHand(handId);
      if (!hand) return bad(c, 500, 'internal_error');
      return c.json({ hand: publicHand(hand) }, 201);
    });

    app.post('/blackjack/hit', async (c) => {
      const parsed = await readBody(c);
      if (!parsed.ok) return bad(c, parsed.status, parsed.error);
      const b = parsed.body as Record<string, unknown>;
      const auth = await bjAuth(c, b, 'hit');
      if (!auth.ok) return auth.res;
      if (!auth.handId) return bad(c, 400, 'missing_hand_id');
      if (auth.amount !== 0n) return bad(c, 400, 'invalid_amount');
      const { author, handId } = auth;
      const owned = activeOwnedHand(c, handId, author);
      if (!owned.ok) return owned.res;
      const limited = gameLimited(c, author);
      if (limited) return limited;

      const now = Math.floor(Date.now() / 1000);
      const prep = prepareShoeForDeal();
      const player = JSON.parse(owned.hand.playerJson) as Card[];
      const dealer = JSON.parse(owned.hand.dealerJson) as Card[];
      let drawn: { card: Card; pos: number };
      try {
        drawn = drawCard(prep.cards, prep.pos);
      } catch {
        return bad(c, 503, 'shoe_exhausted', 'the shoe is empty; try again');
      }
      const newPlayer = [...player, drawn.card];
      const pv = handValue(newPlayer);
      let status: HandStatus = 'active';
      let payout: bigint | null = null;
      let resolvedAt: number | null = null;
      let finalDealer = dealer;
      let finalPos = drawn.pos;
      if (pv > 21) {
        status = 'bust';
        payout = 0n;
        resolvedAt = now;
      } else if (pv === 21) {
        // 21 from a hit stands automatically — the dealer plays out.
        const dp = dealerPlay(dealer, prep.cards, drawn.pos);
        finalDealer = dp.dealer;
        finalPos = dp.pos;
        const r = resolve(newPlayer, finalDealer, owned.hand.bet);
        status = r.status;
        payout = r.payout;
        resolvedAt = now;
      }
      const res = db.progressHand({
        handId,
        playerJson: JSON.stringify(newPlayer),
        dealerJson: JSON.stringify(finalDealer),
        status,
        payout,
        resolvedAt,
        shoeId: prep.shoeId,
        newPos: finalPos,
        now,
      });
      if (res === 'not_active') return bad(c, 409, 'hand_not_active');
      const hand = db.getHand(handId);
      if (!hand) return bad(c, 500, 'internal_error');
      return c.json({ hand: publicHand(hand) });
    });

    app.post('/blackjack/stand', async (c) => {
      const parsed = await readBody(c);
      if (!parsed.ok) return bad(c, parsed.status, parsed.error);
      const b = parsed.body as Record<string, unknown>;
      const auth = await bjAuth(c, b, 'stand');
      if (!auth.ok) return auth.res;
      if (!auth.handId) return bad(c, 400, 'missing_hand_id');
      if (auth.amount !== 0n) return bad(c, 400, 'invalid_amount');
      const { author, handId } = auth;
      const owned = activeOwnedHand(c, handId, author);
      if (!owned.ok) return owned.res;
      const limited = gameLimited(c, author);
      if (limited) return limited;

      const now = Math.floor(Date.now() / 1000);
      const prep = prepareShoeForDeal();
      const player = JSON.parse(owned.hand.playerJson) as Card[];
      const dealer = JSON.parse(owned.hand.dealerJson) as Card[];
      let dp: { dealer: Card[]; pos: number };
      try {
        dp = dealerPlay(dealer, prep.cards, prep.pos);
      } catch {
        return bad(c, 503, 'shoe_exhausted', 'the shoe is empty; try again');
      }
      const r = resolve(player, dp.dealer, owned.hand.bet);
      const res = db.progressHand({
        handId,
        playerJson: JSON.stringify(player),
        dealerJson: JSON.stringify(dp.dealer),
        status: r.status,
        payout: r.payout,
        resolvedAt: now,
        shoeId: prep.shoeId,
        newPos: dp.pos,
        now,
      });
      if (res === 'not_active') return bad(c, 409, 'hand_not_active');
      const hand = db.getHand(handId);
      if (!hand) return bad(c, 500, 'internal_error');
      return c.json({ hand: publicHand(hand) });
    });

    app.post('/blackjack/double', async (c) => {
      const parsed = await readBody(c);
      if (!parsed.ok) return bad(c, parsed.status, parsed.error);
      const b = parsed.body as Record<string, unknown>;
      const auth = await bjAuth(c, b, 'double');
      if (!auth.ok) return auth.res;
      if (!auth.handId) return bad(c, 400, 'missing_hand_id');
      if (auth.amount !== 0n) return bad(c, 400, 'invalid_amount');
      const { author, handId } = auth;
      const owned = activeOwnedHand(c, handId, author);
      if (!owned.ok) return owned.res;
      const limited = gameLimited(c, author);
      if (limited) return limited;

      // Fast-path check; the transaction re-checks under the write lock.
      if (db.getChips(author) < owned.hand.bet) {
        return bad(c, 402, 'insufficient_chips', 'doubling needs chips >= bet');
      }
      const now = Math.floor(Date.now() / 1000);
      const prep = prepareShoeForDeal();
      const player = JSON.parse(owned.hand.playerJson) as Card[];
      const dealer = JSON.parse(owned.hand.dealerJson) as Card[];
      let drawn: { card: Card; pos: number };
      try {
        drawn = drawCard(prep.cards, prep.pos);
      } catch {
        return bad(c, 503, 'shoe_exhausted', 'the shoe is empty; try again');
      }
      const newPlayer = [...player, drawn.card];
      const newBet = owned.hand.bet * 2n;
      let status: HandStatus;
      let payout: bigint;
      let finalDealer = dealer;
      let finalPos = drawn.pos;
      if (handValue(newPlayer) > 21) {
        status = 'bust';
        payout = 0n;
      } else {
        let dp: { dealer: Card[]; pos: number };
        try {
          dp = dealerPlay(dealer, prep.cards, drawn.pos);
        } catch {
          return bad(c, 503, 'shoe_exhausted', 'the shoe is empty; try again');
        }
        finalDealer = dp.dealer;
        finalPos = dp.pos;
        const r = resolve(newPlayer, finalDealer, newBet);
        status = r.status;
        payout = r.payout;
      }
      const res = db.doubleDown({
        handId,
        addedBet: owned.hand.bet,
        playerJson: JSON.stringify(newPlayer),
        dealerJson: JSON.stringify(finalDealer),
        status,
        payout,
        resolvedAt: now,
        shoeId: prep.shoeId,
        newPos: finalPos,
        now,
      });
      if (res === 'not_active') return bad(c, 409, 'hand_not_active');
      if (res === 'insufficient_chips') {
        return bad(c, 402, 'insufficient_chips', 'doubling needs chips >= bet');
      }
      const hand = db.getHand(handId);
      if (!hand) return bad(c, 500, 'internal_error');
      return c.json({ hand: publicHand(hand) });
    });

    app.post('/blackjack/cash-out', async (c) => {
      const parsed = await readBody(c);
      if (!parsed.ok) return bad(c, parsed.status, parsed.error);
      const b = parsed.body as Record<string, unknown>;
      const auth = await bjAuth(c, b, 'cash_out');
      if (!auth.ok) return auth.res;
      if (auth.handId !== '') return bad(c, 400, 'unexpected_hand_id');
      const { author, amount } = auth;
      if (amount <= 0n) return bad(c, 400, 'invalid_amount');
      // Rate limit AFTER the request is otherwise valid.
      if (!limiter.take(`bj-cashout:${author.toLowerCase()}`, BLACKJACK_CASHOUT_BUCKET)) {
        return bad(c, 429, 'rate_limited', '5 cash-outs per hour');
      }
      // Fail closed: chips stay in the DB until the founder enables payouts
      // (house key set AND dry-run explicitly off).
      if (!bj.houseKey || bj.dryRun) {
        return bad(c, 503, 'cash_out_unavailable', 'the house has not enabled cash-outs yet');
      }
      const key = author.toLowerCase();
      if (inFlightCashouts.has(key)) {
        return bad(c, 409, 'cashout_in_flight', 'a cash-out is already processing for this wallet');
      }
      // Registered synchronously, before any await — a concurrent duplicate
      // is guaranteed to see the entry.
      inFlightCashouts.add(key);
      try {
        const now = Math.floor(Date.now() / 1000);
        const cashoutId = newId();
        const debited = db.debitForCashout({ id: cashoutId, wallet: author, amount, now });
        if (debited === 'insufficient_chips') {
          return bad(c, 402, 'insufficient_chips');
        }
        const relay = await relayCashout({
          houseKey: bj.houseKey,
          house: bj.house,
          to: author,
          amount,
          rpcUrl: bj.rpcUrl,
        });
        if (!relay.ok) {
          db.recreditCashout(cashoutId, author, amount, now);
          return bad(c, 502, 'cashout_failed', relay.detail);
        }
        db.confirmCashout(cashoutId, relay.txHash);
        return c.json({ txHash: relay.txHash });
      } finally {
        inFlightCashouts.delete(key);
      }
    });
  }

  return app;
}

/**
 * In-flight cash-out dedupe, one entry per wallet (same pattern as
 * /settle's settlementDedupeKey). Same-process only.
 */
const inFlightCashouts = new Set<string>();

/**
 * Sign an EIP-3009 TransferWithAuthorization (house -> agent) with the
 * house key and relay it via USDC.transferWithAuthorization. Called only
 * when payouts are enabled (house key set, dry-run off) — the route guards
 * this; the helper itself never checks env.
 */
async function relayCashout(opts: {
  houseKey: Hex;
  house: Address;
  to: Address;
  amount: bigint;
  rpcUrl: string;
}): Promise<{ ok: true; txHash: Hex } | { ok: false; detail: string }> {
  const cfg = INK_CONFIG;
  const houseAccount = privateKeyToAccount(opts.houseKey);
  if (getAddress(houseAccount.address) !== getAddress(opts.house)) {
    return { ok: false, detail: 'house_key_mismatch' };
  }
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from: getAddress(opts.house),
    to: getAddress(opts.to),
    value: opts.amount,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 3600),
    nonce: randomNonce(),
  };
  const signature = await houseAccount.signTypedData({
    domain: eip3009Domain(cfg),
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });
  const { v, r, s } = splitSignature(signature);
  const chain = viemChain(cfg);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account: houseAccount, chain, transport });
  try {
    const hash = await walletClient.writeContract({
      address: cfg.usdc.address,
      abi: usdcEip3009Abi,
      functionName: 'transferWithAuthorization',
      args: [
        message.from,
        message.to,
        message.value,
        message.validAfter,
        message.validBefore,
        message.nonce,
        v,
        r,
        s,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return { ok: true, txHash: hash };
  } catch (e) {
    return { ok: false, detail: (e as Error).message?.slice(0, 300) };
  }
}
