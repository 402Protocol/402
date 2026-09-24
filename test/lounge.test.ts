/**
 * 402 Lounge — tests.
 *
 *   npx tsx test/lounge.test.ts
 *
 * Covers: config validation, EIP-712 signature verification (valid, wrong
 * author, tampered, stale/future timestamps), payment verification with a
 * mocked RPC (valid, wrong recipient, wrong amount, wrong token, reverted,
 * reused hash, missing receipt), vote replace logic, hot/new/top sorting,
 * pagination, per-author rate limits, output escaping, body-size limits,
 * and mounting on the facilitator app.
 *
 * Keys: throwaway keys generated in-process. No real RPC calls, nothing
 * broadcast.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import {
  type Address,
  type Hex,
  getAddress,
  keccak256,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { USDC_ADDRESS } from '../src/constants.js';
import { loadConfig } from '../src/facilitator/config.js';
import { NonceStore } from '../src/facilitator/nonces.js';
import { createApp } from '../src/facilitator/server.js';
import { loadLoungeConfig, type LoungeConfig } from '../src/lounge/config.js';
import { sortPosts } from '../src/lounge/server.js';
import { createLoungeApp } from '../src/lounge/server.js';
import { AuthorRateLimiter, POST_BUCKET } from '../src/lounge/ratelimit.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { GetReceipt, Post, ReceiptLike } from '../src/lounge/types.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const treasury = privateKeyToAccount(generatePrivateKey());
const FEE_UNITS = 10_000n; // 0.01 USDC

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const addrTopic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const randomTxHash = (): Hex =>
  `0x${randomBytes(32).toString('hex')}` as Hex;

// ---- mocked RPC: programmable txHash -> receipt ----
const receipts = new Map<string, ReceiptLike>();
function addPayment(
  txHash: Hex,
  from: Address,
  to: Address,
  value: bigint,
  token: string = USDC_ADDRESS,
  status = 'success',
): void {
  receipts.set(txHash.toLowerCase(), {
    status,
    logs: [
      {
        address: token,
        topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
        data: `0x${value.toString(16).padStart(64, '0')}`,
      },
    ],
  });
}
const getReceipt: GetReceipt = async (h: Hex) =>
  receipts.get(h.toLowerCase()) ?? null;

function testConfig(): LoungeConfig {
  return {
    treasury: treasury.address,
    postFeeUsdc: '0.01',
    postFeeUnits: FEE_UNITS,
    rpcUrl: 'http://localhost:1', // never called: getReceipt is mocked
    dbPath: ':memory:',
  };
}

function makeApp(): Hono {
  const parent = new Hono();
  parent.route('/lounge', createLoungeApp(testConfig(), { getReceipt }));
  return parent;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- signing helpers ----
async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  primaryType: 'LoungePost' | 'LoungeComment' | 'LoungeVote' | 'LoungeChat',
  message: Record<string, unknown>,
): Promise<Hex> {
  return account.signTypedData({
    domain: LOUNGE_DOMAIN,
    types: LOUNGE_TYPES,
    primaryType,
    message: message as never,
  });
}

async function postJson(
  app: Hono,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Create a paid post; registers a mock payment unless fund:false. */
