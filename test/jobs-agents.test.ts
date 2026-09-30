/**
 * 402 Job Marketplace — Agents directory tests.
 *
 *   npx tsx test/jobs-agents.test.ts
 *
 * GET /agents: every enrolled worker with live status, ordered working
 * first then waiting, by completedJobs desc within each group.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { type Address, getAddress, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { JobsDb } from '../src/jobs/db.js';
import { createAgentsApp } from '../src/jobs/agents.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const requester = privateKeyToAccount(generatePrivateKey());
const mk = () => privateKeyToAccount(generatePrivateKey());

const BASE = 1_800_000_000;
let db!: JobsDb; // assigned in makeApp() before any fixture/check runs
let seq = 0;

function makeApp(): Hono {
  db = new JobsDb(':memory:');
  const app = new Hono();
  // Mounted at /agents exactly like production (facilitator root).
  app.route('/agents', createAgentsApp(db));
  return app;
}

function enroll(wallet: Address, agentId: string, t: number): void {
  db.enrollWorker({ wallet, agentId, now: t });
}

function postJob(title: string, t: number): number {
  seq += 1;
  const res = db.createListing({
    escrowJobId: String(8000 + seq),
    escrow: getAddress('0x00000000000000000000000000000000000000e5'),
    requester: requester.address,
    title,
    spec: 'do the thing',
    specHash: keccak256(toHex(`agents-spec-${seq}`)),
    category: 'code',
    bountyUsdc: '10.00',
    deadline: t + 86400,
    txHash: keccak256(toHex(`agents-post-${seq}`)),
    now: t,
  });
  if (!res.ok) throw new Error(`createListing failed: ${res.reason}`);
  return res.id;
}

async function getAgents(app: Hono): Promise<{ status: number; body: any }> {
  const res = await app.request('/agents');
  return { status: res.status, body: await res.json() };
}

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
}

// ---- 1. empty registry ----
{
  const app = makeApp();
  await check('empty registry returns agents:[] and total:0', async () => {
    const { status, body } = await getAgents(app);
    assert.equal(status, 200);
    assert.deepEqual(body.agents, []);
    assert.equal(body.total, 0);
  });
}

// ---- 2. fixtures ----
const app = makeApp();
const wA = mk(); // waiting, 0 completed
const wB = mk(); // waiting, 2 completed
const wC = mk(); // working, 1 active, 0 completed
const wD = mk(); // working on a verified (unaccepted) job: active AND completed both count it
enroll(wA.address, '501', BASE);
enroll(wB.address, '502', BASE + 10);
enroll(wC.address, '503', BASE + 20);
enroll(wD.address, '504', BASE + 30);

for (let i = 0; i < 2; i++) {
  const id = postJob(`b-job-${i}`, BASE + 100 + i);
  assert.equal(db.claimJob(id, wB.address, '502', keccak256(toHex(`agents-claim-b${i}`)), BASE + 200 + i), 'ok');
  assert.equal(db.acceptJob(id, keccak256(toHex(`agents-accept-b${i}`)), BASE + 300 + i), 'ok');
}

const cJob = postJob('c-job', BASE + 400);
assert.equal(db.claimJob(cJob, wC.address, '503', keccak256(toHex('agents-claim-c')), BASE + 410), 'ok');

const dJob = postJob('d-job', BASE + 500);
assert.equal(db.claimJob(dJob, wD.address, '504', keccak256(toHex('agents-claim-d')), BASE + 510), 'ok');
assert.equal(db.submitJob(dJob, keccak256(toHex('agents-sub-d')), 'https://example.com/d.zip', BASE + 520), 'ok');
const r1 = mk();
const r2 = mk();
const r3 = mk();
assert.equal(
  db.openPanel(
    dJob,
    [
      { wallet: r1.address, agentId: '601' },
      { wallet: r2.address, agentId: '602' },
      { wallet: r3.address, agentId: '603' },
    ],
    BASE + 530,
    BASE + 86400,
  ),
  'ok',
);
assert.equal(
  db.recordReview({ jobId: dJob, reviewerWallet: r1.address, reviewerAgentId: '601', verdict: true, score: 80, signature: '0xsig', now: BASE + 540 }),
  'ok',
);
assert.equal(
  db.recordReview({ jobId: dJob, reviewerWallet: r2.address, reviewerAgentId: '602', verdict: true, score: 90, signature: '0xsig', now: BASE + 550 }),
  'ok',
);
assert.equal(db.getJob(dJob)?.state, 'verified');

// ---- 3. directory contract + ordering ----
await check('waiting worker row carries the full contract', async () => {
  const { status, body } = await getAgents(app);
  assert.equal(status, 200);
  assert.equal(body.total, 4);
  const b = body.agents.find((a: any) => a.agentId === '502');
  assert.ok(b);
  assert.equal(b.wallet, getAddress(wB.address));
  assert.equal(b.enrolledAt, (BASE + 10) * 1000);
  assert.equal(b.status, 'waiting');
  assert.equal(b.activeJobs, 0);
  assert.equal(b.completedJobs, 2);
  assert.equal(b.score, null);
});

await check('working worker is working with an active job', async () => {
  const { body } = await getAgents(app);
  const c = body.agents.find((a: any) => a.agentId === '503');
  assert.equal(c.status, 'working');
  assert.equal(c.activeJobs, 1);
  assert.equal(c.completedJobs, 0);
  assert.equal(c.score, null);
});

await check('verified-but-unaccepted job counts as both active and completed', async () => {
  const { body } = await getAgents(app);
  const d = body.agents.find((a: any) => a.agentId === '504');
  // The seat is still held (payout pending) -> working; the panel finalized -> completed.
  assert.equal(d.status, 'working');
  assert.equal(d.activeJobs, 1);
  assert.equal(d.completedJobs, 1);
});

await check('order is working-first then waiting, each by completedJobs desc', async () => {
  const { body } = await getAgents(app);
  const order = body.agents.map((a: any) => a.agentId);
  // working: 504 (1 completed) before 503 (0 completed); waiting: 502 (2) before 501 (0)
  assert.deepEqual(order, ['504', '503', '502', '501']);
});

// ---- 4. seat token ids ----
await check('linked seat resolves live; unlinked agent reads null', async () => {
  const seatApp = new Hono();
  // Mock resolver: agent 502 is paired to seat 77, everything else unpaired.
  seatApp.route(
    '/agents',
    createAgentsApp(db, {
      resolveSeat: async (agentId: string) => (agentId === '502' ? '77' : null),
    }),
  );
  const res = await seatApp.request('/agents');
  assert.equal(res.status, 200);
  const body = await res.json();
  const b = body.agents.find((a: any) => a.agentId === '502');
  const a = body.agents.find((a: any) => a.agentId === '501');
  assert.equal(b.seatTokenId, '77');
  assert.equal(a.seatTokenId, null);
});

await check('no registry configured: every agent reads seatTokenId null', async () => {
  // The default app was built with no resolveSeat (registry unconfigured).
  const { body } = await getAgents(app);
  assert.ok(body.agents.every((a: any) => a.seatTokenId === null));
});

console.log(`jobs agents: ${passed} checks passed`);
