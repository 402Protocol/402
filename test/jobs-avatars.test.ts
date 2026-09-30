/**
 * 402 Job Marketplace — agent avatar snapshot tests.
 *
 *   npx tsx test/jobs-avatars.test.ts
 *
 * Snapshotting is fully fail-soft: tokenURI/RPC/metadata/image failures,
 * oversized or non-image bytes all yield null and never block enrollment.
 * Re-pairing overwrites the stored snapshot (latest face wins).
 * No network in tests — the viem read and fetch are injected seams.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { type Address, type Hex, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { JobsDb } from '../src/jobs/db.js';
import { createJobsApp } from '../src/jobs/server.js';
import { createAgentsApp } from '../src/jobs/agents.js';
import { loadJobsConfig } from '../src/jobs/config.js';
import {
  defaultSnapshotSeatAvatar,
  ipfsToGateway,
  MAX_AVATAR_BYTES,
  type SnapshotSeatAvatar,
} from '../src/jobs/avatars.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { IdentityOwner, SeatPairingCheck, VerifySeatPairing } from '../src/jobs/escrow.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const worker = privateKeyToAccount(generatePrivateKey());
const worker2 = privateKeyToAccount(generatePrivateKey());
const escrowAddr = getAddress('0x00000000000000000000000000000000000000e5');
const seatAddr = getAddress('0x00000000000000000000000000000000000000ea');
const AGENT_ID = '4076';

const SVG_A =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg>';
const SVG_B =
  '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5" fill="blue"/></svg>';

let passed = 0;
async function check(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
}

// ---- 1. ipfs:// resolution ----

await check('ipfsToGateway resolves ipfs:// CIDs and paths', () => {
  assert.equal(
    ipfsToGateway('ipfs://bafyabc/1.json', 'https://ipfs.io/ipfs/'),
    'https://ipfs.io/ipfs/bafyabc/1.json',
  );
  // Tolerate the doubled ipfs://ipfs/ form.
  assert.equal(
    ipfsToGateway('ipfs://ipfs/bafyabc/1.json', 'https://ipfs.io/ipfs/'),
    'https://ipfs.io/ipfs/bafyabc/1.json',
  );
});

await check('ipfsToGateway passes https:// through, rejects the rest', () => {
  assert.equal(
    ipfsToGateway('https://example.com/a.svg', 'https://ipfs.io/ipfs/'),
    'https://example.com/a.svg',
  );
  assert.equal(
    ipfsToGateway('data:image/svg+xml,<svg/>', 'https://ipfs.io/ipfs/'),
    null,
  );
  assert.equal(ipfsToGateway('ipfs://', 'https://ipfs.io/ipfs/'), null);
});

await check('ipfsToGateway honors a custom gateway base', () => {
  assert.equal(
    ipfsToGateway('ipfs://bafyabc/1.json', 'https://gateway.pinata.cloud/ipfs'),
    'https://gateway.pinata.cloud/ipfs/bafyabc/1.json',
  );
});

// ---- 2. snapshot unit tests (mocked viem read + fetch) ----

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(
  routes: Record<string, Response | Error>,
): FetchFn {
  return async (url: string) => {
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return r;
  };
}

function unitSnap(
  readTokenUri: (seatTokenId: bigint) => Promise<string>,
  fetchImpl: FetchFn,
): SnapshotSeatAvatar {
  return defaultSnapshotSeatAvatar({
    rpcUrl: 'http://localhost:1',
    seatContract: seatAddr,
    readTokenUri,
    fetchImpl,
  });
}

const META_URL = 'https://ipfs.io/ipfs/bafymeta/1.json';
const IMG_URL = 'https://ipfs.io/ipfs/bafyimg/1.svg';

function happyFetch(imageField = 'ipfs://bafyimg/1.svg'): FetchFn {
  return mockFetch({
    [META_URL]: new Response(JSON.stringify({ image: imageField }), {
      headers: { 'content-type': 'application/json' },
    }),
    [IMG_URL]: new Response(SVG_A, {
      headers: { 'content-type': 'image/svg+xml' },
    }),
    'https://cdn.example.com/1.svg': new Response(SVG_A, {
      headers: { 'content-type': 'image/svg+xml' },
    }),
  });
}

await check('snapshot success: ipfs metadata -> ipfs image', async () => {
  const snap = unitSnap(async () => 'ipfs://bafymeta/1.json', happyFetch());
  const res = await snap(7n);
  assert.ok(res);
  assert.equal(res.contentType, 'image/svg+xml');
  assert.equal(res.bytes.toString('utf8'), SVG_A);
});

await check('snapshot success: https image passes through', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    happyFetch('https://cdn.example.com/1.svg'),
  );
  const res = await snap(7n);
  assert.ok(res);
  assert.equal(res.bytes.toString('utf8'), SVG_A);
});

await check('fail-soft: tokenURI read throws', async () => {
  const snap = unitSnap(
    async () => {
      throw new Error('rpc down');
    },
    happyFetch(),
  );
  assert.equal(await snap(7n), null);
});

await check('fail-soft: metadata fetch throws', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({ [META_URL]: new Error('network down') }),
  );
  assert.equal(await snap(7n), null);
});

await check('fail-soft: metadata 404', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({ [META_URL]: new Response('nope', { status: 404 }) }),
  );
  assert.equal(await snap(7n), null);
});

await check('fail-soft: metadata not JSON', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response('not json', {
        headers: { 'content-type': 'text/plain' },
      }),
    }),
  );
  assert.equal(await snap(7n), null);
});

await check('fail-soft: metadata has no image field', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response(JSON.stringify({ name: 'seat' }), {
        headers: { 'content-type': 'application/json' },
      }),
    }),
  );
  assert.equal(await snap(7n), null);
});

await check('fail-soft: image fetch 500', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response(JSON.stringify({ image: 'ipfs://bafyimg/1.svg' }), {
        headers: { 'content-type': 'application/json' },
      }),
      [IMG_URL]: new Response('err', { status: 500 }),
    }),
  );
  assert.equal(await snap(7n), null);
});

await check('size cap: declared content-length over the cap is rejected', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response(JSON.stringify({ image: 'ipfs://bafyimg/1.svg' }), {
        headers: { 'content-type': 'application/json' },
      }),
      [IMG_URL]: new Response(SVG_A, {
        headers: {
          'content-type': 'image/svg+xml',
          'content-length': String(MAX_AVATAR_BYTES + 1),
        },
      }),
    }),
  );
  assert.equal(await snap(7n), null);
});

await check('size cap: streamed body over the cap is rejected', async () => {
  const big = 'x'.repeat(MAX_AVATAR_BYTES + 1);
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response(JSON.stringify({ image: 'ipfs://bafyimg/1.svg' }), {
        headers: { 'content-type': 'application/json' },
      }),
      [IMG_URL]: new Response(big, {
        headers: { 'content-type': 'image/png' },
      }),
    }),
  );
  assert.equal(await snap(7n), null);
});

await check('reject: non-image content that does not sniff as SVG', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response(JSON.stringify({ image: 'ipfs://bafyimg/1.svg' }), {
        headers: { 'content-type': 'application/json' },
      }),
      [IMG_URL]: new Response('{"not":"an image"}', {
        headers: { 'content-type': 'application/json' },
      }),
    }),
  );
  assert.equal(await snap(7n), null);
});

await check('accept: SVG body under a mislabeled content-type (sniff)', async () => {
  const snap = unitSnap(
    async () => 'ipfs://bafymeta/1.json',
    mockFetch({
      [META_URL]: new Response(JSON.stringify({ image: 'ipfs://bafyimg/1.svg' }), {
        headers: { 'content-type': 'application/json' },
      }),
      [IMG_URL]: new Response(SVG_A, {
        headers: { 'content-type': 'text/plain' },
      }),
    }),
  );
  const res = await snap(7n);
  assert.ok(res);
  assert.equal(res.contentType, 'image/svg+xml');
});

await check('fail-soft: unfetchable tokenURI scheme', async () => {
  const snap = unitSnap(
    async () => 'data:application/json,{"image":"ipfs://bafyimg/1.svg"}',
    happyFetch(),
  );
  assert.equal(await snap(7n), null);
});

// ---- 3. DB roundtrip ----

await check('db: saveAvatar/getAvatar roundtrip', () => {
  const db = new JobsDb(':memory:');
  assert.equal(db.getAvatar(worker.address), null);
  assert.equal(db.hasAvatar(worker.address), false);
  db.saveAvatar({
    wallet: worker.address,
    agentId: AGENT_ID,
    seatTokenId: '11',
    imageBytes: Buffer.from(SVG_A),
    contentType: 'image/svg+xml',
    now: 1_800_000_000,
  });
  assert.equal(db.hasAvatar(worker.address), true);
  const a = db.getAvatar(worker.address);
  assert.ok(a);
  assert.equal(a.agentId, AGENT_ID);
  assert.equal(a.seatTokenId, '11');
  assert.equal(a.contentType, 'image/svg+xml');
  assert.equal(a.imageBytes.toString('utf8'), SVG_A);
  db.close();
});

await check('db: latest face wins on re-pair (INSERT OR REPLACE)', () => {
  const db = new JobsDb(':memory:');
  db.saveAvatar({
    wallet: worker.address,
    agentId: AGENT_ID,
    seatTokenId: '11',
    imageBytes: Buffer.from(SVG_A),
    contentType: 'image/svg+xml',
    now: 1_800_000_000,
  });
  db.saveAvatar({
    wallet: worker.address,
    agentId: AGENT_ID,
    seatTokenId: '22',
    imageBytes: Buffer.from(SVG_B),
    contentType: 'image/svg+xml',
    now: 1_800_000_100,
  });
  const a = db.getAvatar(worker.address);
  assert.ok(a);
  assert.equal(a.seatTokenId, '22');
  assert.equal(a.imageBytes.toString('utf8'), SVG_B);
  db.close();
});

await check('db: getAvatar is case-insensitive on wallet', () => {
  const db = new JobsDb(':memory:');
  db.saveAvatar({
    wallet: worker.address,
    agentId: AGENT_ID,
    seatTokenId: '11',
    imageBytes: Buffer.from(SVG_A),
    contentType: 'image/svg+xml',
    now: 1_800_000_000,
  });
  assert.ok(db.getAvatar(worker.address.toLowerCase()));
  db.close();
});

// ---- 4. Agents app: avatarUrl + avatar endpoint ----

function agentsStack(db: JobsDb): Hono {
  const app = new Hono();
  app.route('/agents', createAgentsApp(db));
  return app;
}

await check('GET /agents: avatarUrl null without snapshot, set with one', async () => {
  const db = new JobsDb(':memory:');
  db.enrollWorker({ wallet: worker.address, agentId: AGENT_ID, now: 1_800_000_000 });
  const app = agentsStack(db);
  let res = await app.request('/agents');
  assert.equal(res.status, 200);
  let body = (await res.json()) as any;
  assert.equal(body.agents[0].avatarUrl, null);

  db.saveAvatar({
    wallet: worker.address,
    agentId: AGENT_ID,
    seatTokenId: '11',
    imageBytes: Buffer.from(SVG_A),
    contentType: 'image/svg+xml',
    now: 1_800_000_000,
  });
  res = await app.request('/agents');
  body = (await res.json()) as any;
  assert.equal(
    body.agents[0].avatarUrl,
    `/agents/${getAddress(worker.address)}/avatar`,
  );
  db.close();
});

await check('GET /agents/:wallet/avatar serves bytes with content-type', async () => {
  const db = new JobsDb(':memory:');
  db.enrollWorker({ wallet: worker.address, agentId: AGENT_ID, now: 1_800_000_000 });
  db.saveAvatar({
    wallet: worker.address,
    agentId: AGENT_ID,
    seatTokenId: '11',
    imageBytes: Buffer.from(SVG_A),
    contentType: 'image/svg+xml',
    now: 1_800_000_000,
  });
  const app = agentsStack(db);
  const res = await app.request(`/agents/${worker.address}/avatar`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.ok(
    (res.headers.get('cache-control') ?? '').includes('max-age='),
    'avatar responses carry cache headers',
  );
  assert.equal(await res.text(), SVG_A);
  db.close();
});

await check('GET /agents/:wallet/avatar 404s without a snapshot', async () => {
  const db = new JobsDb(':memory:');
  db.enrollWorker({ wallet: worker.address, agentId: AGENT_ID, now: 1_800_000_000 });
  const app = agentsStack(db);
  const res = await app.request(`/agents/${worker.address}/avatar`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'avatar_not_found' });
  // Unknown wallet also 404s (not a 500).
  const res2 = await app.request(
    `/agents/0x0000000000000000000000000000000000000001/avatar`,
  );
  assert.equal(res2.status, 404);
  db.close();
});

// ---- 5. Enroll integration: snapshot fires after seat verification ----

const owners = new Map<string, Address>();
const identityOwner: IdentityOwner = async (agentId: bigint) =>
  owners.get(agentId.toString()) ?? null;

let seatVerdict: SeatPairingCheck = { ok: true };
const verifySeatPairing: VerifySeatPairing = async () => seatVerdict;

let snapCalls: bigint[] = [];
let snapResult: { bytes: Buffer; contentType: string } | null = {
  bytes: Buffer.from(SVG_A),
  contentType: 'image/svg+xml',
};
const snapshotAvatar: SnapshotSeatAvatar = async (seatId: bigint) => {
  snapCalls.push(seatId);
  return snapResult;
};

function seatStack(): { app: Hono; db: JobsDb } {
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1',
    JOBS_SEATS_REQUIRED: '1',
    FOUR02_TRACES_SEAT: seatAddr,
    JOBS_DAILY_POST_CAP: '10000',
  });
  assert.ok(cfg);
  const db = new JobsDb(':memory:');
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(cfg, {
      db,
      identityOwner,
      verifySeatPairing,
      snapshotAvatar,
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  parent.route('/agents', createAgentsApp(db));
  return { app: parent, db };
}

async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  primaryType: 'JobEnroll',
  message: Record<string, unknown>,
): Promise<Hex> {
  return account.signTypedData({
    domain: LOUNGE_DOMAIN,
    types: LOUNGE_TYPES,
    primaryType,
    message: message as never,
  });
}

async function enrollSeat(
  target: Hono,
  who: ReturnType<typeof privateKeyToAccount>,
  agentId: string,
  seatId: bigint | null,
) {
  const message = {
    wallet: who.address,
    agentId: BigInt(agentId),
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
  };
  const signature = await sign(who, 'JobEnroll', message);
  const body: Record<string, unknown> = {
    wallet: who.address,
    agentId,
    timestamp: Number(message.timestamp),
    signature,
  };
  if (seatId !== null) body.seatTokenId = seatId.toString();
  const res = await target.request('/jobs/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

await check('enroll with seat: 201, snapshot saved, avatarUrl live', async () => {
  snapCalls = [];
  snapResult = { bytes: Buffer.from(SVG_A), contentType: 'image/svg+xml' };
  owners.set(AGENT_ID, worker.address);
  const { app, db } = seatStack();
  const { status } = await enrollSeat(app, worker, AGENT_ID, 11n);
  assert.equal(status, 201);
  assert.deepEqual(snapCalls, [11n]);

  const avatar = db.getAvatar(worker.address);
  assert.ok(avatar);
  assert.equal(avatar.seatTokenId, '11');
  assert.equal(avatar.imageBytes.toString('utf8'), SVG_A);

  const res = await app.request('/agents');
  const body = (await res.json()) as any;
  const me = body.agents.find((a: any) => a.agentId === AGENT_ID);
  assert.equal(me.avatarUrl, `/agents/${getAddress(worker.address)}/avatar`);

  const img = await app.request(`/agents/${worker.address}/avatar`);
  assert.equal(img.status, 200);
  assert.equal(await img.text(), SVG_A);
  db.close();
});

await check('re-enroll with a different seat: latest face wins', async () => {
  snapCalls = [];
  snapResult = { bytes: Buffer.from(SVG_B), contentType: 'image/svg+xml' };
  owners.set(AGENT_ID, worker.address);
  const { app, db } = seatStack();
  assert.equal((await enrollSeat(app, worker, AGENT_ID, 11n)).status, 201);
  snapResult = { bytes: Buffer.from(SVG_B), contentType: 'image/svg+xml' };
  assert.equal((await enrollSeat(app, worker, AGENT_ID, 22n)).status, 200);
  assert.deepEqual(snapCalls, [11n, 22n]);
  const avatar = db.getAvatar(worker.address);
  assert.ok(avatar);
  assert.equal(avatar.seatTokenId, '22');
  assert.equal(avatar.imageBytes.toString('utf8'), SVG_B);
  db.close();
});

await check('fail-soft: snapshot null keeps enrollment green, avatarUrl null', async () => {
  snapCalls = [];
  snapResult = null;
  owners.set(AGENT_ID, worker2.address);
  const { app, db } = seatStack();
  const { status } = await enrollSeat(app, worker2, AGENT_ID, 33n);
  assert.equal(status, 201);
  assert.deepEqual(snapCalls, [33n]);
  assert.equal(db.hasAvatar(worker2.address), false);
  const res = await app.request('/agents');
  const body = (await res.json()) as any;
  const me = body.agents.find((a: any) => a.wallet === getAddress(worker2.address));
  assert.equal(me.avatarUrl, null);
  db.close();
});

await check('no snapshot when the seat gate is off (dormant)', async () => {
  snapCalls = [];
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1',
    JOBS_DAILY_POST_CAP: '10000',
  });
  assert.ok(cfg);
  assert.equal(cfg.seatsRequired, false);
  const db = new JobsDb(':memory:');
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(cfg, {
      db,
      identityOwner,
      snapshotAvatar,
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  owners.set(AGENT_ID, worker.address);
  const { status } = await enrollSeat(parent, worker, AGENT_ID, null);
  assert.equal(status, 201);
  assert.deepEqual(snapCalls, []);
  assert.equal(db.hasAvatar(worker.address), false);
  db.close();
});

console.log(`jobs avatars: ${passed} checks passed`);