async function createPost(
  app: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  opts: {
    title?: string;
    body?: string;
    skew?: number;
    txHash?: Hex;
    value?: bigint;
    to?: Address;
    token?: string;
    status?: string;
    fund?: boolean;
    send?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; json: any }> {
  const txHash = opts.txHash ?? randomTxHash();
  if (opts.fund !== false) {
    addPayment(
      txHash,
      account.address,
      opts.to ?? treasury.address,
      opts.value ?? FEE_UNITS,
      opts.token,
      opts.status,
    );
  }
  const ts = BigInt(nowSec() + (opts.skew ?? 0));
  const title = opts.title ?? 'hello lounge';
  const body = opts.body ?? 'first post';
  const signature = await sign(account, 'LoungePost', {
    author: account.address,
    title,
    body,
    timestamp: ts,
  });
  return postJson(app, '/lounge/posts', {
    author: account.address,
    title,
    body,
    timestamp: ts.toString(),
    signature,
    paymentTxHash: txHash,
    ...opts.send,
  });
}

async function createComment(
  app: Hono,
  postId: string,
  account: ReturnType<typeof privateKeyToAccount>,
  opts: { body?: string; parentId?: string; skew?: number } = {},
): Promise<{ status: number; json: any }> {
  const ts = BigInt(nowSec() + (opts.skew ?? 0));
  const body = opts.body ?? 'nice post';
  const parentId = opts.parentId ?? '';
  const signature = await sign(account, 'LoungeComment', {
    author: account.address,
    postId,
    body,
    timestamp: ts,
    parentId,
  });
  return postJson(app, `/lounge/posts/${postId}/comments`, {
    author: account.address,
    body,
    timestamp: ts.toString(),
    parentId,
    signature,
  });
}

async function createVote(
  app: Hono,
  postId: string,
  account: ReturnType<typeof privateKeyToAccount>,
  direction: number,
): Promise<{ status: number; json: any }> {
  const ts = BigInt(nowSec());
  const signature = await sign(account, 'LoungeVote', {
    author: account.address,
    postId,
    direction,
    timestamp: ts,
  });
  return postJson(app, `/lounge/posts/${postId}/vote`, {
    author: account.address,
    direction,
    timestamp: ts.toString(),
    signature,
  });
}

// ---- runner (repo convention) ----
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------- config ----------
await check('config: throws clear error when LOUNGE_TREASURY unset', () => {
  assert.throws(() => loadLoungeConfig({}), /LOUNGE_TREASURY is required/);
});

await check('config: throws on malformed treasury address', () => {
  assert.throws(
    () => loadLoungeConfig({ LOUNGE_TREASURY: '0x123' }),
    /not a valid Ethereum address/,
  );
});

await check('config: parses fee units from LOUNGE_POST_FEE_USDC', () => {
  const cfg = loadLoungeConfig({
    LOUNGE_TREASURY: treasury.address,
    LOUNGE_POST_FEE_USDC: '0.05',
  });
  assert.equal(cfg.postFeeUnits, 50_000n);
  assert.equal(cfg.treasury, getAddress(treasury.address));
});

await check('config: rejects bad fee format', () => {
  assert.throws(
    () =>
      loadLoungeConfig({
        LOUNGE_TREASURY: treasury.address,
        LOUNGE_POST_FEE_USDC: 'abc',
      }),
    /LOUNGE_POST_FEE_USDC/,
  );
});

// ---------- signatures ----------
await check('post: valid signature + payment -> 201 with id', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const r = await createPost(app, author);
  assert.equal(r.status, 201);
  assert.match(r.json.id, /^[0-9a-f]{32}$/);
  const feed = await app.request('/lounge/posts?sort=new');
  const posts = (await feed.json()).posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, getAddress(author.address));
});

await check('post: signature from another key -> 401', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const impostor = privateKeyToAccount(generatePrivateKey());
  const txHash = randomTxHash();
  addPayment(txHash, author.address, treasury.address, FEE_UNITS);
  const ts = BigInt(nowSec());
  // Impostor signs a message CLAIMING author's address.
  const signature = await sign(impostor, 'LoungePost', {
    author: author.address,
    title: 't',
    body: 'b',
    timestamp: ts,
  });
  const r = await postJson(app, '/lounge/posts', {
    author: author.address,
    title: 't',
    body: 'b',
    timestamp: ts.toString(),
    signature,
    paymentTxHash: txHash,
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'bad_signature');
});

await check('post: tampered title after signing -> 401', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const txHash = randomTxHash();
  addPayment(txHash, author.address, treasury.address, FEE_UNITS);
  const ts = BigInt(nowSec());
  const signature = await sign(author, 'LoungePost', {
    author: author.address,
    title: 'real title',
    body: 'b',
    timestamp: ts,
  });
  const r = await postJson(app, '/lounge/posts', {
    author: author.address,
    title: 'tampered title',
    body: 'b',
    timestamp: ts.toString(),
    signature,
    paymentTxHash: txHash,
  });
  assert.equal(r.status, 401);
});

await check('post: stale timestamp (10 min old) -> 401', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    skew: -600,
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'stale_timestamp');
});

await check('post: future timestamp (+10 min) -> 401', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    skew: 600,
  });
  assert.equal(r.status, 401);
});

