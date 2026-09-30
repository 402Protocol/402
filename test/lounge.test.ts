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
  primaryType:
    | 'LoungePost'
    | 'LoungeComment'
    | 'LoungeVote'
    | 'LoungeChat'
    | 'LoungeNameClaim'
    | 'BlackjackAction',
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

// ---- resident display-name claims ----

async function claimName(
  app: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  opts: {
    name?: string;
    skew?: number;
    send?: Record<string, unknown>;
    signAs?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; json: any }> {
  const ts = BigInt(nowSec() + (opts.skew ?? 0));
  const name = opts.name ?? 'TestBot';
  const signature = await sign(account, 'LoungeNameClaim', {
    author: account.address,
    name,
    timestamp: ts,
    ...opts.signAs,
  });
  return postJson(app, '/lounge/name-claim', {
    author: account.address,
    name,
    timestamp: ts.toString(),
    signature,
    ...opts.send,
  });
}

await check('names: fresh DB seeds the three founding residents', async () => {
  const app = makeApp();
  const res = await app.request('/lounge/names');
  assert.equal(res.status, 200);
  const { names } = await res.json();
  assert.equal(names['0x7946Ab2B0ED3CB10F76EfBF7D4fC5a0453E1bC09'], 'MUSE-BC09');
  assert.equal(names['0xc5f6a5515AA731AbE1c7213C30f2eC75aBAb80B2'], 'Swappy');
  assert.equal(names['0xB17e7B5e6B5e1777dD62c583C9D4AfFB183f2D7E'], '402 Manager');
});

await check('names: resident can claim a name, appears in GET /names', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await claimName(app, alice, { name: 'AliceBot' });
  assert.equal(res.status, 201);
  assert.equal(res.json.wallet, alice.address);
  assert.equal(res.json.name, 'AliceBot');
  const got = await app.request('/lounge/names');
  const { names } = await got.json();
  assert.equal(names[alice.address], 'AliceBot');
});

await check('names: wallet with no posts gets 403 not_a_resident', async () => {
  const app = makeApp();
  const stranger = privateKeyToAccount(generatePrivateKey());
  const res = await claimName(app, stranger);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'not_a_resident');
});

await check('names: tampered name fails signature', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await claimName(app, alice, {
    name: 'RealName',
    send: { name: 'TamperedName' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'bad_signature');
});

await check('names: wrong signer fails', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const ts = BigInt(nowSec());
  const signature = await sign(bob, 'LoungeNameClaim', {
    author: alice.address,
    name: 'Hijack',
    timestamp: ts,
  });
  const res = await postJson(app, '/lounge/name-claim', {
    author: alice.address,
    name: 'Hijack',
    timestamp: ts.toString(),
    signature,
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'bad_signature');
});

await check('names: stale timestamp rejected', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await claimName(app, alice, { skew: -600 });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'stale_timestamp');
});

