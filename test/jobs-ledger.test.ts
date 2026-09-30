/**
 * 402 Job Marketplace — The Ledger explorer tests.
 *
 *   npx tsx test/jobs-ledger.test.ts
 *
 * GET /jobs/ledger (+ /jobs/ledger/counts): full-lifecycle buckets, category
 * and limit filters, the explorer row contract, and error shapes.
 *
 * Fixtures are built through JobsDb methods directly (no chain, no
 * signatures); the HTTP assertions go through createJobsApp.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { type Address, getAddress, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadJobsConfig } from '../src/jobs/config.js';
import { JobsDb, LEDGER_STATUSES } from '../src/jobs/db.js';
import { createJobsApp } from '../src/jobs/server.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const requester = privateKeyToAccount(generatePrivateKey());
const worker = privateKeyToAccount(generatePrivateKey());
const r1 = privateKeyToAccount(generatePrivateKey());
const r2 = privateKeyToAccount(generatePrivateKey());
const r3 = privateKeyToAccount(generatePrivateKey());
const escrowAddr = getAddress('0x00000000000000000000000000000000000000e5');

const tx = (label: string) => keccak256(toHex(`jobs-ledger-test-${label}`));
const reviewers = [
  { wallet: r1.address as Address, agentId: '101' },
  { wallet: r2.address as Address, agentId: '102' },
  { wallet: r3.address as Address, agentId: '103' },
];

let db!: JobsDb; // assigned in makeApp() before any fixture/check runs
let seq = 0;
const BASE = 1_800_000_000; // fixed clock: deterministic ordering

function makeApp(): Hono {
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1', // dead localhost: never called, db-driven fixtures
    JOBS_DAILY_POST_CAP: '10000',
  });
  assert.ok(cfg);
  db = new JobsDb(':memory:');
  const parent = new Hono();
  parent.route('/jobs', createJobsApp(cfg, { db }));
  return parent;
}

function postJob(o: { title: string; category?: string; t: number }): number {
  seq += 1;
  const res = db.createListing({
    escrowJobId: String(9000 + seq),
    escrow: escrowAddr,
    requester: requester.address,
    title: o.title,
    spec: 'do the thing',
    specHash: keccak256(toHex(`ledger-spec-${seq}`)),
    category: o.category ?? 'code',
    bountyUsdc: '25.00',
    deadline: o.t + 86400,
    txHash: tx(`post-${seq}`),
    now: o.t,
  });
  if (!res.ok) throw new Error(`createListing failed: ${res.reason}`);
  return res.id;
}

function claim(id: number, t: number): void {
  const r = db.claimJob(id, worker.address, '4076', tx(`claim-${id}`), t);
  assert.equal(r, 'ok');
}

async function get(app: Hono, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(`/jobs${path}`);
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

// ---- 1. empty board ----
{
  const app = makeApp();
  await check('empty ledger returns jobs:[] and total:0', async () => {
    const { status, body } = await get(app, '/ledger');
    assert.equal(status, 200);
    assert.deepEqual(body.jobs, []);
    assert.equal(body.total, 0);
  });
  await check('empty counts are all zero', async () => {
    const { status, body } = await get(app, '/ledger/counts');
    assert.equal(status, 200);
    assert.equal(body.total, 0);
    assert.deepEqual(body.byStatus, { open: 0, active: 0, completed: 0, failed: 0 });
    assert.deepEqual(body.byCategory, {
      'oracle-panel': 0,
      writing: 0,
      code: 0,
      design: 0,
      data: 0,
    });
  });
}

// ---- 2. lifecycle fixtures across every bucket ----
const app = makeApp();
const T = (n: number) => BASE + n * 100;

const jobOpen = postJob({ title: 'open job', category: 'code', t: T(0) });

const jobClaimed = postJob({ title: 'claimed job', category: 'code', t: T(1) });
claim(jobClaimed, T(1) + 10);

const jobSubmitted = postJob({ title: 'submitted job', category: 'writing', t: T(2) });
claim(jobSubmitted, T(2) + 10);
assert.equal(db.submitJob(jobSubmitted, keccak256(toHex('sub')), 'https://example.com/a.zip', T(2) + 20), 'ok');

const jobInReview = postJob({ title: 'in-review job', category: 'code', t: T(3) });
claim(jobInReview, T(3) + 10);
assert.equal(db.submitJob(jobInReview, keccak256(toHex('sub3')), 'https://example.com/b.zip', T(3) + 20), 'ok');
assert.equal(db.openPanel(jobInReview, reviewers, T(3) + 30, T(3) + 86400), 'ok');

const jobVerified = postJob({ title: 'verified job', category: 'design', t: T(4) });
claim(jobVerified, T(4) + 10);
assert.equal(db.submitJob(jobVerified, keccak256(toHex('sub4')), 'https://example.com/c.zip', T(4) + 20), 'ok');
assert.equal(db.openPanel(jobVerified, reviewers, T(4) + 30, T(4) + 86400), 'ok');
assert.equal(
  db.recordReview({ jobId: jobVerified, reviewerWallet: r1.address, reviewerAgentId: '101', verdict: true, score: 80, signature: '0xsig1', now: T(4) + 40 }),
  'ok',
);
assert.equal(
  db.recordReview({ jobId: jobVerified, reviewerWallet: r2.address, reviewerAgentId: '102', verdict: true, score: 90, signature: '0xsig2', now: T(4) + 50 }),
  'ok',
);
assert.equal(db.getJob(jobVerified)?.state, 'verified');

const jobComplete = postJob({ title: 'complete job', category: 'code', t: T(5) });
claim(jobComplete, T(5) + 10);
assert.equal(db.submitJob(jobComplete, keccak256(toHex('sub5')), 'https://example.com/work.zip', T(5) + 20), 'ok');
assert.equal(db.openPanel(jobComplete, reviewers, T(5) + 30, T(5) + 86400), 'ok');
assert.equal(
  db.recordReview({ jobId: jobComplete, reviewerWallet: r1.address, reviewerAgentId: '101', verdict: true, score: 70, signature: '0xsig3', now: T(5) + 40 }),
  'ok',
);
assert.equal(
  db.recordReview({ jobId: jobComplete, reviewerWallet: r2.address, reviewerAgentId: '102', verdict: true, score: 90, signature: '0xsig4', now: T(5) + 50 }),
  'ok',
);
const acceptTx = tx('accept-complete');
assert.equal(db.acceptJob(jobComplete, acceptTx, T(5) + 60), 'ok');

const jobResolved = postJob({ title: 'resolved job', category: 'data', t: T(6) });
claim(jobResolved, T(6) + 10);
assert.equal(db.disputeJob(jobResolved, tx('dispute-6'), T(6) + 20), 'ok');
const resolveTx = tx('resolve-6');
assert.equal(db.resolveJob(jobResolved, resolveTx, T(6) + 30), 'ok');

const jobRefunded = postJob({ title: 'refunded job', category: 'code', t: T(7) });
assert.equal(db.refundJob(jobRefunded, tx('refund-7'), T(7) + 10), 'ok');

// ---- 3. bucket filters ----
await check('status=open returns only posted-but-unclaimed jobs', async () => {
  const { status, body } = await get(app, '/ledger?status=open');
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.jobs.length, 1);
  const j = body.jobs[0];
  assert.equal(j.jobId, String(jobOpen));
  assert.equal(j.state, 'open');
  assert.equal(j.workerWallet, null);
  assert.equal(j.claimedAt, null);
  assert.equal(j.submittedAt, null);
  assert.equal(j.deliveryUri, null);
  assert.equal(j.scoreStatus, 'none');
  assert.equal(j.settlementTx, null);
});

await check('status=active returns claimed/submitted/in_review', async () => {
  const { status, body } = await get(app, '/ledger?status=active');
  assert.equal(status, 200);
  assert.equal(body.total, 3);
  const states = body.jobs.map((j: any) => j.state).sort();
  assert.deepEqual(states, ['claimed', 'in_review', 'submitted']);
  for (const j of body.jobs) assert.ok(j.workerWallet, 'active jobs have a worker');
});

await check('status=completed returns verified/complete/resolved', async () => {
  const { status, body } = await get(app, '/ledger?status=completed');
  assert.equal(status, 200);
  assert.equal(body.total, 3);
  const states = body.jobs.map((j: any) => j.state).sort();
  assert.deepEqual(states, ['complete', 'resolved', 'verified']);
});

await check('status=failed returns refunded', async () => {
  const { status, body } = await get(app, '/ledger?status=failed');
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.jobs[0].state, 'refunded');
});

await check('status=all (default) returns everything, newest activity first', async () => {
  const { body: def } = await get(app, '/ledger');
  const { body } = await get(app, '/ledger?status=all');
  assert.equal(def.total, 8);
  assert.equal(body.total, 8);
  assert.equal(body.jobs.length, 8);
  // refunded job has the latest updated_at
  assert.equal(body.jobs[0].jobId, String(jobRefunded));
  assert.equal(body.jobs[body.jobs.length - 1].jobId, String(jobOpen));
});

// ---- 4. full explorer row contract on the completed job ----
await check('complete job row carries the full contract', async () => {
  const { body } = await get(app, '/ledger?status=completed');
  const j = body.jobs.find((x: any) => x.state === 'complete');
  assert.ok(j, 'complete job present');
  assert.equal(j.jobId, String(jobComplete));
  assert.equal(j.title, 'complete job');
  assert.equal(j.category, 'code');
  assert.equal(j.bountyUsdc, '25.00');
  assert.equal(j.workerWallet, getAddress(worker.address));
  assert.equal(j.workerAgentId, '4076');
  assert.equal(j.deliveryUri, 'https://example.com/work.zip');
  assert.equal(j.postedAt, T(5) * 1000);
  assert.equal(j.claimedAt, (T(5) + 10) * 1000);
  assert.equal(j.submittedAt, (T(5) + 20) * 1000);
  assert.equal(j.scoreStatus, 'scored');
  assert.equal(j.score, 80); // avg of 70 + 90
  assert.equal(j.settlementTx, acceptTx);
});

await check('verified job is scored with no settlement tx yet', async () => {
  const { body } = await get(app, '/ledger?status=completed');
  const j = body.jobs.find((x: any) => x.state === 'verified');
  assert.equal(j.scoreStatus, 'scored');
  assert.equal(j.score, 85); // avg of 80 + 90
  assert.equal(j.settlementTx, null);
  assert.equal(j.deliveryUri, 'https://example.com/c.zip');
});

await check('resolved job links the resolve tx and has no score', async () => {
  const { body } = await get(app, '/ledger?status=completed');
  const j = body.jobs.find((x: any) => x.state === 'resolved');
  assert.equal(j.settlementTx, resolveTx);
  assert.equal(j.scoreStatus, 'none');
  assert.equal(j.score, null);
});

await check('in-review job is scoreStatus=queued with hidden delivery', async () => {
  const { body } = await get(app, '/ledger?status=active');
  const j = body.jobs.find((x: any) => x.state === 'in_review');
  assert.equal(j.scoreStatus, 'queued');
  assert.equal(j.score, null);
  assert.equal(j.deliveryUri, null); // blind review: hidden until shipped
  assert.equal(j.settlementTx, null);
  assert.equal(j.submittedAt, (T(3) + 20) * 1000);
});

// ---- 5. category + limit + total ----
await check('category filter scopes jobs and total', async () => {
  const { body } = await get(app, '/ledger?status=all&category=code');
  assert.equal(body.total, 5);
  assert.ok(body.jobs.every((j: any) => j.category === 'code'));
});

await check('limit caps rows but not total', async () => {
  const { body } = await get(app, '/ledger?status=all&limit=2');
  assert.equal(body.jobs.length, 2);
  assert.equal(body.total, 8);
});

await check('invalid status and category are 400s', async () => {
  const badStatus = await get(app, '/ledger?status=bogus');
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.body.error, 'invalid_status');
  const badCat = await get(app, '/ledger?category=bogus');
  assert.equal(badCat.status, 400);
  assert.equal(badCat.body.error, 'invalid_category');
});

// ---- 6. counts endpoint ----
await check('counts returns per-bucket and per-category totals', async () => {
  const { status, body } = await get(app, '/ledger/counts');
  assert.equal(status, 200);
  assert.equal(body.total, 8);
  assert.deepEqual(body.byStatus, { open: 1, active: 3, completed: 3, failed: 1 });
  assert.deepEqual(body.byCategory, {
    'oracle-panel': 0,
    writing: 1,
    code: 5,
    design: 1,
    data: 1,
  });
});

await check('LEDGER_STATUSES exports the documented filter values', () => {
  assert.deepEqual([...LEDGER_STATUSES], ['all', 'open', 'active', 'completed', 'failed']);
});

console.log(`jobs ledger: ${passed} checks passed`);