await check('post: title >140 chars -> 400', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    title: 'x'.repeat(141),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_title');
});

await check('post: body >2000 chars -> 400', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    body: 'x'.repeat(2001),
  });
  assert.equal(r.status, 400);
});

// ---------- payments (mocked RPC) ----------
await check('payment: wrong recipient -> 402', async () => {
  const app = makeApp();
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    to: other,
  });
  assert.equal(r.status, 402);
  assert.equal(r.json.error, 'payment_invalid');
  assert.equal(r.json.detail, 'no_matching_transfer');
});

await check('payment: amount below fee -> 402', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    value: FEE_UNITS - 1n,
  });
  assert.equal(r.status, 402);
  assert.equal(r.json.detail, 'no_matching_transfer');
});

await check('payment: overpaying the fee is accepted', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    value: FEE_UNITS + 500n,
  });
  assert.equal(r.status, 201);
});

await check('payment: transfer from wrong token contract -> 402', async () => {
  const app = makeApp();
  const fakeToken = privateKeyToAccount(generatePrivateKey()).address;
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    token: fakeToken,
  });
  assert.equal(r.status, 402);
});

await check('payment: reverted tx -> 402', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    status: 'reverted',
  });
  assert.equal(r.status, 402);
  assert.equal(r.json.detail, 'tx_failed');
});

await check('payment: missing receipt -> 402', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    fund: false,
  });
  assert.equal(r.status, 402);
  assert.equal(r.json.detail, 'receipt_not_found');
});

await check('payment: malformed tx hash -> 400', async () => {
  const app = makeApp();
  const r = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
    fund: false,
    send: { paymentTxHash: '0x123' },
  });
  // send overrides paymentTxHash AFTER createPost built the request — the
  // helper spreads opts.send last, so this hits the malformed branch.
  assert.equal(r.status, 400);
  assert.equal(r.json.detail, 'malformed_tx_hash');
});

await check('payment: reused tx hash -> 409 on second post', async () => {
  const app = makeApp();
  const author1 = privateKeyToAccount(generatePrivateKey());
  const author2 = privateKeyToAccount(generatePrivateKey());
  const txHash = randomTxHash();
  addPayment(txHash, author1.address, treasury.address, FEE_UNITS);
  addPayment(txHash, author2.address, treasury.address, FEE_UNITS);
  // Second registration overwrites the first in the mock map; re-add both
  // as separate logs via a combined receipt.
  receipts.set(txHash.toLowerCase(), {
    status: 'success',
    logs: [author1, author2].map((a) => ({
      address: USDC_ADDRESS,
      topics: [TRANSFER_TOPIC, addrTopic(a.address), addrTopic(treasury.address)],
      data: `0x${FEE_UNITS.toString(16).padStart(64, '0')}`,
    })),
  });
  const r1 = await createPost(app, author1, { txHash });
  assert.equal(r1.status, 201);
  const r2 = await createPost(app, author2, { txHash });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error, 'payment_reused');
});

// ---------- votes ----------
await check('vote: +1 then -1 replaces (no double count)', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const voter = privateKeyToAccount(generatePrivateKey());
  const postId = (await createPost(app, author)).json.id;
  let r = await createVote(app, postId, voter, 1);
  assert.equal(r.status, 200);
  assert.equal(r.json.score, 1);
  r = await createVote(app, postId, voter, -1);
  assert.equal(r.status, 200);
  assert.equal(r.json.score, -1);
  const got = await app.request(`/lounge/posts/${postId}`);
  const post = (await got.json()).post;
  assert.equal(post.upvotes, 0);
  assert.equal(post.downvotes, 1);
  assert.equal(post.score, -1);
});

await check('vote: re-vote same direction is a no-op', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const voter = privateKeyToAccount(generatePrivateKey());
  const postId = (await createPost(app, author)).json.id;
  await createVote(app, postId, voter, 1);
  const r = await createVote(app, postId, voter, 1);
  assert.equal(r.json.score, 1);
  const got = await app.request(`/lounge/posts/${postId}`);
  assert.equal((await got.json()).post.upvotes, 1);
});

await check('vote: invalid direction -> 400', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const voter = privateKeyToAccount(generatePrivateKey());
  const postId = (await createPost(app, author)).json.id;
  const r = await createVote(app, postId, voter, 2);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_direction');
});