await check('names: invalid names rejected (empty, too long, bad chars)', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  for (const badName of ['', 'x'.repeat(25), '<script>', 'semi;colon', 'quo"te']) {
    const res = await claimName(app, alice, { name: badName });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(badName)}`);
    assert.equal(res.json.error, 'name_invalid');
  }
  // 24 chars is the max and is fine (fresh wallet to dodge the rate limiter)
  const bob = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, bob)).status, 201);
  const ok = await claimName(app, bob, { name: 'x'.repeat(24) });
  assert.equal(ok.status, 201);
});

await check('names: taken name rejected, case-insensitively (seeds protected)', async () => {
  const app = makeApp();
  const squatter = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, squatter)).status, 201);
  for (const taken of ['Swappy', 'sWaPpY', '402 Manager', 'MUSE-BC09']) {
    const res = await claimName(app, squatter, { name: taken });
    // first attempt 409s; the loop's later attempts may 429 — both are
    // rejections, but assert the first is the name conflict.
    if (taken === 'Swappy') assert.equal(res.status, 409);
    assert.ok(res.status === 409 || res.status === 429, `status ${res.status}`);
  }
  const first = await app.request('/lounge/names');
  const { names } = await first.json();
  assert.equal(names['0xc5f6a5515AA731AbE1c7213C30f2eC75aBAb80B2'], 'Swappy');
});

await check('names: two residents cannot hold the same name', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  assert.equal((await createPost(app, bob)).status, 201);
  assert.equal((await claimName(app, alice, { name: 'UniqueOne' })).status, 201);
  const res = await claimName(app, bob, { name: 'uniqueone' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'name_taken');
});

await check('names: rapid re-claim is rate limited (1/hour)', async () => {
  const app = makeApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  assert.equal((await claimName(app, alice, { name: 'First' })).status, 201);
  const res = await claimName(app, alice, { name: 'Second' });
  assert.equal(res.status, 429);
  assert.equal(res.json.error, 'rate_limited');
  const got = await app.request('/lounge/names');
  const { names } = await got.json();
  assert.equal(names[alice.address], 'First');
});

await check('names: db upsert updates a wallet\'s own name', async () => {
  const { LoungeDb } = await import('../src/lounge/db.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = new LoungeDb(join(tmpdir(), `names-test-${randomBytes(4).toString('hex')}.db`));
  try {
    const alice = privateKeyToAccount(generatePrivateKey());
    const bob = privateKeyToAccount(generatePrivateKey());
    assert.equal(db.setResidentName(alice.address, 'Alice', 1, 'sig1'), 'ok');
    assert.equal(db.getResidentName(alice.address), 'Alice');
    // update own name works
    assert.equal(db.setResidentName(alice.address, 'Alice2', 2, 'sig2'), 'ok');
    assert.equal(db.getResidentName(alice.address), 'Alice2');
    // another wallet cannot take it (case-insensitive)
    assert.equal(db.setResidentName(bob.address, 'alice2', 3, 'sig3'), 'name_taken');
    assert.equal(db.getResidentName(bob.address), null);
    // seed rows survive: ghost keeps its name, real claim would win
    assert.equal(
      db.getResidentName('0x7946Ab2B0ED3CB10F76EfBF7D4fC5a0453E1bC09'),
      'MUSE-BC09',
    );
  } finally {
    db.close();
  }
});

// ================= the count: agent blackjack =================

import {
  RESHUFFLE_PENETRATION,
  SHOE_SIZE,
  dealHand,
  dealerPlay,
  drawCard,
  handValue,
  isBlackjack,
  newShoe,
  resolve,
  seedHash,
  type Card,
  type Rank,
  type Suit,
} from '../src/lounge/blackjack.js';
import type { BlackjackConfig } from '../src/lounge/config.js';
import { createHash } from 'node:crypto';

const house = privateKeyToAccount(generatePrivateKey());

function bjConfig(over: Partial<BlackjackConfig> = {}): BlackjackConfig {
  return {
    house: house.address,
    houseKey: undefined,
    minBetUnits: 10_000n,
    maxBetUnits: 1_000_000n,
    dryRun: true,
    rpcUrl: 'http://localhost:1', // never called: getReceipt is mocked, payouts disabled
    ...over,
  };
}

function makeBjApp(over: Partial<BlackjackConfig> = {}): Hono {
  const parent = new Hono();
  parent.route(
    '/lounge',
    createLoungeApp(testConfig(), { getReceipt, blackjack: bjConfig(over) }),
  );
  return parent;
}

/** Sign a BlackjackAction message; amounts/timestamps sent as decimal strings. */
async function signBj(
  account: ReturnType<typeof privateKeyToAccount>,
  action: string,
  opts: { handId?: string; amount?: bigint; skew?: number } = {},
): Promise<Record<string, unknown>> {
  const handId = opts.handId ?? '';
  const amount = opts.amount ?? 0n;
  const timestamp = BigInt(nowSec() + (opts.skew ?? 0));
  const signature = await sign(account, 'BlackjackAction', {
    author: account.address,
    action,
    handId,
    amount,
    timestamp,
  });
  return {
    author: account.address,
    action,
    handId,
    amount: amount.toString(),
    timestamp: timestamp.toString(),
    signature,
  };
}

/** Funded chips via a mocked buy-in receipt; posts once unless resident:false. */
async function buyIn(
  app: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  amount: bigint,
  opts: { txHash?: Hex; resident?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const txHash = opts.txHash ?? randomTxHash();
  addPayment(txHash, account.address, house.address, amount);
  if (opts.resident !== false) {
    const r = await createPost(app, account);
    assert.equal(r.status, 201, 'post for residency');
  }
  return postJson(app, '/lounge/blackjack/buy-in', {
    ...(await signBj(account, 'buy_in', { amount })),
    txHash,
  });
}

async function bet(
  app: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  amount: bigint,
): Promise<{ status: number; json: any }> {
  return postJson(app, '/lounge/blackjack/bet', await signBj(account, 'bet', { amount }));
}

async function bjPlay(
  app: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  action: 'hit' | 'stand' | 'double',
  handId: string,
): Promise<{ status: number; json: any }> {
  return postJson(
    app,
    `/lounge/blackjack/${action}`,
    await signBj(account, action, { handId }),
  );
}

async function chipsOf(app: Hono, account: { address: Address }): Promise<bigint> {
  const res = await app.request(`/lounge/blackjack/chips/${account.address}`);
  assert.equal(res.status, 200);
  const { chips } = (await res.json()) as { chips: string };
  return BigInt(chips);
}

const card = (rank: Rank, suit: Suit = 'S'): Card => ({ rank, suit });

// ---- engine ----

await check('bj engine: hand values incl aces', () => {
  assert.equal(handValue([card('A'), card('K')]), 21);
  assert.equal(handValue([card('A'), card('9'), card('A')]), 21); // 11+9+1
  assert.equal(handValue([card('A'), card('A'), card('A'), card('8')]), 21); // 1+1+1+18? no: 11+1+1+8
  assert.equal(handValue([card('10'), card('6'), card('8')]), 24);
  assert.equal(handValue([card('A'), card('6')]), 17); // soft 17
  assert.equal(handValue([card('5'), card('J')]), 15);
});

await check('bj engine: blackjack detection', () => {
  assert.ok(isBlackjack([card('A'), card('K')]));
  assert.ok(isBlackjack([card('10'), card('A', 'H')]));
  assert.ok(!isBlackjack([card('A'), card('9')]));
  assert.ok(!isBlackjack([card('A'), card('K'), card('Q')]));
});

await check('bj engine: shoe length, determinism, verifiable seed', () => {
  const seed = `0x${randomBytes(32).toString('hex')}` as Hex;
  const a = newShoe(seed);
  const b = newShoe(seed);
  assert.equal(a.length, SHOE_SIZE);
  assert.equal(a.length, 312);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, newShoe(`0x${randomBytes(32).toString('hex')}` as Hex));
  // every card of a 6-deck shoe present exactly 6 times
  const counts = new Map<string, number>();
  for (const c of a) counts.set(`${c.rank}${c.suit}`, (counts.get(`${c.rank}${c.suit}`) ?? 0) + 1);
  assert.equal(counts.size, 52);
  for (const n of counts.values()) assert.equal(n, 6);
  // seedHash is plain sha256 of the seed bytes
  const expected = `0x${createHash('sha256').update(Buffer.from(seed.slice(2), 'hex')).digest('hex')}`;
  assert.equal(seedHash(seed), expected);
});

await check('bj engine: dealer stands on all 17s (incl soft)', () => {
  const shoe = newShoe(`0x${randomBytes(32).toString('hex')}` as Hex);
  // hard 17: no draw
  const hard = dealerPlay([card('10'), card('7')], shoe, 100);
  assert.deepEqual(hard.dealer, [card('10'), card('7')]);
  assert.equal(hard.pos, 100);
  // soft 17: no draw either
  const soft = dealerPlay([card('A'), card('6')], shoe, 100);
  assert.deepEqual(soft.dealer, [card('A'), card('6')]);
  assert.equal(soft.pos, 100);
  // 16 must draw
  const hit16 = dealerPlay([card('10'), card('6')], shoe, 100);
  assert.ok(hit16.dealer.length >= 3);
  assert.ok(handValue(hit16.dealer) >= 17 || hit16.dealer.length > 2);
});

await check('bj engine: resolve payouts', () => {
  const bet = 10_000n;
  // player blackjack pays 3:2 -> 2.5x total
  let r = resolve([card('A'), card('K')], [card('10'), card('7')], bet);
  assert.equal(r.status, 'player_blackjack');
  assert.equal(r.payout, 25_000n);
  // dealer blackjack wins outright
  r = resolve([card('10'), card('9')], [card('A'), card('Q')], bet);
  assert.equal(r.status, 'dealer_blackjack');
  assert.equal(r.payout, 0n);
  // both blackjack pushes
  r = resolve([card('A'), card('J')], [card('K'), card('A', 'H')], bet);
  assert.equal(r.status, 'push');
  assert.equal(r.payout, bet);
  // bust loses
  r = resolve([card('10'), card('6'), card('8')], [card('10'), card('7')], bet);
  assert.equal(r.status, 'bust');
  assert.equal(r.payout, 0n);
  // dealer bust pays even money
  r = resolve([card('10'), card('7')], [card('10'), card('6'), card('9')], bet);
  assert.equal(r.status, 'player_win');
  assert.equal(r.payout, 20_000n);
  // higher total wins, lower loses, tie pushes
  r = resolve([card('10'), card('10')], [card('10'), card('8')], bet);
  assert.equal(r.status, 'player_win');
  assert.equal(r.payout, 20_000n);
  r = resolve([card('10'), card('7')], [card('10'), card('9')], bet);
  assert.equal(r.status, 'dealer_win');
  assert.equal(r.payout, 0n);
  r = resolve([card('10'), card('8')], [card('9'), card('9')], bet);
  assert.equal(r.status, 'push');
  assert.equal(r.payout, bet);
});

await check('bj engine: double bet uses 2x stake in resolve', () => {
  const r = resolve([card('10'), card('9')], [card('10'), card('7')], 20_000n);
  assert.equal(r.status, 'player_win');
  assert.equal(r.payout, 40_000n);
});

await check('bj engine: drawCard advances pos, dealHand deals P-D-P-D', () => {
  const shoe = newShoe(`0x${randomBytes(32).toString('hex')}` as Hex);
  const d = dealHand(shoe, 0);
  assert.equal(d.pos, 4);
  assert.deepEqual(d.player, [shoe[0], shoe[2]]);
  assert.deepEqual(d.dealer, [shoe[1], shoe[3]]);
  const one = drawCard(shoe, 4);
  assert.deepEqual(one.card, shoe[4]);
  assert.equal(one.pos, 5);
});

// ---- buy-in ----

await check('bj: buy-in credits chips (mocked receipt)', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const res = await buyIn(app, alice, 200_000n);
  assert.equal(res.status, 201);
  assert.equal(res.json.chips, '200000');
  assert.equal(await chipsOf(app, alice), 200_000n);
});

await check('bj: buy-in below $0.10 rejected', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const res = await buyIn(app, alice, 99_999n);
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'buyin_too_small');
});

await check('bj: buy-in tx hash is single-use (replay -> 409)', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const txHash = randomTxHash();
  addPayment(txHash, alice.address, house.address, 200_000n);
  assert.equal((await createPost(app, alice)).status, 201);
  const body = await signBj(alice, 'buy_in', { amount: 200_000n });
  const first = await postJson(app, '/lounge/blackjack/buy-in', { ...body, txHash });
  assert.equal(first.status, 201);
  const second = await postJson(app, '/lounge/blackjack/buy-in', {
    ...(await signBj(alice, 'buy_in', { amount: 200_000n })),
    txHash,
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'buyin_reused');
  // chips only credited once
  assert.equal(await chipsOf(app, alice), 200_000n);
});

await check('bj: buy-in with wrong recipient receipt -> 402', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const txHash = randomTxHash();
  addPayment(txHash, alice.address, treasury.address, 200_000n); // paid treasury, not house
  const res = await postJson(app, '/lounge/blackjack/buy-in', {
    ...(await signBj(alice, 'buy_in', { amount: 200_000n })),
    txHash,
  });
  assert.equal(res.status, 402);
  assert.equal(res.json.error, 'payment_invalid');
  assert.equal(await chipsOf(app, alice), 0n);
});

await check('bj: non-resident cannot buy in (403)', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const res = await buyIn(app, alice, 200_000n, { resident: false });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'not_a_resident');
});

await check('bj: bad signature -> 401', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const mallory = privateKeyToAccount(generatePrivateKey());
  const txHash = randomTxHash();
  addPayment(txHash, alice.address, house.address, 200_000n);
  const res = await postJson(app, '/lounge/blackjack/buy-in', {
    ...(await signBj(mallory, 'buy_in', { amount: 200_000n })),
    author: alice.address, // claims alice, signed by mallory
    txHash,
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'bad_signature');
});

await check('bj: stale timestamp -> 401', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await postJson(
    app,
    '/lounge/blackjack/bet',
    await signBj(alice, 'bet', { amount: 10_000n, skew: -600 }),
  );
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'stale_timestamp');
});

await check('bj: wrong action string -> 401', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const txHash = randomTxHash();
  addPayment(txHash, alice.address, house.address, 200_000n);
  assert.equal((await createPost(app, alice)).status, 201);
  const res = await postJson(app, '/lounge/blackjack/buy-in', {
    ...(await signBj(alice, 'steal_chips', { amount: 200_000n })),
    txHash,
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'bad_signature');
});

// ---- game flow ----

await check('bj: bet -> stand conserves chips', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  const b = await bet(app, alice, 10_000n);
  assert.equal(b.status, 201);
  let hand = b.json.hand;
  assert.equal(hand.bet, '10000');
  assert.equal(hand.player.length, 2);
  assert.equal(hand.dealer.length, hand.dealerHoleHidden ? 1 : 2);
  if (hand.status === 'active') {
    assert.equal(hand.dealerHoleHidden, true);
    const s = await bjPlay(app, alice, 'stand', hand.id);
    assert.equal(s.status, 200);
    hand = s.json.hand;
  }
  assert.notEqual(hand.status, 'active');
  assert.equal(hand.dealerHoleHidden, false);
  assert.ok(hand.dealer.length >= 2);
  const expected = 1_000_000n - 10_000n + BigInt(hand.payout);
  assert.equal(await chipsOf(app, alice), expected);
});

await check('bj: second active hand rejected (409)', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  // deal until a hand stays active (naturals resolve immediately)
  for (let i = 0; i < 10; i++) {
    const b = await bet(app, alice, 10_000n);
    assert.equal(b.status, 201);
    if (b.json.hand.status === 'active') break;
    if (i === 9) throw new Error('no active hand dealt in 10 tries');
  }
  const dup = await bet(app, alice, 10_000n);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'hand_already_active');
});

await check('bj: bet below/above bounds -> 400', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 5_000_000n)).status, 201);
  let r = await bet(app, alice, 9_999n);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bet_out_of_range');
  r = await bet(app, alice, 1_000_001n);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bet_out_of_range');
});

await check('bj: insufficient chips -> 402', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 100_000n)).status, 201);
  const r = await bet(app, alice, 1_000_000n);
  assert.equal(r.status, 402);
  assert.equal(r.json.error, 'insufficient_chips');
  assert.equal(await chipsOf(app, alice), 100_000n);
});

await check('bj: hit until resolved, chips conserved', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  const b = await bet(app, alice, 50_000n);
  assert.equal(b.status, 201);
  let hand = b.json.hand;
  for (let i = 0; i < 15 && hand.status === 'active'; i++) {
    const h = await bjPlay(app, alice, 'hit', hand.id);
    assert.equal(h.status, 200);
    hand = h.json.hand;
  }
  assert.notEqual(hand.status, 'active');
  const expected = 1_000_000n - 50_000n + BigInt(hand.payout);
  assert.equal(await chipsOf(app, alice), expected);
});

await check('bj: hit/stand/double need the hand id', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  for (const action of ['hit', 'stand', 'double'] as const) {
    const res = await postJson(
      app,
      `/lounge/blackjack/${action}`,
      await signBj(alice, action),
    );
    assert.equal(res.status, 400, action);
    assert.equal(res.json.error, 'missing_hand_id');
  }
});

await check('bj: hit with nonzero amount -> 400', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  const b = await bet(app, alice, 10_000n);
  assert.equal(b.status, 201);
  if (b.json.hand.status === 'active') {
    const res = await postJson(
      app,
      '/lounge/blackjack/hit',
      await signBj(alice, 'hit', { handId: b.json.hand.id, amount: 5n }),
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_amount');
  }
});

await check('bj: cannot play another wallet\'s hand (403)', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  assert.equal((await createPost(app, bob)).status, 201);
  let handId: string | null = null;
  for (let i = 0; i < 10; i++) {
    const b = await bet(app, alice, 10_000n);
    assert.equal(b.status, 201);
    if (b.json.hand.status === 'active') {
      handId = b.json.hand.id;
      break;
    }
  }
  assert.ok(handId, 'active hand dealt');
  const res = await bjPlay(app, bob, 'hit', handId);
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'not_your_hand');
});

await check('bj: resolved hand rejects further play (409)', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  const b = await bet(app, alice, 10_000n);
  assert.equal(b.status, 201);
  let hand = b.json.hand;
  if (hand.status === 'active') {
    const s = await bjPlay(app, alice, 'stand', hand.id);
    assert.equal(s.status, 200);
    hand = s.json.hand;
  }
  const h = await bjPlay(app, alice, 'hit', hand.id);
  assert.equal(h.status, 409);
  assert.equal(h.json.error, 'hand_not_active');
});

// ---- double ----

await check('bj: double resolves with 2x stake', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 500_000n)).status, 201);
  let handId: string | null = null;
  for (let i = 0; i < 10; i++) {
    const b = await bet(app, alice, 50_000n);
    assert.equal(b.status, 201);
    if (b.json.hand.status === 'active') {
      handId = b.json.hand.id;
      break;
    }
  }
  assert.ok(handId, 'active hand dealt');
  const d = await bjPlay(app, alice, 'double', handId);
  assert.equal(d.status, 200);
  const hand = d.json.hand;
  assert.equal(hand.bet, '100000');
  assert.notEqual(hand.status, 'active');
  const expected = 500_000n - 100_000n + BigInt(hand.payout);
  assert.equal(await chipsOf(app, alice), expected);
});

await check('bj: double without chips >= bet -> 402', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 150_000n)).status, 201);
  let handId: string | null = null;
  for (let i = 0; i < 10; i++) {
    const b = await bet(app, alice, 100_000n);
    assert.equal(b.status, 201);
    if (b.json.hand.status === 'active') {
      handId = b.json.hand.id;
      break;
    }
  }
  assert.ok(handId, 'active hand dealt');
  const d = await bjPlay(app, alice, 'double', handId);
  assert.equal(d.status, 402);
  assert.equal(d.json.error, 'insufficient_chips');
  assert.equal(await chipsOf(app, alice), 50_000n);
});

// ---- cash-out (disabled by default) ----

await check('bj: cash-out 503 without house key, chips untouched', async () => {
  const app = makeBjApp(); // no houseKey -> payouts disabled
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 200_000n)).status, 201);
  const res = await postJson(
    app,
    '/lounge/blackjack/cash-out',
    await signBj(alice, 'cash_out', { amount: 50_000n }),
  );
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'cash_out_unavailable');
  assert.equal(await chipsOf(app, alice), 200_000n);
});

await check('bj: cash-out requires residency + signature + amount', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  // not a resident at all
  let res = await postJson(
    app,
    '/lounge/blackjack/cash-out',
    await signBj(alice, 'cash_out', { amount: 50_000n }),
  );
  assert.equal(res.status, 403);
  // resident, stale signature
  assert.equal((await createPost(app, alice)).status, 201);
  res = await postJson(
    app,
    '/lounge/blackjack/cash-out',
    await signBj(alice, 'cash_out', { amount: 50_000n, skew: -600 }),
  );
  assert.equal(res.status, 401);
  // resident, zero amount
  res = await postJson(
    app,
    '/lounge/blackjack/cash-out',
    await signBj(alice, 'cash_out', { amount: 0n }),
  );
  assert.equal(res.status, 400);
});

// ---- reads ----

await check('bj: table/leaderboard/hand views', async () => {
  const app = makeBjApp();
  const alice = privateKeyToAccount(generatePrivateKey());
  assert.equal((await buyIn(app, alice, 1_000_000n)).status, 201);
  const b = await bet(app, alice, 10_000n);
  assert.equal(b.status, 201);
  const hand = b.json.hand;
  const table = await app.request('/lounge/blackjack/table');
  assert.equal(table.status, 200);
  const t = (await table.json()) as any;
  assert.ok(t.shoe.cardsLeft < 312 && t.shoe.cardsLeft > 0);
  assert.ok(t.shoe.penetration > 0);
  assert.ok(/^0x[0-9a-f]{64}$/.test(t.shoe.seedHash));
  assert.equal(t.shoe.revealedSeed, null); // no reshuffle yet
  assert.equal(t.house, getAddress(house.address)); // house wallet published for buy-ins
  assert.equal(t.hands.length, hand.status === 'active' ? 1 : 0);
  if (hand.status === 'active') {
    assert.equal(t.hands[0].dealerHoleHidden, true);
    assert.equal(t.hands[0].dealer.length, 1);
  }
  const hv = await app.request(`/lounge/blackjack/hand/${hand.id}`);
  assert.equal(hv.status, 200);
  const { hand: fetched } = (await hv.json()) as any;
  assert.equal(fetched.id, hand.id);
  assert.equal(fetched.dealerHoleHidden, hand.status === 'active');
  const lb = await app.request('/lounge/blackjack/leaderboard');
  assert.equal(lb.status, 200);
  const { leaders } = (await lb.json()) as any;
  assert.equal(leaders.length, 1);
  assert.equal(leaders[0].wallet, getAddress(alice.address));
  assert.equal(BigInt(leaders[0].chips), await chipsOf(app, alice));
  // 404s
  assert.equal((await app.request('/lounge/blackjack/hand/nope')).status, 404);
  assert.equal((await app.request(`/lounge/blackjack/chips/0x123`)).status, 400);
});

await check('bj: immediate natural payout credited atomically (db)', async () => {
  const { LoungeDb } = await import('../src/lounge/db.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = new LoungeDb(join(tmpdir(), `bj-test-${randomBytes(4).toString('hex')}.db`));
  try {
    const alice = privateKeyToAccount(generatePrivateKey());
    const now = nowSec();
    const seed = `0x${randomBytes(32).toString('hex')}` as Hex;
    const shoeId = randomBytes(8).toString('hex');
    db.insertShoe({
      id: shoeId,
      seed,
      seedHash: seedHash(seed),
      cardsJson: JSON.stringify(newShoe(seed)),
      now,
    });
    // buy-in credit via the single-use burn
    assert.equal(
      db.creditBuyin(`0x${'ab'.repeat(32)}`, alice.address, 100_000n, now),
      'ok',
    );
    // dealer blackjack on the deal: resolved immediately, payout 0
    const r = resolve(
      [card('10'), card('7')],
      [card('A'), card('K')],
      10_000n,
    );
    assert.equal(r.status, 'dealer_blackjack');
    const res = db.placeBet({
      wallet: alice.address,
      bet: 10_000n,
      handId: randomBytes(8).toString('hex'),
      playerJson: JSON.stringify([card('10'), card('7')]),
      dealerJson: JSON.stringify([card('A'), card('K')]),
      status: r.status,
      payout: r.payout,
      resolvedAt: now,
      now,
      shoeId,
      newPos: 4,
      rollover: null,
    });
    assert.equal(res, 'ok');
    assert.equal(db.getChips(alice.address), 90_000n);
  } finally {
    db.close();
  }
});

await check('bj: reshuffle at 75% penetration reveals old seed', async () => {
  const app = makeBjApp();
  const players = [
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
  ];
  for (const p of players) {
    assert.equal((await buyIn(app, p, 5_000_000n)).status, 201);
  }
  const tableOf = async () => {
    const res = await app.request('/lounge/blackjack/table');
    assert.equal(res.status, 200);
    return (await res.json()) as any;
  };
  const first = await bet(app, players[0], 10_000n);
  assert.equal(first.status, 201);
  if (first.json.hand.status === 'active') {
    assert.equal((await bjPlay(app, players[0], 'stand', first.json.hand.id)).status, 200);
  }
  const firstHash: string = (await tableOf()).shoe.seedHash;
  assert.ok(/^0x[0-9a-f]{64}$/.test(firstHash));
  let reshuffled = false;
  for (let i = 0; i < 90 && !reshuffled; i++) {
    const p = players[i % players.length];
    const b = await bet(app, p, 10_000n);
    assert.equal(b.status, 201, `bet ${i}`);
    let hand = b.json.hand;
    if (hand.status === 'active') {
      const s = await bjPlay(app, p, 'stand', hand.id);
      assert.equal(s.status, 200, `stand ${i}`);
    }
    const t = await tableOf();
    if (t.shoe.revealedSeed) {
      reshuffled = true;
      // the revealed seed must hash to the previously committed seedHash
      const recomputed =
        `0x${createHash('sha256').update(Buffer.from(t.shoe.revealedSeed.slice(2), 'hex')).digest('hex')}`;
      assert.equal(recomputed, firstHash);
      assert.ok(t.shoe.penetration < 0.75, `penetration ${t.shoe.penetration}`);
      assert.ok(t.shoe.cardsLeft > 300, `cardsLeft ${t.shoe.cardsLeft}`);
    }
  }
  assert.ok(reshuffled, 'reshuffle triggered within 90 hands');
});

console.log(`\n${passed} lounge tests passed${process.exitCode ? " (with failures)" : ""}`);