await check('vote: missing post -> 404', async () => {
  const app = makeApp();
  const r = await createVote(app, 'nope', privateKeyToAccount(generatePrivateKey()), 1);
  assert.equal(r.status, 404);
});

await check('vote: signed for post A, submitted to post B -> 401', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const voter = privateKeyToAccount(generatePrivateKey());
  const postA = (await createPost(app, author)).json.id;
  const postB = (await createPost(app, privateKeyToAccount(generatePrivateKey()))).json.id;
  const ts = BigInt(nowSec());
  const signature = await sign(voter, 'LoungeVote', {
    author: voter.address,
    postId: postA,
    direction: 1,
    timestamp: ts,
  });
  const r = await postJson(app, `/lounge/posts/${postB}/vote`, {
    author: voter.address,
    direction: 1,
    timestamp: ts.toString(),
    signature,
  });
  assert.equal(r.status, 401);
});

// ---------- comments ----------
await check('comments: flat chronological list + commentCount', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const postId = (await createPost(app, author)).json.id;
  const c1 = await createComment(app, postId, privateKeyToAccount(generatePrivateKey()), { body: 'first' });
  assert.equal(c1.status, 201);
  const replyAuthor = privateKeyToAccount(generatePrivateKey());
  const c2 = await createComment(app, postId, replyAuthor, {
    body: 'reply',
    parentId: c1.json.id,
  });
  assert.equal(c2.status, 201);
  const got = await app.request(`/lounge/posts/${postId}`);
  const { post, comments } = await got.json();
  assert.equal(post.commentCount, 2);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, 'first');
  assert.equal(comments[1].parentId, c1.json.id);
  assert.ok(comments[0].createdAt <= comments[1].createdAt);
});

await check('comments: body >1000 chars -> 400', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const postId = (await createPost(app, author)).json.id;
  const r = await createComment(app, postId, privateKeyToAccount(generatePrivateKey()), {
    body: 'x'.repeat(1001),
  });
  assert.equal(r.status, 400);
});

await check('comments: parentId from another post -> 400', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const postA = (await createPost(app, author)).json.id;
  const postB = (await createPost(app, privateKeyToAccount(generatePrivateKey()))).json.id;
  const c = await createComment(app, postA, privateKeyToAccount(generatePrivateKey()));
  const r = await createComment(app, postB, privateKeyToAccount(generatePrivateKey()), {
    parentId: c.json.id,
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_parent');
});

await check('comments: missing post -> 404', async () => {
  const app = makeApp();
  const r = await createComment(app, 'nope', privateKeyToAccount(generatePrivateKey()));
  assert.equal(r.status, 404);
});

// ---------- sorting & pagination (deterministic unit tests) ----------
function fakePost(over: Partial<Post>): Post {
  return {
    id: Math.random().toString(16).slice(2),
    author: '0x0000000000000000000000000000000000000001' as Address,
    title: 't',
    body: 'b',
    createdAt: 1_700_000_000,
    upvotes: 0,
    downvotes: 0,
    score: 0,
    commentCount: 0,
    ...over,
  };
}

await check('sort: new orders by createdAt desc', () => {
  const now = 1_700_000_000;
  const posts = [fakePost({ createdAt: now - 30 }), fakePost({ createdAt: now }), fakePost({ createdAt: now - 10 })];
  const sorted = sortPosts(posts, 'new', now);
  assert.deepEqual(sorted.map((p) => p.createdAt), [now, now - 10, now - 30]);
});

await check('sort: top orders by score desc', () => {
  const now = 1_700_000_000;
  const posts = [
    fakePost({ score: 1, upvotes: 1 }),
    fakePost({ score: 10, upvotes: 10 }),
    fakePost({ score: -5, downvotes: 5 }),
  ];
  const sorted = sortPosts(posts, 'top', now);
  assert.deepEqual(sorted.map((p) => p.score), [10, 1, -5]);
});

await check('sort: hot prefers fresh over stale at equal gravity', () => {
  const now = 1_700_000_000;
  const fresh = fakePost({ score: 5, upvotes: 5, createdAt: now - 60 });
  const stale = fakePost({ score: 50, upvotes: 50, createdAt: now - 30 * 3600 });
  const sorted = sortPosts([stale, fresh], 'hot', now);
  // fresh: 5 / (2.017^1.5) ≈ 1.74 ; stale: 50 / (32^1.5) ≈ 0.28
  assert.equal(sorted[0].id, fresh.id);
});

await check('feed: limit + cursor paginate', async () => {
  const app = makeApp();
  for (let i = 0; i < 3; i++) {
    await createPost(app, privateKeyToAccount(generatePrivateKey()), { title: `p${i}` });
  }
  const page1 = await (await app.request('/lounge/posts?sort=new&limit=2')).json();
  assert.equal(page1.posts.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = await (
    await app.request(`/lounge/posts?sort=new&limit=2&cursor=${page1.nextCursor}`)
  ).json();
  assert.equal(page2.posts.length, 1);
  assert.equal(page2.nextCursor, null);
  const titles = [...page1.posts, ...page2.posts].map((p: any) => p.title);
  assert.deepEqual(titles, ['p2', 'p1', 'p0']);
});

// ---------- rate limits ----------
await check('ratelimit: 2nd post within 60s -> 429', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const r1 = await createPost(app, author);
  assert.equal(r1.status, 201);
  const r2 = await createPost(app, author, { title: 'second' });
  assert.equal(r2.status, 429);
  assert.equal(r2.json.error, 'rate_limited');
});

await check('ratelimit: 6th comment within 60s -> 429', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const postId = (await createPost(app, author)).json.id;
  const commenter = privateKeyToAccount(generatePrivateKey());
  for (let i = 0; i < 5; i++) {
    const r = await createComment(app, postId, commenter, { body: `c${i}` });
    assert.equal(r.status, 201);
  }
  const r = await createComment(app, postId, commenter, { body: 'c5' });
  assert.equal(r.status, 429);
});

await check('ratelimit: 21st vote within 60s -> 429', async () => {
  const app = makeApp();
  const voter = privateKeyToAccount(generatePrivateKey());
  const postIds: string[] = [];
  for (let i = 0; i < 21; i++) {
    const p = await createPost(app, privateKeyToAccount(generatePrivateKey()), {
      title: `v${i}`,
    });
    assert.equal(p.status, 201);
    postIds.push(p.json.id);
  }
  for (let i = 0; i < 20; i++) {
    const r = await createVote(app, postIds[i], voter, 1);
    assert.equal(r.status, 200);
  }
  const r = await createVote(app, postIds[20], voter, 1);
  assert.equal(r.status, 429);
});

await check('ratelimit: unit — fixed window resets', () => {
  const limiter = new AuthorRateLimiter();
  const t0 = Date.now();
  assert.equal(limiter.take('k', POST_BUCKET, t0), true);
  assert.equal(limiter.take('k', POST_BUCKET, t0 + 1000), false);
  assert.equal(limiter.take('k', POST_BUCKET, t0 + 61_000), true);
});

// ---------- escaping & hardening ----------
await check('xss: html in title/body is escaped on output', async () => {
  const app = makeApp();
  const author = privateKeyToAccount(generatePrivateKey());
  const evil = '<script>alert("x")</script>';
  const r = await createPost(app, author, { title: evil, body: '<b>bold</b>' });
  assert.equal(r.status, 201);
  const feed = await (await app.request('/lounge/posts?sort=new')).json();
  assert.equal(feed.posts[0].title, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(feed.posts[0].body, '&lt;b&gt;bold&lt;/b&gt;');
  // Stored raw: signature over raw content still verifies on re-fetch path.
  assert.ok(!feed.posts[0].title.includes('<script>'));
});

await check('hardening: body >32KB -> 413', async () => {
  const app = makeApp();
  const res = await app.request('/lounge/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(33 * 1024) }),
  });
  assert.equal(res.status, 413);
});

await check('hardening: invalid JSON -> 400', async () => {
  const app = makeApp();
  const res = await app.request('/lounge/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

await check('health: GET /lounge/health -> { ok: true }', async () => {
  const app = makeApp();
  const res = await app.request('/lounge/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

await check('mount: facilitator createApp mounts /lounge when configured', async () => {
  const app = createApp(loadConfig(), new NonceStore(), {
    lounge: testConfig(),
  });
  const res = await app.request('/lounge/health');
  assert.equal(res.status, 200);
  // ...and the facilitator's own routes still work.
  assert.equal((await app.request('/health')).status, 200);
});

await check('mount: no /lounge routes without lounge config', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  assert.equal((await app.request('/lounge/health')).status, 404);
});

// ---- town chat ----

/** Helper: sign + POST a chat message as account. */
async function sendChat(
  app: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  opts: {
    message?: string;
    skew?: number;
    send?: Record<string, unknown>;
    signAs?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; json: any }> {
  const ts = BigInt(nowSec() + (opts.skew ?? 0));
  const message = opts.message ?? 'hey town';
  const signature = await sign(account, 'LoungeChat', {
    author: account.address,
    message,
    timestamp: ts,
    ...opts.signAs,
  });
  return postJson(app, '/lounge/chat', {
    author: account.address,
    message,
    timestamp: ts.toString(),
    signature,
    ...opts.send,
  });
}

await check('chat: resident with a paid post can send a signed message', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const posted = await createPost(app, alice);
  assert.equal(posted.status, 201);
  const res = await sendChat(app, alice, { message: 'hello neighbors' });
  assert.equal(res.status, 201);
  assert.match(res.json.id, /^[0-9a-f]{32}$/);
});

await check('chat: wallet with no posts gets 403 not_a_resident', async () => {
  const app = makeApp();
  const stranger = privateKeyToAccount(generatePrivateKey());
  const res = await sendChat(app, stranger);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'not_a_resident');
});

await check('chat: tampered message fails signature', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await sendChat(app, alice, {
    message: 'real message',
    send: { message: 'tampered message' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'bad_signature');
});

await check('chat: wrong signer fails', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const ts = BigInt(nowSec());
  const signature = await sign(bob, 'LoungeChat', {
    author: alice.address,
    message: 'impersonating',
    timestamp: ts,
  });
  const res = await postJson(app, '/lounge/chat', {
    author: alice.address,
    message: 'impersonating',
    timestamp: ts.toString(),
    signature,
  });
  assert.equal(res.status, 401);
});

await check('chat: message length enforced (empty, too long)', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  assert.equal((await sendChat(app, alice, { message: '' })).status, 400);
  assert.equal((await sendChat(app, alice, { message: 'x'.repeat(281) })).status, 400);
  assert.equal((await sendChat(app, alice, { message: 'x'.repeat(280) })).status, 201);
});

await check('chat: stale timestamp rejected', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await sendChat(app, alice, { skew: -600 });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'stale_timestamp');
});

await check('chat: burst rate limit (1 per 5s)', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  assert.equal((await sendChat(app, alice, { message: 'one' })).status, 201);
  const res = await sendChat(app, alice, { message: 'two' });
  assert.equal(res.status, 429);
  assert.equal(res.json.error, 'rate_limited');
});

await check('chat: GET returns messages oldest-first, HTML-escaped', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  assert.equal((await createPost(app, bob)).status, 201);
  // bypass the 5s burst limit by spacing via distinct apps is overkill;
  // instead send from two different authors (separate burst buckets).
  assert.equal((await sendChat(app, alice, { message: 'first <b>hi</b>' })).status, 201);
  assert.equal((await sendChat(app, bob, { message: 'second' })).status, 201);
  const res = await app.request('/lounge/chat?limit=50');
  assert.equal(res.status, 200);
  const { messages } = await res.json();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message, 'first &lt;b&gt;hi&lt;/b&gt;');
  assert.equal(messages[1].message, 'second');
  assert.ok(messages[0].createdAt <= messages[1].createdAt);
  assert.equal(messages[0].author, alice.address);
});

await check('chat: GET limit param respected', async () => {
  const app = makeApp();
  const authors = [
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
  ];
  for (const a of authors) {
    assert.equal((await createPost(app, a)).status, 201);
    assert.equal((await sendChat(app, a)).status, 201);
  }
  const res = await app.request('/lounge/chat?limit=2');
  assert.equal((await res.json()).messages.length, 2);
  const bad = await app.request('/lounge/chat?limit=999');
  assert.equal((await bad.json()).messages.length, 3); // capped at 100, only 3 exist
});

console.log(`\n${passed} lounge tests passed${process.exitCode ? ' (with failures)' : ''}`);
