/**
 * 402 Job Marketplace v0 — tests.
 *
 *   npx tsx test/jobs.test.ts
 *
 * Integration tests against createJobsApp with a mocked chain layer:
 * getReceipt / getOnchainJob / identityOwner / reputationSummary are all
 * in-memory, and the RPC URL is a dead localhost (never called). Throwaway
 * in-process keys; nothing is broadcast, no real funds.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseUnits,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { USDC_ADDRESS } from '../src/constants.js';
import { loadJobsConfig } from '../src/jobs/config.js';
import { JobsDb } from '../src/jobs/db.js';
import {
  BOUNTY_CLAIMED_TOPIC,
  BOUNTY_CREATED_TOPIC,
  DISPUTE_RAISED_TOPIC,
  DISPUTE_RESOLVED_TOPIC,
  JOB_REFUNDED_TOPIC,
  JOB_RELEASED_TOPIC,
  type GetOnchainJob,
  type OnchainJob,
  type ReputationSummary,
  type SeatPairingCheck,
  type VerifySeatPairing,
} from '../src/jobs/escrow.js';
import { createJobsApp, type JobActivityEvent } from '../src/jobs/server.js';
import { createJobFeed } from '../src/jobs/feed.js';
import { LoungeDb } from '../src/lounge/db.js';
import { createLoungeApp } from '../src/lounge/server.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { GetReceipt, ReceiptLike } from '../src/lounge/types.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const requester = privateKeyToAccount(generatePrivateKey());
const worker = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const escrowAddr = getAddress('0x00000000000000000000000000000000000000e5');

const AGENT_ID = 7n;
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- mocked chain layer -----------------------------------------------------

const receipts = new Map<string, ReceiptLike>();
const owners = new Map<string, Address>(); // agentId -> owner
// onchain job state for POST /jobs/:id/sync, keyed by escrow job id
const onchainJobs = new Map<string, OnchainJob>();

const getReceipt: GetReceipt = async (h: Hex) =>
  receipts.get(h.toLowerCase()) ?? null;
const getOnchainJob: GetOnchainJob = async (_escrow, escrowJobId) =>
  onchainJobs.get(escrowJobId.toString()) ?? null;
const identityOwner = async (agentId: bigint): Promise<Address | null> =>
  owners.get(agentId.toString()) ?? null;
const reputationSummary = async (): Promise<ReputationSummary> => ({
  reliability: '95',
  disputeRateBps: '0',
  arbitrationWins: '3',
  arbitrationLosses: '0',
  totalEvents: '12',
  lastEventTimestamp: nowSec(),
});
const activity: JobActivityEvent[] = [];
const onActivity = (a: JobActivityEvent) => activity.push(a);

function jobsConfig() {
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1', // dead localhost: never called, mocks injected
    // Generous cap: the shared app posts dozens of jobs across the suite;
    // it must not be coupled to the production daily cap (G3 proves the cap
    // 429s on a dedicated app with a small cap).
    JOBS_DAILY_POST_CAP: '10000',
  });
  assert.ok(cfg);
  return cfg;
}

function makeApp(): Hono {
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(jobsConfig(), {
      db: new JobsDb(':memory:'),
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      onActivity,
      // Generous bucket: the suite must not be coupled to the production
      // rate-limit budget (a dedicated test below proves the default 429s).
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  return parent;
}

const app = makeApp();

// ---- receipt builders ----

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const addrTopic = (a: string) =>
  ('0x' + a.slice(2).toLowerCase().padStart(64, '0')).toLowerCase();
const uintTopic = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')).toLowerCase();

function transferLog(from: string, to: string, value: bigint) {
  return {
    address: USDC_ADDRESS,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  };
}

function bountyCreatedLog(jobId: bigint, payer: string, amount: bigint, deadline: bigint, termsHash: string) {
  return {
    address: escrowAddr,
    topics: [BOUNTY_CREATED_TOPIC, uintTopic(jobId), addrTopic(payer)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
      [amount, deadline, termsHash as Hex],
    ),
  };
}

function bountyClaimedLog(jobId: bigint, provider: string, agentId: bigint) {
  return {
    address: escrowAddr,
    topics: [
      BOUNTY_CLAIMED_TOPIC,
      uintTopic(jobId),
      addrTopic(provider),
      uintTopic(agentId),
    ],
    data: '0x',
  };
}

function jobRefundedLog(jobId: bigint) {
  return {
    address: escrowAddr,
    topics: [JOB_REFUNDED_TOPIC, uintTopic(jobId)],
    data: '0x',
  };
}

function disputeResolvedLog(jobId: bigint) {
  return {
    address: escrowAddr,
    topics: [DISPUTE_RESOLVED_TOPIC, uintTopic(jobId)],
    data: `0x${(50_000_000n).toString(16).padStart(64, '0')}${(50_000_000n).toString(16).padStart(64, '0')}`,
  };
}

function fundingReceipt(jobId: bigint, amount: bigint, deadline: bigint, termsHash: string): ReceiptLike {
  return {
    status: 'success',
    logs: [
      transferLog(requester.address, escrowAddr, amount),
      bountyCreatedLog(jobId, requester.address, amount, deadline, termsHash),
    ],
  };
}

function claimReceipt(jobId: bigint, agentId: bigint, claimer?: string): ReceiptLike {
  return {
    status: 'success',
    logs: [bountyClaimedLog(jobId, claimer ?? worker.address, agentId)],
  };
}

function jobReleasedLog(jobId: bigint) {
  return {
    address: escrowAddr,
    topics: [JOB_RELEASED_TOPIC, uintTopic(jobId)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [50_000_000n, 1_000_000n],
    ),
  };
}

function disputeRaisedLog(jobId: bigint, raiser: string) {
  return {
    address: escrowAddr,
    topics: [DISPUTE_RAISED_TOPIC, uintTopic(jobId), addrTopic(raiser)],
    data: '0x',
  };
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

/**
 * Post a job with FIXED immutable terms (deadline/termsHash/amount) so
 * POST /jobs/:id/sync fixtures can match them exactly.
 */
async function postFixedJob(
  seed: string,
  escrowJobId: bigint,
): Promise<{ jobId: number; deadline: number; termsHash: Hex }> {
  const deadline = 1893456000; // 2030-01-01T00:00:00Z, fixed
  const spec = 'Write a 500-word explainer on x402 micropayments.';
  const termsHash = keccak256(toHex(spec)).toLowerCase() as Hex;
  const body = await signedPost({ deadline: deadline.toString(), spec });
  const h = txHash(seed);
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(escrowJobId, parseUnits('25.00', 6), BigInt(deadline), termsHash),
  );
  const res = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 201);
  return { jobId: res.body.jobId as number, deadline, termsHash };
}

/** Mock an onchain BountyEscrow job for POST /jobs/:id/sync. */
function mockChainJob(
  escrowJobId: bigint,
  state: number,
  fixed: { deadline: number; termsHash: Hex },
  over: Partial<OnchainJob> = {},
): void {
  onchainJobs.set(escrowJobId.toString(), {
    payer: requester.address,
    provider: ZERO_ADDR,
    agentId: 0n,
    amount: parseUnits('25.00', 6),
    deadline: BigInt(fixed.deadline),
    termsHash: fixed.termsHash,
    state,
    ...over,
  });
}

function txHash(seed: string): Hex {
  return keccak256(toHex(`jobs-test-${seed}`));
}

// ---- signing helpers ----

async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  primaryType: 'JobEnroll' | 'JobPost' | 'JobClaim' | 'JobSubmit' | 'JobDecision' | 'JobSpecAccess' | 'JobSubmissionAccess',
  message: Record<string, unknown>,
): Promise<Hex> {
  return account.signTypedData({
    domain: LOUNGE_DOMAIN,
    types: LOUNGE_TYPES,
    primaryType,
    message: message as never,
  });
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(app: Hono, path: string) {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---- shared fixtures ----

function jobPostFields(over: Record<string, unknown> = {}) {
  const spec = 'Write a 500-word explainer on x402 micropayments.';
  const bountyUsdc = '25.00';
  const deadline = BigInt(nowSec() + 86400);
  const termsHash = keccak256(toHex(spec)).toLowerCase();
  return {
    requester: requester.address,
    title: 'Explainer post',
    spec,
    category: 'writing',
    bountyUsdc,
    deadline: deadline.toString(),
    termsHash,
    timestamp: nowSec(),
    specPrivate: false,
    ...over,
  };
}

async function signedPost(over: Record<string, unknown> = {}) {
  const f = jobPostFields(over);
  const signature = await sign(requester, 'JobPost', {
    requester: f.requester,
    title: f.title,
    spec: f.spec,
    specPrivate: f.specPrivate === true,
    category: f.category,
    bountyUsdc: f.bountyUsdc,
    deadline: BigInt(f.deadline as string),
    termsHash: f.termsHash,
    timestamp: BigInt(f.timestamp as number),
  });
  return { ...f, signature };
}

/** Post a fully-funded job; returns the DB job id. */
async function postFundedJob(seed: string, escrowJobId: bigint): Promise<number> {
  const body = await signedPost();
  const h = txHash(seed);
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(
      escrowJobId,
      parseUnits(body.bountyUsdc as string, 6),
      BigInt(body.deadline as string),
      body.termsHash as string,
    ),
  );
  const res = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 201);
  return res.body.jobId as number;
}

async function enrollWorkerWallet(
  account: ReturnType<typeof privateKeyToAccount>,
  agentId: bigint,
  target: Hono = app,
) {
  const message = {
    wallet: account.address,
    agentId,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(account, 'JobEnroll', message);
  return postJson(target, '/jobs/enroll', {
    wallet: account.address,
    agentId: agentId.toString(),
    timestamp: Number(message.timestamp),
    signature,
  });
}

async function claimJob(jobId: number, agentId: bigint, seed: string, target: Hono = app) {
  const h = txHash(seed);
  const listing = (await getJson(target, `/jobs/${jobId}`)).body.job as Record<string, unknown>;
  receipts.set(h.toLowerCase(), claimReceipt(BigInt(listing.escrowJobId as string), agentId));
  const message = {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobClaim', message);
  return postJson(target, `/jobs/${jobId}/claim`, {
    worker: worker.address,
    agentId: agentId.toString(),
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
}

// ---- test runner ----

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

// ---- config ----

await check('loadJobsConfig returns null when the escrow is unset', () => {
  assert.equal(loadJobsConfig({}), null);
});

await check('loadJobsConfig throws on a malformed escrow address', () => {
  assert.throws(() => loadJobsConfig({ FOUR02_BOUNTY_ESCROW: 'nope' }));
});

await check('loadJobsConfig defaults the listing fee to 0 (free at launch)', () => {
  const cfg = loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr });
  assert.ok(cfg);
  assert.equal(cfg.listingFeeUnits, 0n);
});

// ---- enrollment ----

await check('unsigned enroll -> 400 missing_signature', async () => {
  const res = await postJson(app, '/jobs/enroll', {
    wallet: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: nowSec(),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_signature');
});

await check('enroll with a bad signature -> 401', async () => {
  const res = await postJson(app, '/jobs/enroll', {
    wallet: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: nowSec(),
    signature: `0x${'ab'.repeat(65)}`,
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'bad_signature');
});

await check('enroll where ownerOf != wallet -> 403 identity_mismatch', async () => {
  owners.set(AGENT_ID.toString(), stranger.address); // registry says otherwise
  const res = await enrollWorkerWallet(worker, AGENT_ID);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'identity_mismatch');
});

await check('enroll with valid signature + ownerOf match -> 201, then GET worker', async () => {
  owners.set(AGENT_ID.toString(), worker.address);
  const res = await enrollWorkerWallet(worker, AGENT_ID);
  assert.equal(res.status, 201);
  assert.equal(res.body.wallet, worker.address);
  const got = await getJson(app, `/jobs/workers/${worker.address}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.agentId, AGENT_ID.toString());
});

await check('re-enroll is idempotent -> 200', async () => {
  const res = await enrollWorkerWallet(worker, AGENT_ID);
  assert.equal(res.status, 200);
});

// ---- posting ----

await check('unsigned post -> 400 missing_signature', async () => {
  const f = jobPostFields();
  const res = await postJson(app, '/jobs', { ...f, txHash: txHash('unsigned') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_signature');
});

await check('post with termsHash mismatch -> 400', async () => {
  // The signature is valid over the tampered termsHash — the failure must
  // come from the spec-hash check, not from signature verification.
  const body = await signedPost({ termsHash: `0x${'11'.repeat(32)}` });
  const res = await postJson(app, '/jobs', { ...body, txHash: txHash('terms-mismatch') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'terms_hash_mismatch');
});

await check('post with category security-audit -> 400 category_rejected', async () => {
  const body = await signedPost({ category: 'security-audit' });
  const res = await postJson(app, '/jobs', { ...body, txHash: txHash('sec-audit') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'category_rejected');
  assert.match(String(res.body.detail), /founder rule/);
});

await check('post with unknown category -> 400 invalid_category', async () => {
  const body = await signedPost({ category: 'plumbing' });
  const res = await postJson(app, '/jobs', { ...body, txHash: txHash('bad-cat') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_category');
});

await check('post with underfunded receipt -> 402 funding_invalid', async () => {
  const body = await signedPost();
  const h = txHash('underfunded');
  // Transfer of 1 unit but the listing claims 25 USDC.
  receipts.set(h.toLowerCase(), {
    status: 'success',
    logs: [
      transferLog(requester.address, escrowAddr, 1n),
      bountyCreatedLog(
        99n,
        requester.address,
        1n,
        BigInt(body.deadline as string),
        body.termsHash as string,
      ),
    ],
  });
  const res = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'funding_invalid');
});

await check('signed post + mocked funding receipt -> 201 + DB row + activity row', async () => {
  const before = activity.length;
  const jobId = await postFundedJob('post-1', 1n);
  assert.equal(jobId, 1);
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal(got.status, 200);
  const job = got.body.job as Record<string, unknown>;
  assert.equal(job.state, 'open');
  assert.equal(job.bountyUsdc, '25.00');
  assert.equal(job.escrowJobId, '1');
  assert.equal(activity.length, before + 1);
  assert.equal(activity[activity.length - 1]?.kind, 'posted');
});

await check('reusing the funding txHash for a second post -> 409', async () => {
  const body = await signedPost({ title: 'Second explainer' });
  const h = txHash('post-1'); // already burned by the first post
  const res = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'tx_hash_reused');
});

await check('board lists open jobs newest-first; filters work', async () => {
  const board = await getJson(app, '/jobs?status=open');
  assert.equal(board.status, 200);
  const jobs = board.body.jobs as unknown[];
  assert.ok(jobs.length >= 1);
  const bad = await getJson(app, '/jobs?status=bogus');
  assert.equal(bad.status, 400);
});

// ---- claiming ----

await check('claim by an unenrolled worker -> 403 not_enrolled', async () => {
  const jobId = await postFundedJob('post-2', 2n);
  owners.set('4242', stranger.address);
  const message = {
    jobId: BigInt(jobId),
    worker: stranger.address,
    agentId: 4242n,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(stranger, 'JobClaim', message);
  const res = await postJson(app, `/jobs/${jobId}/claim`, {
    worker: stranger.address,
    agentId: '4242',
    timestamp: Number(message.timestamp),
    signature,
    txHash: txHash('unenrolled-claim'),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_enrolled');
});

await check('claim with an agentId that is not the enrolled one -> 403', async () => {
  const jobId = await postFundedJob('post-3', 3n);
  owners.set('8', worker.address); // onchain it IS theirs, but not enrolled as such
  const message = {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId: 8n,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobClaim', message);
  const res = await postJson(app, `/jobs/${jobId}/claim`, {
    worker: worker.address,
    agentId: '8',
    timestamp: Number(message.timestamp),
    signature,
    txHash: txHash('bad-agent-claim'),
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'agent_not_enrolled');
});

await check('claim where ownerOf(agentId) != worker -> 403 identity_mismatch', async () => {
  // The worker IS enrolled with agent 7, but the registry mock now binds
  // agent 7 to a different wallet: the onchain re-check must refuse.
  owners.set(AGENT_ID.toString(), stranger.address);
  const jobId = await postFundedJob('post-4', 4n);
  const res = await claimJob(jobId, AGENT_ID, 'mismatch-claim');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'identity_mismatch');
  owners.set(AGENT_ID.toString(), worker.address); // restore
});

await check('valid claim -> 200 claimed; same-tx retry -> 409 tx_hash_reused', async () => {
  const jobId = await postFundedJob('post-5', 5n);
  const res = await claimJob(jobId, AGENT_ID, 'claim-5');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'claimed');
  const again = await claimJob(jobId, AGENT_ID, 'claim-5');
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'tx_hash_reused');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).workerAgentId, AGENT_ID.toString());
});

await check('claim is idempotent: re-claim with a fresh tx + same worker/agentId -> 200', async () => {
  const jobId = await postFundedJob('post-5c', 50n);
  const first = await claimJob(jobId, AGENT_ID, 'claim-5c');
  assert.equal(first.status, 200);
  // A second, distinct-but-valid claim mirror (e.g. after POST /jobs/:id/sync
  // bound the worker from chain) replays the same onchain truth: 200, no
  // state change, no conflict.
  const second = await claimJob(jobId, AGENT_ID, 'claim-5d');
  assert.equal(second.status, 200);
  assert.equal(second.body.state, 'claimed');
  assert.equal(second.body.worker, worker.address);
});

await check('claim with a conflicting worker+agentId -> 409 claim_conflict', async () => {
  const jobId = await postFundedJob('post-5e', 51n);
  const first = await claimJob(jobId, AGENT_ID, 'claim-5e');
  assert.equal(first.status, 200);
  // A verified BountyClaimed event binding a DIFFERENT worker contradicts the
  // mirrored row (impossible onchain — claimBounty cannot run twice — so this
  // is a canary, not a retry).
  const other = privateKeyToAccount(generatePrivateKey());
  const otherAgentId = 777001n;
  const h = txHash('claim-5f');
  receipts.set(
    h.toLowerCase(),
    claimReceipt(51n, otherAgentId, other.address),
  );
  const message = {
    jobId: BigInt(jobId),
    worker: other.address,
    agentId: otherAgentId,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(other, 'JobClaim', message);
  const res = await postJson(app, `/jobs/${jobId}/claim`, {
    worker: other.address,
    agentId: otherAgentId.toString(),
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'claim_conflict');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).worker, worker.address);
});

// ---- submit / accept happy path ----

async function submitDeliverable(jobId: number) {
  const contentHash = keccak256(toHex('the work'));
  const message = {
    jobId: BigInt(jobId),
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafytest',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobSubmit', message);
  return postJson(app, `/jobs/${jobId}/submit`, {
    jobId,
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafytest',
    timestamp: Number(message.timestamp),
    signature,
  });
}

await check('submit by a non-worker -> 403 not_the_worker', async () => {
  const jobId = await postFundedJob('post-6', 6n);
  const ok = await claimJob(jobId, AGENT_ID, 'claim-6');
  assert.equal(ok.status, 200);
  const contentHash = keccak256(toHex('hijack attempt'));
  const message = {
    jobId: BigInt(jobId),
    author: stranger.address,
    contentHash,
    uri: 'ipfs://evil',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(stranger, 'JobSubmit', message);
  const res = await postJson(app, `/jobs/${jobId}/submit`, {
    jobId,
    author: stranger.address,
    contentHash,
    uri: 'ipfs://evil',
    timestamp: Number(message.timestamp),
    signature,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_the_worker');
});

await check('happy path: claim -> submit -> accept -> complete', async () => {
  const jobId = await postFundedJob('post-7', 7n);
  const claimed = await claimJob(jobId, AGENT_ID, 'claim-7');
  assert.equal(claimed.status, 200);
  const submitted = await submitDeliverable(jobId);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.state, 'submitted');

  // Accept with a mocked release(escrowJobId) tx from the requester.
  const h = txHash('accept-7');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(7n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const accepted = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.state, 'complete');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'complete');
  assert.equal(activity[activity.length - 1]?.kind, 'completed');
});

await check('accept in the wrong state -> 409', async () => {
  const jobId = await postFundedJob('post-8', 8n); // still open
  const h = txHash('accept-8');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(8n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

await check('accept by a non-requester -> 403 not_the_requester', async () => {
  const jobId = await postFundedJob('post-9', 9n);
  await claimJob(jobId, AGENT_ID, 'claim-9');
  await submitDeliverable(jobId);
  const h = txHash('accept-9');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(9n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: stranger.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(stranger, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: stranger.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_the_requester');
});

await check('accept with a release tx for the wrong job -> 402 release_invalid', async () => {
  const jobId = await postFundedJob('post-10', 10n);
  await claimJob(jobId, AGENT_ID, 'claim-10');
  await submitDeliverable(jobId);
  const h = txHash('accept-10');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(999n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'release_invalid');
});

// ---- dispute path ----

async function raiseDispute(
  jobId: number,
  escrowJobId: bigint,
  byRequester: boolean,
  seed: string,
  target: Hono = app,
) {
  const signer = byRequester ? requester : worker;
  const h = txHash(seed);
  receipts.set(
    h.toLowerCase(),
    { status: 'success', logs: [disputeRaisedLog(escrowJobId, signer.address)] },
  );
  const message = {
    jobId: BigInt(jobId),
    requester: signer.address,
    decision: 'dispute',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(signer, 'JobDecision', message);
  return postJson(target, `/jobs/${jobId}/dispute`, {
    jobId,
    requester: signer.address,
    decision: 'dispute',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
}

await check('dispute path (requester, from submitted) -> disputed with disputedAt', async () => {
  const jobId = await postFundedJob('post-11', 11n);
  await claimJob(jobId, AGENT_ID, 'claim-11');
  await submitDeliverable(jobId);
  const res = await raiseDispute(jobId, 11n, true, 'dispute-11');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'disputed');
  assert.ok(typeof res.body.disputedAt === 'number');
  const got = await getJson(app, `/jobs/${jobId}`);
  const job = got.body.job as Record<string, unknown>;
  assert.equal(job.state, 'disputed');
  assert.ok(typeof job.disputedAt === 'number');
  assert.equal(activity[activity.length - 1]?.kind, 'disputed');
});

await check('dispute path (worker, from claimed) -> disputed', async () => {
  const jobId = await postFundedJob('post-12', 12n);
  await claimJob(jobId, AGENT_ID, 'claim-12');
  const res = await raiseDispute(jobId, 12n, false, 'dispute-12');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'disputed');
});

await check('dispute by a third party -> 403 not_a_party', async () => {
  const jobId = await postFundedJob('post-13', 13n);
  await claimJob(jobId, AGENT_ID, 'claim-13');
  const h = txHash('dispute-13');
  receipts.set(
    h.toLowerCase(),
    { status: 'success', logs: [disputeRaisedLog(13n, stranger.address)] },
  );
  const message = {
    jobId: BigInt(jobId),
    requester: stranger.address,
    decision: 'dispute',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(stranger, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/dispute`, {
    jobId,
    requester: stranger.address,
    decision: 'dispute',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_a_party');
});

await check('dispute on a completed job -> 409 wrong_state', async () => {
  const jobId = await postFundedJob('post-14', 14n);
  await claimJob(jobId, AGENT_ID, 'claim-14');
  await submitDeliverable(jobId);
  // accept it first
  const h = txHash('accept-14');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(14n)] });
  const amsg = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const asig = await sign(requester, 'JobDecision', amsg);
  const accepted = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(amsg.timestamp),
    signature: asig,
    txHash: h,
  });
  assert.equal(accepted.status, 200);
  const res = await raiseDispute(jobId, 14n, true, 'dispute-14');
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

await check('txHash replay on accept -> 409 tx_hash_reused', async () => {
  // Job A: full accept burns txHash h.
  const jobA = await postFundedJob('post-7r', 700n);
  await claimJob(jobA, AGENT_ID, 'claim-7r');
  await submitDeliverable(jobA);
  const h = txHash('accept-7r');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(700n)] });
  const msgA = {
    jobId: BigInt(jobA),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const sigA = await sign(requester, 'JobDecision', msgA);
  const accepted = await postJson(app, `/jobs/${jobA}/accept`, {
    jobId: jobA,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(msgA.timestamp),
    signature: sigA,
    txHash: h,
  });
  assert.equal(accepted.status, 200);
  // Job B is still submitted: replaying h against it must 409, not verify.
  const jobB = await postFundedJob('post-9r', 701n);
  await claimJob(jobB, AGENT_ID, 'claim-9r');
  await submitDeliverable(jobB);
  const got = await getJson(app, `/jobs/${jobB}`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'submitted');
  const message = {
    jobId: BigInt(jobB),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobB}/accept`, {
    jobId: jobB,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'tx_hash_reused');
});

// ---- history / activity ----

await check('GET /jobs/worker/:agentId/history returns DB jobs + mocked reputation', async () => {
  const res = await getJson(app, `/jobs/worker/${AGENT_ID}/history`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, AGENT_ID.toString());
  const jobs = res.body.jobs as unknown[];
  assert.ok(jobs.length >= 5, `expected several jobs, got ${jobs.length}`);
  const rep = res.body.reputation as Record<string, unknown>;
  assert.equal(rep.reliability, '95');
});

await check('GET /jobs/worker/:agentId/history omits panelEvents when no writer is configured', async () => {
  const res = await getJson(app, `/jobs/worker/${AGENT_ID}/history`);
  assert.equal(res.status, 200);
  assert.ok(
    !('panelEvents' in (res.body as Record<string, unknown>)),
    'panelEvents must be omitted without FOUR02_PANEL_WRITER',
  );
});

await check('GET /jobs/worker/:agentId/history includes panelEvents when the writer count is available', async () => {
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(jobsConfig(), {
      db: new JobsDb(':memory:'),
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      panelEventCount: async () => '3',
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  const res = await getJson(parent, `/jobs/worker/${AGENT_ID}/history`);
  assert.equal(res.status, 200);
  assert.equal(res.body.panelEvents, '3');
});

await check('GET /jobs/worker/:agentId/history stays 200 when the panel count RPC fails', async () => {
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(jobsConfig(), {
      db: new JobsDb(':memory:'),
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      panelEventCount: async () => {
        throw new Error('rpc down');
      },
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  const res = await getJson(parent, `/jobs/worker/${AGENT_ID}/history`);
  assert.equal(res.status, 200);
  assert.ok(
    !('panelEvents' in (res.body as Record<string, unknown>)),
    'fail-soft: RPC failure omits the field instead of 500ing',
  );
});

await check('job-activity flows into the lounge feed', async () => {
  const loungeDb = new LoungeDb(':memory:');
  const seen: JobActivityEvent[] = [];
  const parent = new Hono();
  const cfg = jobsConfig();
  const jobsApp = createJobsApp(cfg, {
    db: new JobsDb(':memory:'),
    getReceipt,
    getOnchainJob,
    identityOwner,
    reputationSummary,
    onActivity: (a) => {
      seen.push(a);
      loungeDb.logJobActivity({
        kind: a.kind,
        jobId: a.jobId,
        actor: a.actor,
        title: a.title,
        bountyUsdc: a.bountyUsdc,
        createdAt: nowSec(),
      });
    },
  });
  parent.route('/jobs', jobsApp);
  parent.route('/lounge', createLoungeApp(
    {
      treasury: requester.address,
      postFeeUsdc: '0.01',
      postFeeUnits: 10_000n,
      rpcUrl: 'http://localhost:1',
      dbPath: ':memory:',
    },
    { getReceipt, db: loungeDb },
  ));
  const jobId = await (async () => {
    const body = await signedPost({ title: 'Activity probe' });
    const h = txHash('activity-post');
    receipts.set(
      h.toLowerCase(),
      fundingReceipt(
        77n,
        parseUnits(body.bountyUsdc as string, 6),
        BigInt(body.deadline as string),
        body.termsHash as string,
      ),
    );
    const res = await postJson(parent, '/jobs', { ...body, txHash: h });
    assert.equal(res.status, 201);
    return res.body.jobId as number;
  })();
  void jobId;
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.kind, 'posted');
  const feed = await getJson(parent, '/lounge/job-activity?limit=20');
  assert.equal(feed.status, 200);
  const events = feed.body.events as { kind: string; title: string }[];
  assert.ok(events.length >= 1);
  assert.equal(events[0]?.kind, 'posted');
  assert.equal(events[0]?.title, 'Activity probe');
});

await check('GET /jobs/:id on a missing job -> 404', async () => {
  const res = await getJson(app, '/jobs/999999');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'job_not_found');
});

await check('submit on an open job -> 409 wrong_state', async () => {
  const jobId = await postFundedJob('post-15', 15n);
  const res = await submitDeliverable(jobId);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

// ---- DB state machine: resolve / refund (no v0 endpoints) ----

await check('db: disputed -> resolved; claimed -> refunded; wrong-state rejected', async () => {
  const db = new JobsDb(':memory:');
  const now = nowSec();
  const mk = () =>
    db.createListing({
      escrowJobId: '1',
      escrow: escrowAddr,
      requester: requester.address,
      title: 't',
      spec: 's',
      specHash: `0x${'00'.repeat(32)}`,
      category: 'code',
      bountyUsdc: '1.00',
      deadline: now + 3600,
      txHash: txHash(`db-${Math.random()}`),
      now,
    });
  const a = mk();
  assert.equal(a.ok, true);
  if (!a.ok) throw new Error('unreachable');
  const idA = a.id;
  assert.equal(db.claimJob(idA, worker.address, '7', txHash('db-claim-a'), now), 'ok');
  assert.equal(db.submitJob(idA, `0x${'00'.repeat(32)}`, 'ipfs://x', now), 'ok');
  assert.equal(db.disputeJob(idA, txHash('db-dispute-a'), now), 'ok');
  assert.equal(db.getJob(idA)?.state, 'disputed');
  assert.ok(typeof db.getJob(idA)?.disputedAt === 'number');
  assert.equal(db.resolveJob(idA, txHash('db-resolve-a'), now), 'ok');
  assert.equal(db.getJob(idA)?.state, 'resolved');
  assert.equal(db.refundJob(idA, txHash('db-refund-a'), now), 'wrong_state'); // resolved is terminal
  assert.equal(db.resolveJob(idA, txHash('db-resolve-a2'), now), 'wrong_state'); // resolve burns once

  const b = mk();
  assert.equal(b.ok, true);
  if (!b.ok) throw new Error('unreachable');
  const idB = b.id;
  assert.equal(db.claimJob(idB, worker.address, '7', txHash('db-claim-b'), now), 'ok');
  assert.equal(db.refundJob(idB, txHash('db-refund-b'), now), 'ok');
  assert.equal(db.getJob(idB)?.state, 'refunded');

  // open -> refunded is legal (unclaimed bounty refunded onchain); a
  // disputed job can never be refunded onchain, so the DB must refuse it.
  const cRow = mk();
  assert.equal(cRow.ok, true);
  if (!cRow.ok) throw new Error('unreachable');
  const idC = cRow.id;
  assert.equal(db.refundJob(idC, txHash('db-refund-c'), now), 'ok');
  assert.equal(db.getJob(idC)?.state, 'refunded');

  const d = mk();
  assert.equal(d.ok, true);
  if (!d.ok) throw new Error('unreachable');
  const idD = d.id;
  assert.equal(db.claimJob(idD, worker.address, '7', txHash('db-claim-d'), now), 'ok');
  assert.equal(db.disputeJob(idD, txHash('db-dispute-d'), now), 'ok');
  assert.equal(db.refundJob(idD, txHash('db-refund-d'), now), 'wrong_state'); // disputed can't refund
  db.close();
});

// ---- refund / resolve mirrors ----

async function postRefundTx(jobId: number, escrowJobId: bigint, seed: string) {
  const h = txHash(seed);
  receipts.set(h.toLowerCase(), {
    status: 'success',
    logs: [jobRefundedLog(escrowJobId)],
  });
  return postJson(app, `/jobs/${jobId}/refund`, { txHash: h });
}

async function postResolveTx(jobId: number, escrowJobId: bigint, seed: string) {
  const h = txHash(seed);
  receipts.set(h.toLowerCase(), {
    status: 'success',
    logs: [disputeResolvedLog(escrowJobId)],
  });
  return postJson(app, `/jobs/${jobId}/resolve`, { txHash: h });
}

await check('refund mirror: open job + JobRefunded event -> refunded', async () => {
  const before = activity.length;
  const jobId = await postFundedJob('post-20', 20n); // stays open (unclaimed)
  const res = await postRefundTx(jobId, 20n, 'refund-20');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'refunded');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'refunded');
  assert.equal(activity.length, before + 2); // posted + refunded
  assert.equal(activity[activity.length - 1]?.kind, 'refunded');
});

await check('refund mirror: claimed job (ghost path) -> refunded', async () => {
  const jobId = await postFundedJob('post-21', 21n);
  const claimed = await claimJob(jobId, AGENT_ID, 'claim-21');
  assert.equal(claimed.status, 200);
  const res = await postRefundTx(jobId, 21n, 'refund-21');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'refunded');
});

await check('refund mirror on a submitted job -> 409 (Delivered cannot refund onchain)', async () => {
  const jobId = await postFundedJob('post-22', 22n);
  await claimJob(jobId, AGENT_ID, 'claim-22');
  await submitDeliverable(jobId);
  const res = await postRefundTx(jobId, 22n, 'refund-22');
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

await check('refund mirror on a disputed job -> 409 (refund reverts from Disputed onchain)', async () => {
  const jobId = await postFundedJob('post-23', 23n);
  await claimJob(jobId, AGENT_ID, 'claim-23');
  const d = await raiseDispute(jobId, 23n, true, 'dispute-23');
  assert.equal(d.status, 200);
  const res = await postRefundTx(jobId, 23n, 'refund-23');
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

await check('refund mirror with a tx lacking the event -> 402 refund_invalid', async () => {
  const jobId = await postFundedJob('post-24', 24n);
  const h = txHash('refund-24-bad');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  const res = await postJson(app, `/jobs/${jobId}/refund`, { txHash: h });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'refund_invalid');
});

await check('refund mirror with an event for the wrong job -> 402 refund_invalid', async () => {
  const jobId = await postFundedJob('post-25', 25n);
  const res = await postRefundTx(jobId, 999n, 'refund-25-wrongjob');
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'refund_invalid');
});

await check('refund txHash replay -> 409 tx_hash_reused', async () => {
  const jobId = await postFundedJob('post-26', 26n);
  const h = txHash('refund-20'); // burned by the first refund mirror
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobRefundedLog(26n)] });
  const res = await postJson(app, `/jobs/${jobId}/refund`, { txHash: h });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'tx_hash_reused');
});

await check('resolve mirror: disputed + DisputeResolved event -> resolved', async () => {
  const before = activity.length;
  const jobId = await postFundedJob('post-27', 27n);
  await claimJob(jobId, AGENT_ID, 'claim-27');
  const d = await raiseDispute(jobId, 27n, false, 'dispute-27');
  assert.equal(d.status, 200);
  const res = await postResolveTx(jobId, 27n, 'resolve-27');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'resolved');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'resolved');
  assert.equal(activity.length, before + 4); // posted + claimed + disputed + resolved
  assert.equal(activity[activity.length - 1]?.kind, 'resolved');
});

await check('resolve mirror on a non-disputed job -> 409 wrong_state', async () => {
  const jobId = await postFundedJob('post-28', 28n); // open
  const res = await postResolveTx(jobId, 28n, 'resolve-28');
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

await check('resolve mirror with a tx lacking the event -> 402 resolve_invalid', async () => {
  const jobId = await postFundedJob('post-29', 29n);
  await claimJob(jobId, AGENT_ID, 'claim-29');
  await raiseDispute(jobId, 29n, true, 'dispute-29');
  const h = txHash('resolve-29-bad');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  const res = await postJson(app, `/jobs/${jobId}/resolve`, { txHash: h });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'resolve_invalid');
});

// ---- accept from claimed (worker delivered onchain, skipped API submit) ----

await check('accept mirrors a verified release even when API submit was skipped', async () => {
  const jobId = await postFundedJob('post-30', 30n);
  const claimed = await claimJob(jobId, AGENT_ID, 'claim-30');
  assert.equal(claimed.status, 200);
  // No submitDeliverable: the worker called confirmDelivery onchain directly.
  const h = txHash('accept-30');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(30n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'complete');
});

// ---- funding robustness ----

await check('post accepts when a LATER BountyCreated event fully matches (first is underfunded)', async () => {
  const body = await signedPost({ title: 'Batched funding' });
  const h = txHash('batched-funding');
  const amount = parseUnits(body.bountyUsdc as string, 6);
  const deadline = BigInt(body.deadline as string);
  const termsHash = body.termsHash as string;
  receipts.set(h.toLowerCase(), {
    status: 'success',
    logs: [
      transferLog(requester.address, escrowAddr, amount),
      // Sibling bounty in the same tx: same payer, underfunded -> skipped, not fatal.
      bountyCreatedLog(90n, requester.address, 1n, deadline, termsHash),
      bountyCreatedLog(91n, requester.address, amount, deadline, termsHash),
    ],
  });
  const res = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 201);
  const got = await getJson(app, `/jobs/${res.body.jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).escrowJobId, '91');
});

await check('post with deadline beyond uint64 -> 400 invalid_deadline', async () => {
  const body = await signedPost({ deadline: (2n ** 64n).toString() });
  const res = await postJson(app, '/jobs', { ...body, txHash: txHash('huge-deadline') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_deadline');
});

// ---- config ----

await check('loadJobsConfig honors FOUR02_REPUTATION_REGISTRY; malformed throws', () => {
  const v2 = getAddress('0x1111111111111111111111111111111111111111');
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_REPUTATION_REGISTRY: v2,
  });
  assert.ok(cfg);
  assert.equal(cfg.reputationRegistry, v2);
  const def = loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr });
  assert.ok(def);
  assert.equal(def.reputationRegistry, '0x33E2c56035C059553a37a3A56199B5b5b3DA3365');
  assert.throws(() =>
    loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr, FOUR02_REPUTATION_REGISTRY: 'nope' }),
  );
});



// ---- new audit findings (2026-09-26) ----

// Event-only verification: accept/dispute verify the escrow's OWN events,
// never tx.from — so multisig/smart-wallet parties (whose outer tx.from is
// a relayer or an EOA submitter) verify exactly like EOAs. The receipts
// below carry only logs; no transaction lookup exists anymore.

await check('accept verifies the JobReleased event alone (multisig-safe)', async () => {
  const jobId = await postFundedJob('post-40', 40n);
  await claimJob(jobId, AGENT_ID, 'claim-40');
  await submitDeliverable(jobId);
  const h = txHash('accept-40');
  // Only the event log — no transaction, no from-address anywhere.
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(40n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'complete');
});

await check('accept with a receipt lacking JobReleased -> 402 release_invalid', async () => {
  const jobId = await postFundedJob('post-41', 41n);
  await claimJob(jobId, AGENT_ID, 'claim-41');
  await submitDeliverable(jobId);
  const h = txHash('accept-41');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'release_invalid');
});

await check('dispute with DisputeRaised for the wrong job -> 402 dispute_invalid', async () => {
  const jobId = await postFundedJob('post-42', 42n);
  await claimJob(jobId, AGENT_ID, 'claim-42');
  const h = txHash('dispute-42');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [disputeRaisedLog(999n, worker.address)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'dispute',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/dispute`, {
    jobId,
    requester: requester.address,
    decision: 'dispute',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'dispute_invalid');
});

await check('dispute with DisputeRaised by someone else -> 402 dispute_invalid', async () => {
  const jobId = await postFundedJob('post-43', 43n);
  await claimJob(jobId, AGENT_ID, 'claim-43');
  const h = txHash('dispute-43');
  // The event binds the RAISER (topic), not tx.from: a raiser mismatch fails.
  receipts.set(
    h.toLowerCase(),
    { status: 'success', logs: [disputeRaisedLog(43n, stranger.address)] },
  );
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'dispute',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/${jobId}/dispute`, {
    jobId,
    requester: requester.address,
    decision: 'dispute',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'dispute_invalid');
});

// EIP-712: a signature for one primaryType is rejected at another endpoint.

await check('EIP-712 cross-type replay: JobClaim signature rejected at /submit', async () => {
  const jobId = await postFundedJob('post-44', 44n);
  await claimJob(jobId, AGENT_ID, 'claim-44');
  const contentHash = keccak256(toHex('the work'));
  const claimMsg = {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId: AGENT_ID,
    timestamp: BigInt(nowSec()),
  };
  const claimSig = await sign(worker, 'JobClaim', claimMsg);
  const res = await postJson(app, `/jobs/${jobId}/submit`, {
    jobId,
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafytest',
    timestamp: Number(claimMsg.timestamp),
    signature: claimSig, // wrong primaryType: JobClaim, not JobSubmit
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'bad_signature');
});

// ---- POST /jobs/:id/sync: DB <-> chain reconciliation ----

await check('sync: onchain Open -> no-op, no activity', async () => {
  const before = activity.length;
  const { jobId } = await postFixedJob('post-50', 50n);
  mockChainJob(50n, 1, { deadline: 1893456000, termsHash: keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex });
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, false);
  assert.equal(res.body.state, 'open');
  assert.equal(res.body.onchainState, 'open');
  assert.equal(activity.length, before + 1); // only the post
});

await check('sync: direct onchain claim binds worker+agentId; submit then works', async () => {
  const { jobId } = await postFixedJob('post-51', 51n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  mockChainJob(
    51n,
    2, // Funded
    { deadline: 1893456000, termsHash },
    { provider: worker.address, agentId: AGENT_ID },
  );
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, true);
  assert.equal(res.body.state, 'claimed');
  assert.equal(res.body.onchainState, 'funded');
  const got = await getJson(app, `/jobs/${jobId}`);
  const job = got.body.job as Record<string, unknown>;
  assert.equal(job.worker, worker.address);
  assert.equal(job.workerAgentId, AGENT_ID.toString());
  // The idempotent /claim path accepts the original claim tx without an
  // enrollment row (the sync->claim flow: the chain already proved identity).
  const h = txHash('claim-51');
  receipts.set(h.toLowerCase(), claimReceipt(51n, AGENT_ID));
  const message = {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId: AGENT_ID,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobClaim', message);
  const claim = await postJson(app, `/jobs/${jobId}/claim`, {
    worker: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.state, 'claimed');
  // The chain-bound worker can now submit through the API (the binding is real).
  const sub = await submitDeliverable(jobId);
  assert.equal(sub.status, 200);
});

await check('sync: direct onchain release -> complete', async () => {
  const before = activity.length;
  const { jobId } = await postFixedJob('post-52', 52n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  mockChainJob(
    52n,
    4, // Released
    { deadline: 1893456000, termsHash },
    { provider: worker.address, agentId: AGENT_ID },
  );
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, true);
  assert.equal(res.body.state, 'complete');
  assert.equal(activity.length, before + 2); // posted + completed
  assert.equal(activity[activity.length - 1]?.kind, 'completed');
});

await check('sync: onchain Delivered maps to claimed (no offchain metadata)', async () => {
  const { jobId } = await postFixedJob('post-53', 53n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  mockChainJob(
    53n,
    3, // Delivered
    { deadline: 1893456000, termsHash },
    { provider: worker.address, agentId: AGENT_ID },
  );
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, true);
  assert.equal(res.body.state, 'claimed');
  assert.equal(res.body.onchainState, 'delivered');
});

await check('sync: direct onchain dispute -> disputed, then resolve -> resolved', async () => {
  const { jobId } = await postFixedJob('post-54', 54n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  const fixed = { deadline: 1893456000, termsHash };
  mockChainJob(54n, 5, fixed, { provider: worker.address, agentId: AGENT_ID });
  const d = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(d.status, 200);
  assert.equal(d.body.state, 'disputed');
  mockChainJob(54n, 6, fixed, { provider: worker.address, agentId: AGENT_ID });
  const r = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.synced, true);
  assert.equal(r.body.state, 'resolved');
});

await check('sync: direct onchain refund from open (unclaimed) -> refunded', async () => {
  const { jobId } = await postFixedJob('post-55', 55n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  // provider stays zero: nobody ever claimed.
  mockChainJob(55n, 7, { deadline: 1893456000, termsHash });
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, true);
  assert.equal(res.body.state, 'refunded');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).worker, null);
});

await check('sync: unknown onchain job -> 503 sync_unavailable', async () => {
  const { jobId } = await postFixedJob('post-56', 56n);
  // No mockChainJob call: getOnchainJob returns null.
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'sync_unavailable');
});

await check('sync: terms mismatch -> 409 sync_mismatch', async () => {
  const { jobId } = await postFixedJob('post-57', 57n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  // Wrong amount onchain: the listing says 25.00 USDC.
  mockChainJob(
    57n,
    2,
    { deadline: 1893456000, termsHash },
    { provider: worker.address, agentId: AGENT_ID, amount: parseUnits('24.00', 6) },
  );
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'sync_mismatch');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'open');
});

await check('sync: wrong payer -> 409 sync_mismatch', async () => {
  const { jobId } = await postFixedJob('post-58', 58n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  mockChainJob(
    58n,
    2,
    { deadline: 1893456000, termsHash },
    { payer: stranger.address, provider: worker.address, agentId: AGENT_ID },
  );
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'sync_mismatch');
});

await check('sync: terminal row -> 409 wrong_state', async () => {
  const { jobId } = await postFixedJob('post-59', 59n);
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  const fixed = { deadline: 1893456000, termsHash };
  mockChainJob(59n, 4, fixed, { provider: worker.address, agentId: AGENT_ID });
  const first = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(first.body.state, 'complete');
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'wrong_state');
});

await check('sync: never rolls back (db ahead of chain)', async () => {
  const before = activity.length;
  const { jobId } = await postFixedJob('post-60', 60n);
  await claimJob(jobId, AGENT_ID, 'claim-60');
  const termsHash = keccak256(toHex('Write a 500-word explainer on x402 micropayments.')).toLowerCase() as Hex;
  // Chain says Open (e.g. a reorged-away claim, or a stale RPC): the DB must
  // NOT move backward.
  mockChainJob(60n, 1, { deadline: 1893456000, termsHash });
  const res = await postJson(app, `/jobs/${jobId}/sync`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, false);
  assert.equal(res.body.note, 'db_ahead_of_chain');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'claimed');
  assert.equal(activity.length, before + 2); // posted + claimed; the sync fired nothing
});

await check('sync: unknown job id -> 404', async () => {
  const res = await postJson(app, '/jobs/99999/sync', {});
  assert.equal(res.status, 404);
});

// ---- deadline precision: values above Number.MAX_SAFE_INTEGER are rejected ----

await check('post with deadline 2^53 -> 400 invalid_deadline', async () => {
  const body = await signedPost({ deadline: (2n ** 53n).toString() });
  const h = txHash('deadline-2p53');
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(
      61n,
      parseUnits('25.00', 6),
      2n ** 53n,
      body.termsHash as string,
    ),
  );
  const res = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_deadline');
});

// ---- stored XSS: submissionUri is escaped once revealed ----

async function submitDeliverableWithUri(jobId: number, uri: string) {
  const contentHash = keccak256(toHex('the work'));
  const message = {
    jobId: BigInt(jobId),
    author: worker.address,
    contentHash,
    uri,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobSubmit', message);
  return postJson(app, `/jobs/${jobId}/submit`, {
    jobId,
    author: worker.address,
    contentHash,
    uri,
    timestamp: Number(message.timestamp),
    signature,
  });
}

await check('completed submissionUri is HTML-escaped (stored XSS)', async () => {
  const jobId = await postFundedJob('post-62', 62n);
  await claimJob(jobId, AGENT_ID, 'claim-62');
  const evil = 'https://x"><script>alert(1)</script>';
  const sub = await submitDeliverableWithUri(jobId, evil);
  assert.equal(sub.status, 200);
  // Hidden before completion...
  const pre = await getJson(app, `/jobs/${jobId}`);
  assert.equal((pre.body.job as Record<string, unknown>).submissionUri, null);
  const h = txHash('accept-62');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(62n)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const accepted = await postJson(app, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(accepted.status, 200);
  const got = await getJson(app, `/jobs/${jobId}`);
  const uri = (got.body.job as Record<string, unknown>).submissionUri as string;
  assert.ok(!uri.includes('<script>'), 'raw script tag must not be rendered');
  assert.ok(uri.includes('&lt;script&gt;'), 'script tag must be escaped');
  assert.ok(uri.includes('&quot;'), 'quote must be escaped');
});

// ---- agentId zero is rejected (the escrow always reverts on it) ----

await check('enroll with agentId 0 -> 400 invalid_agent_id', async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const message = { wallet: acct.address, agentId: 0n, timestamp: BigInt(nowSec()) };
  const signature = await sign(acct, 'JobEnroll', message);
  const res = await postJson(app, '/jobs/enroll', {
    wallet: acct.address,
    agentId: '0',
    timestamp: Number(message.timestamp),
    signature,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_agent_id');
});

await check('claim with agentId 0 -> 400 invalid_agent_id', async () => {
  const jobId = await postFundedJob('post-63', 63n);
  const h = txHash('claim-63-zero');
  receipts.set(h.toLowerCase(), claimReceipt(63n, 0n));
  const message = {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId: 0n,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobClaim', message);
  const res = await postJson(app, `/jobs/${jobId}/claim`, {
    worker: worker.address,
    agentId: '0',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_agent_id');
});

// ---- body limit counts UTF-8 bytes, not UTF-16 code units ----

await check('body limit counts UTF-8 bytes (multibyte) -> 413', async () => {
  // 100k emoji = 200k UTF-16 code units (under the old unit count) but
  // 400k UTF-8 bytes (over the 256 KiB cap).
  const big = '🧪'.repeat(100_000);
  const res = await postJson(app, '/jobs/enroll', {
    wallet: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: nowSec(),
    signature: '0x',
    extra: big,
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, 'body_too_large');
});

await check('body limit control: 200k ASCII bytes stays under the cap', async () => {
  const ok = 'a'.repeat(200_000); // 200k bytes < 256 KiB
  const res = await postJson(app, '/jobs/enroll', {
    wallet: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: nowSec(),
    signature: '0x',
    extra: ok,
  });
  assert.notEqual(res.status, 413);
});

// ---- refund/resolve: invalid attempts must not burn the shared mirror budget ----

function makeStrictApp(): Hono {
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(jobsConfig(), {
      db: new JobsDb(':memory:'),
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      // Default production bucket: proves invalid attempts don't consume it.
    }),
  );
  return parent;
}

async function postFundedJobOn(
  target: Hono,
  seed: string,
  escrowJobId: bigint,
): Promise<number> {
  const body = await signedPost();
  const h = txHash(seed);
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(
      escrowJobId,
      parseUnits(body.bountyUsdc as string, 6),
      BigInt(body.deadline as string),
      body.termsHash as string,
    ),
  );
  const res = await postJson(target, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 201);
  return res.body.jobId as number;
}

await check('refund: malformed attempts do not burn the shared mirror budget', async () => {
  const strict = makeStrictApp();
  const jobId = await postFundedJobOn(strict, 'post-70', 70n); // open
  // 35 malformed attempts: 400 each, and none may consume the 30/min budget.
  for (let i = 0; i < 35; i++) {
    const r = await postJson(strict, `/jobs/${jobId}/refund`, { txHash: 'garbage' });
    assert.equal(r.status, 400);
  }
  // A valid mirror still succeeds (it would 429 if junk had burned budget).
  const h = txHash('refund-70');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobRefundedLog(70n)] });
  const res = await postJson(strict, `/jobs/${jobId}/refund`, { txHash: h });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'refunded');
});

await check('resolve: malformed attempts do not burn the shared mirror budget', async () => {
  const strict = makeStrictApp();
  const jobId = await postFundedJobOn(strict, 'post-71', 71n);
  await enrollWorkerWallet(worker, AGENT_ID, strict);
  await claimJob(jobId, AGENT_ID, 'claim-71', strict);
  const d = await raiseDispute(jobId, 71n, false, 'dispute-71', strict);
  assert.equal(d.status, 200);
  for (let i = 0; i < 35; i++) {
    const r = await postJson(strict, `/jobs/${jobId}/resolve`, { txHash: '0x1234' });
    assert.equal(r.status, 400);
  }
  const h = txHash('resolve-71');
  receipts.set(h.toLowerCase(), { status: 'success', logs: [disputeResolvedLog(71n)] });
  const res = await postJson(strict, `/jobs/${jobId}/resolve`, { txHash: h });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'resolved');
});

await check('default bucket still 429s when genuinely exhausted', async () => {
  const strict = makeStrictApp();
  const acct = privateKeyToAccount(generatePrivateKey());
  let last = 200;
  for (let i = 0; i < 31; i++) {
    const message = { wallet: acct.address, agentId: AGENT_ID, timestamp: BigInt(nowSec()) };
    const signature = await sign(acct, 'JobEnroll', message);
    const r = await postJson(strict, '/jobs/enroll', {
      wallet: acct.address,
      agentId: AGENT_ID.toString(),
      timestamp: Number(message.timestamp),
      signature,
    });
    last = r.status;
  }
  assert.equal(last, 429);
});

// ---- G1–G8: 2026-09-26 fix batch ----

// owners is the shared identity-registry mock: pin AGENT_ID to the worker
// wallet for the appended tests (each test below re-pins as needed).
owners.set(AGENT_ID.toString(), worker.address);

function freshJobsStack(
  env: Record<string, string | undefined> = {},
  extra: {
    ipRateLimitBucket?: { windowMs: number; max: number };
    deps?: Record<string, unknown>;
  } = {},
): { app: Hono; db: JobsDb } {
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1',
    ...env,
  });
  assert.ok(cfg);
  const db = new JobsDb(':memory:');
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(cfg, {
      db,
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      onActivity,
      // Generous author bucket: these tests exercise the NEW controls, not
      // the shared one (G6 passes its own small IP bucket explicitly).
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
      ...(extra.ipRateLimitBucket
        ? { ipRateLimitBucket: extra.ipRateLimitBucket }
        : {}),
      ...((extra.deps ?? {}) as Record<string, unknown>),
    }),
  );
  return { app: parent, db };
}

/** postFundedJob with target app + body overrides (e.g. specPrivate). */
async function postFundedJobOver(
  target: Hono,
  seed: string,
  escrowJobId: bigint,
  over: Record<string, unknown> = {},
): Promise<number> {
  const body = await signedPost(over);
  const h = txHash(seed);
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(
      escrowJobId,
      parseUnits(body.bountyUsdc as string, 6),
      BigInt(body.deadline as string),
      body.termsHash as string,
    ),
  );
  const res = await postJson(target, '/jobs', { ...body, txHash: h });
  assert.equal(res.status, 201);
  return res.body.jobId as number;
}

async function postJsonHeaders(
  target: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string>,
) {
  const res = await target.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Seed a listing straight into the DB (bypasses HTTP/onchain ceremony). */
function seedListing(
  db: JobsDb,
  o: { requester: string; seed: string; escrowJobId: string; now: number },
): number {
  const res = db.createListing({
    escrowJobId: o.escrowJobId,
    escrow: escrowAddr,
    requester: getAddress(o.requester),
    title: 'Seeded job',
    spec: 'seeded spec',
    specHash: keccak256(toHex('seeded spec')),
    category: 'writing',
    bountyUsdc: '1.00',
    deadline: o.now + 86400,
    txHash: txHash(o.seed),
    now: o.now,
  });
  assert.ok(res.ok);
  return (res as { ok: true; id: number }).id;
}

// ---- G1: requester concentration on the resume ----

await check('G1: history returns uniqueRequesters + per-requester job counts', async () => {
  const { app: a1, db: d1 } = freshJobsStack();
  const r2 = privateKeyToAccount(generatePrivateKey());
  const now = nowSec();
  for (const [req, seed] of [
    [requester.address, 'g1-a'],
    [requester.address, 'g1-b'],
    [r2.address, 'g1-c'],
  ] as const) {
    const id = seedListing(d1, { requester: req, seed, escrowJobId: `g1-${seed}`, now });
    assert.equal(d1.claimJob(id, worker.address, AGENT_ID.toString(), txHash(`${seed}-claim`), now), 'ok');
  }
  const res = await getJson(a1, `/jobs/worker/${AGENT_ID}/history`);
  assert.equal(res.status, 200);
  assert.equal(res.body.uniqueRequesters, 2);
  const byReq = res.body.jobsByRequester as Record<string, number>;
  assert.equal(byReq[getAddress(requester.address)], 2);
  assert.equal(byReq[getAddress(r2.address)], 1);
  assert.equal((res.body.jobs as unknown[]).length, 3);
});

// ---- G2: identity-transfer halo ----

await check('G2: ownershipChanged when a finished job predates the current owner', async () => {
  const { app: a2, db: d2 } = freshJobsStack();
  const now = nowSec();
  const id = seedListing(d2, { requester: requester.address, seed: 'g2-a', escrowJobId: 'g2-a', now });
  assert.equal(d2.claimJob(id, worker.address, AGENT_ID.toString(), txHash('g2-a-claim'), now), 'ok');
  assert.equal(d2.acceptJob(id, txHash('g2-a-accept'), now), 'ok'); // complete
  const newOwner = privateKeyToAccount(generatePrivateKey());
  owners.set(AGENT_ID.toString(), newOwner.address);
  try {
    const res = await getJson(a2, `/jobs/worker/${AGENT_ID}/history`);
    assert.equal(res.status, 200);
    assert.equal(res.body.currentOwner, getAddress(newOwner.address));
    assert.equal(res.body.ownershipChanged, true);
  } finally {
    owners.set(AGENT_ID.toString(), worker.address);
  }
});

await check('G2: no halo when the owner did the work; refunded/ghosted jobs excluded', async () => {
  const { app: a2b, db: d2b } = freshJobsStack();
  const now = nowSec();
  owners.set(AGENT_ID.toString(), worker.address);
  // completed by the current owner -> no halo
  const id = seedListing(d2b, { requester: requester.address, seed: 'g2-b', escrowJobId: 'g2-b', now });
  assert.equal(d2b.claimJob(id, worker.address, AGENT_ID.toString(), txHash('g2-b-claim'), now), 'ok');
  assert.equal(d2b.acceptJob(id, txHash('g2-b-accept'), now), 'ok');
  // refunded (ghosted) by a DIFFERENT wallet -> must not count as finished work
  const id2 = seedListing(d2b, { requester: requester.address, seed: 'g2-c', escrowJobId: 'g2-c', now });
  const ghost = privateKeyToAccount(generatePrivateKey());
  assert.equal(d2b.claimJob(id2, ghost.address, AGENT_ID.toString(), txHash('g2-c-claim'), now), 'ok');
  assert.equal(d2b.refundJob(id2, txHash('g2-c-refund'), now), 'ok');
  const res = await getJson(a2b, `/jobs/worker/${AGENT_ID}/history`);
  assert.equal(res.status, 200);
  assert.equal(res.body.currentOwner, getAddress(worker.address));
  assert.equal(res.body.ownershipChanged, false);
});

await check('G2: registry outage -> currentOwner null, ownershipChanged false (no false halo)', async () => {
  const { app: a2c } = freshJobsStack();
  owners.delete(AGENT_ID.toString());
  try {
    const res = await getJson(a2c, `/jobs/worker/${AGENT_ID}/history`);
    assert.equal(res.status, 200);
    assert.equal(res.body.currentOwner, null);
    assert.equal(res.body.ownershipChanged, false);
  } finally {
    owners.set(AGENT_ID.toString(), worker.address);
  }
});

// ---- G3: per-requester daily post cap ----

await check('G3: posting beyond JOBS_DAILY_POST_CAP -> 429 daily_post_cap_exceeded', async () => {
  const { app: a3 } = freshJobsStack({ JOBS_DAILY_POST_CAP: '2' });
  await postFundedJobOver(a3, 'g3-a', 301n);
  await postFundedJobOver(a3, 'g3-b', 302n);
  const body = await signedPost({ title: 'third post' });
  const h = txHash('g3-c');
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(303n, parseUnits('25.00', 6), BigInt(body.deadline as string), body.termsHash as string),
  );
  const r = await postJson(a3, '/jobs', { ...body, txHash: h });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'daily_post_cap_exceeded');
});

await check('G3: config defaults the cap to 50; malformed values throw', () => {
  const def = loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr });
  assert.ok(def);
  assert.equal(def.dailyPostCap, 50);
  assert.throws(() =>
    loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr, JOBS_DAILY_POST_CAP: 'many' }),
  );
  assert.throws(() =>
    loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr, JOBS_DAILY_POST_CAP: '0' }),
  );
});

// ---- G4: spec privacy ----

await check('G4: private spec hidden on board/detail, specHash kept', async () => {
  const body = await signedPost({ specPrivate: true, title: 'Private brief' });
  const h = txHash('g4-priv');
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(401n, parseUnits('25.00', 6), BigInt(body.deadline as string), body.termsHash as string),
  );
  const pr = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(pr.status, 201);
  const jobId = pr.body.jobId as number;

  const board = await getJson(app, '/jobs?limit=100');
  const row = (board.body.jobs as Record<string, unknown>[]).find((j) => j.id === jobId);
  assert.ok(row, 'job on board');
  assert.equal(row.spec, null);
  assert.equal(row.specPrivate, true);
  assert.equal(row.specHash, (body.termsHash as string).toLowerCase());

  const det = await getJson(app, `/jobs/${jobId}`);
  assert.equal((det.body.job as Record<string, unknown>).spec, null);
  assert.equal((det.body.job as Record<string, unknown>).specPrivate, true);
});

await check('G4: specPrivate must be a boolean when present', async () => {
  const body = await signedPost({ specPrivate: 'yes', title: 'Bad flag' });
  const res = await postJson(app, '/jobs', { ...body, txHash: txHash('g4-badflag') });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_spec_private');
});

await check('G4: flipping specPrivate in transit invalidates the signature', async () => {
  // Sign a PRIVATE listing, then flip the flag to public on the wire.
  const priv = await signedPost({ specPrivate: true, title: 'Tamper target' });
  const flipToPublic = await postJson(app, '/jobs', {
    ...priv,
    specPrivate: false,
    txHash: txHash('g4-tamper-public'),
  });
  assert.equal(flipToPublic.status, 401);

  // And the reverse: sign public, flip to private.
  const pub = await signedPost({ specPrivate: false, title: 'Tamper target 2' });
  const flipToPrivate = await postJson(app, '/jobs', {
    ...pub,
    specPrivate: true,
    txHash: txHash('g4-tamper-private'),
  });
  assert.equal(flipToPrivate.status, 401);
});

async function specAccess(
  target: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  jobId: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const message = {
    jobId: BigInt(jobId),
    accessor: account.address,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(account, 'JobSpecAccess', message);
  return postJson(target, `/jobs/${jobId}/spec`, {
    jobId,
    accessor: account.address,
    timestamp: Number(message.timestamp),
    signature,
  });
}

await check('G4: /spec serves the requester, 403s strangers, 401s bad signatures', async () => {
  const body = await signedPost({ specPrivate: true, title: 'Gated brief' });
  const h = txHash('g4-gate');
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(402n, parseUnits('25.00', 6), BigInt(body.deadline as string), body.termsHash as string),
  );
  const pr = await postJson(app, '/jobs', { ...body, txHash: h });
  assert.equal(pr.status, 201);
  const jobId = pr.body.jobId as number;

  // stranger -> 403
  const s = await specAccess(app, stranger, jobId);
  assert.equal(s.status, 403);
  assert.equal(s.body.error, 'not_authorized');

  // requester -> 200 with the full spec
  const r = await specAccess(app, requester, jobId);
  assert.equal(r.status, 200);
  assert.equal(r.body.spec, body.spec);

  // wrong signer for the claimed accessor -> 401
  const message = {
    jobId: BigInt(jobId),
    accessor: requester.address,
    timestamp: BigInt(nowSec()),
  };
  const forged = await sign(stranger, 'JobSpecAccess', message);
  const f = await postJson(app, `/jobs/${jobId}/spec`, {
    jobId,
    accessor: requester.address,
    timestamp: Number(message.timestamp),
    signature: forged,
  });
  assert.equal(f.status, 401);
  assert.equal(f.body.error, 'bad_signature');

  // claimed worker -> 200
  owners.set(AGENT_ID.toString(), worker.address);
  const er = await enrollWorkerWallet(worker, AGENT_ID);
  assert.ok(er.status === 201 || er.status === 200);
  const cr = await claimJob(jobId, AGENT_ID, 'claim-g4');
  assert.equal(cr.status, 200);
  const w = await specAccess(app, worker, jobId);
  assert.equal(w.status, 200);
  assert.equal(w.body.spec, body.spec);
});

await check('G4: spec_private migrates onto pre-existing DBs (default public)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const p = `${tmpdir()}/jobs-migrate-${Date.now()}-${process.pid}.db`;
  const old = new DatabaseSync(p);
  old.exec(
    `CREATE TABLE job_listings (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       escrow_job_id TEXT NOT NULL, escrow TEXT NOT NULL, requester TEXT NOT NULL,
       worker TEXT, worker_agent_id TEXT, title TEXT NOT NULL, spec TEXT NOT NULL,
       spec_hash TEXT NOT NULL, category TEXT NOT NULL, bounty_usdc TEXT NOT NULL,
       deadline INTEGER NOT NULL, state TEXT NOT NULL, submission_hash TEXT,
       submission_uri TEXT, disputed_at INTEGER, created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  );
  old.close();
  const migrated = new JobsDb(p);
  try {
    const res = migrated.createListing({
      escrowJobId: 'g4m',
      escrow: escrowAddr,
      requester: getAddress(requester.address),
      title: 't',
      spec: 's',
      specHash: keccak256(toHex('s')),
      category: 'writing',
      bountyUsdc: '1.00',
      deadline: nowSec() + 100,
      txHash: txHash('g4-mig'),
      now: nowSec(),
    });
    assert.ok(res.ok);
    const got = migrated.getJob((res as { ok: true; id: number }).id);
    assert.equal(got?.specPrivate, false);
    // and the new column is writable on the migrated table
    const res2 = migrated.createListing({
      escrowJobId: 'g4m2',
      escrow: escrowAddr,
      requester: getAddress(requester.address),
      title: 't',
      spec: 's',
      specPrivate: true,
      specHash: keccak256(toHex('s')),
      category: 'writing',
      bountyUsdc: '1.00',
      deadline: nowSec() + 100,
      txHash: txHash('g4-mig2'),
      now: nowSec(),
    });
    assert.ok(res2.ok);
    assert.equal(migrated.getJob((res2 as { ok: true; id: number }).id)?.specPrivate, true);
  } finally {
    migrated.close();
  }
});

// ---- G5: superseded-registry warning ----

await check('G5: default (V1) registry logs a loud warning at config load', () => {
  const orig = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr });
  } finally {
    console.warn = orig;
  }
  assert.ok(
    lines.some(
      (l) =>
        l.includes('SUPERSEDED') &&
        l.includes('0x33E2c56035C059553a37a3A56199B5b5b3DA3365') &&
        l.includes('all-zeros'),
    ),
    `expected loud warning, got: ${lines.join(' | ')}`,
  );
});

await check('G5: no warning when a non-V1 registry is configured', () => {
  const orig = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    loadJobsConfig({
      FOUR02_BOUNTY_ESCROW: escrowAddr,
      FOUR02_REPUTATION_REGISTRY: '0x0000000000000000000000000000000000000001',
    });
  } finally {
    console.warn = orig;
  }
  assert.equal(lines.length, 0);
});

// ---- G6: per-IP rate limiting ----

await check('G6: per-IP bucket 429s enroll spam from fresh wallets behind one IP', async () => {
  const { app: a6 } = freshJobsStack({}, { ipRateLimitBucket: { windowMs: 60_000, max: 2 } });
  const ip = { 'x-forwarded-for': '203.0.113.9' };
  const enroll = async (seed: number) => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const agentId = 1000n + BigInt(seed);
    owners.set(agentId.toString(), acct.address);
    const message = { wallet: acct.address, agentId, timestamp: BigInt(nowSec()) };
    const signature = await sign(acct, 'JobEnroll', message);
    return postJsonHeaders(a6, '/jobs/enroll', {
      wallet: acct.address,
      agentId: agentId.toString(),
      timestamp: Number(message.timestamp),
      signature,
    }, ip);
  };
  assert.equal((await enroll(1)).status, 201);
  assert.equal((await enroll(2)).status, 201);
  const third = await enroll(3);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'rate_limited');
  // a different IP is unaffected (per-IP granularity, not a global brake)
  owners.set('9999', stranger.address);
  const otherMsg = { wallet: stranger.address, agentId: 9999n, timestamp: BigInt(nowSec()) };
  const other = await postJsonHeaders(a6, '/jobs/enroll', {
    wallet: stranger.address,
    agentId: '9999',
    timestamp: Number(otherMsg.timestamp),
    signature: await sign(stranger, 'JobEnroll', otherMsg),
  }, { 'x-forwarded-for': '203.0.113.10' });
  assert.equal(other.status, 201);
  owners.delete('9999');
});

await check('G6: per-IP bucket 429s post spam behind one IP', async () => {
  const { app: a6b } = freshJobsStack({}, { ipRateLimitBucket: { windowMs: 60_000, max: 2 } });
  const ip = { 'x-forwarded-for': '203.0.113.11' };
  const postOne = async (seed: string, escrowJobId: bigint) => {
    const body = await signedPost();
    const h = txHash(seed);
    receipts.set(
      h.toLowerCase(),
      fundingReceipt(escrowJobId, parseUnits('25.00', 6), BigInt(body.deadline as string), body.termsHash as string),
    );
    const res = await a6b.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ip },
      body: JSON.stringify({ ...body, txHash: h }),
    });
    return res.status;
  };
  assert.equal(await postOne('g6-a', 501n), 201);
  assert.equal(await postOne('g6-b', 502n), 201);
  assert.equal(await postOne('g6-c', 503n), 429);
});

// ---- G7: submissionUri scheme allowlist ----

await check('G7: submit rejects non-allowlisted URI schemes', async () => {
  const jobId = await postFundedJob('post-g7', 601n);
  const ok = await claimJob(jobId, AGENT_ID, 'claim-g7');
  assert.equal(ok.status, 200);
  for (const badUri of [
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/work.zip',
    'file:///etc/passwd',
    'JAVASCRIPT:alert(1)',
  ]) {
    const contentHash = keccak256(toHex('the work'));
    const message = {
      jobId: BigInt(jobId),
      author: worker.address,
      contentHash,
      uri: badUri,
      timestamp: BigInt(nowSec()),
    };
    const signature = await sign(worker, 'JobSubmit', message);
    const res = await postJson(app, `/jobs/${jobId}/submit`, {
      jobId,
      author: worker.address,
      contentHash,
      uri: badUri,
      timestamp: Number(message.timestamp),
      signature,
    });
    assert.equal(res.status, 400, badUri);
    assert.equal(res.body.error, 'invalid_uri_scheme');
  }
});

await check('G7: submit still accepts https/http/ipfs URIs (case-insensitive)', async () => {
  for (const [seed, escrowJobId, goodUri] of [
    ['post-g7b', 602n, 'https://example.com/work.zip'],
    ['post-g7c', 603n, 'HTTPS://EXAMPLE.COM/WORK.ZIP'],
    ['post-g7d', 604n, 'http://example.com/work.zip'],
  ] as const) {
    const jobId = await postFundedJob(seed, escrowJobId);
    const ok = await claimJob(jobId, AGENT_ID, `claim-${seed}`);
    assert.equal(ok.status, 200);
    const contentHash = keccak256(toHex('the work'));
    const message = {
      jobId: BigInt(jobId),
      author: worker.address,
      contentHash,
      uri: goodUri,
      timestamp: BigInt(nowSec()),
    };
    const signature = await sign(worker, 'JobSubmit', message);
    const res = await postJson(app, `/jobs/${jobId}/submit`, {
      jobId,
      author: worker.address,
      contentHash,
      uri: goodUri,
      timestamp: Number(message.timestamp),
      signature,
    });
    assert.equal(res.status, 200, goodUri);
  }
});

// ---- G8: seat gate ----

// ---- TRACES seat gate: onchain verification at enroll, claim, payout ----

const SEAT_ID = 11n;
// Controllable mock for the live pairing check (prod uses a viem client).
let seatVerdict: SeatPairingCheck = { ok: true };
const verifySeatPairing: VerifySeatPairing = async () => seatVerdict;

function seatStack(): { app: Hono; db: JobsDb } {
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1',
    JOBS_SEATS_REQUIRED: '1',
    FOUR02_TRACES_SEAT: '0x00000000000000000000000000000000000000ea',
    JOBS_DAILY_POST_CAP: '10000',
  });
  assert.ok(cfg);
  const db = new JobsDb(':memory:');
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(cfg, {
      db,
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      onActivity,
      verifySeatPairing,
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  return { app: parent, db };
}

async function enrollSeat(target: Hono, seatId: bigint | null) {
  const message = {
    wallet: worker.address,
    agentId: AGENT_ID,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobEnroll', message);
  const body: Record<string, unknown> = {
    wallet: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: Number(message.timestamp),
    signature,
  };
  if (seatId !== null) body.seatTokenId = seatId.toString();
  return postJson(target, '/jobs/enroll', body);
}

async function submitOn(target: Hono, jobId: number) {
  const contentHash = keccak256(toHex('the work'));
  const message = {
    jobId: BigInt(jobId),
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafytest',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobSubmit', message);
  return postJson(target, `/jobs/${jobId}/submit`, {
    jobId,
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafytest',
    timestamp: Number(message.timestamp),
    signature,
  });
}

async function acceptOn(target: Hono, jobId: number, escrowJobId: bigint, seed: string) {
  const h = txHash(seed);
  receipts.set(h.toLowerCase(), { status: 'success', logs: [jobReleasedLog(escrowJobId)] });
  const message = {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  return postJson(target, `/jobs/${jobId}/accept`, {
    jobId,
    requester: requester.address,
    decision: 'accept',
    timestamp: Number(message.timestamp),
    signature,
    txHash: h,
  });
}

await check('G8: JOBS_SEATS_REQUIRED=1 -> claim without a seat fails closed', async () => {
  const { app: a8, db: d8 } = freshJobsStack(
    {
      JOBS_SEATS_REQUIRED: '1',
      FOUR02_TRACES_SEAT: '0x00000000000000000000000000000000000000ea',
    },
    { deps: { verifySeatPairing } },
  );
  owners.set(AGENT_ID.toString(), worker.address);
  const jobId = await postFundedJobOver(a8, 'g8-a', 701n);
  // Enrollment WITHOUT a seat (e.g. enrolled before seats were required):
  // the claim-time gate must still fail closed.
  d8.enrollWorker({
    wallet: getAddress(worker.address),
    agentId: AGENT_ID.toString(),
    now: nowSec(),
  });
  const cr = await claimJob(jobId, AGENT_ID, 'claim-g8-a', a8);
  assert.equal(cr.status, 403);
  assert.equal(cr.body.error, 'seat_required');
});

await check('G8: claim with a seat succeeds and the seat survives re-verification', async () => {
  const { app: a8b, db: d8b } = freshJobsStack(
    {
      JOBS_SEATS_REQUIRED: 'true',
      FOUR02_TRACES_SEAT: '0x00000000000000000000000000000000000000ea',
    },
    { deps: { verifySeatPairing } },
  );
  seatVerdict = { ok: true };
  owners.set(AGENT_ID.toString(), worker.address);
  const jobId = await postFundedJobOver(a8b, 'g8-b', 702n);
  d8b.enrollWorker({
    wallet: getAddress(worker.address),
    agentId: AGENT_ID.toString(),
    seatTokenId: '42',
    now: nowSec(),
  });
  const cr = await claimJob(jobId, AGENT_ID, 'claim-g8-b', a8b);
  assert.equal(cr.status, 200);
  // the claim-time re-verification must not wipe the seat (fail-closed gate
  // would brick the worker on their NEXT claim otherwise)
  assert.equal(d8b.getWorker(worker.address)?.seatTokenId, '42');
  assert.equal(d8b.getJob(jobId)?.workerSeatId, '42');
});

await check('G8: seat gate defaults off (existing claim flow unchanged)', () => {
  const cfg = loadJobsConfig({ FOUR02_BOUNTY_ESCROW: escrowAddr });
  assert.ok(cfg);
  assert.equal(cfg.seatsRequired, false);
});

await check('seat: startup fails closed when seatsRequired without a seat contract', () => {
  assert.throws(
    () =>
      loadJobsConfig({
        FOUR02_BOUNTY_ESCROW: escrowAddr,
        JOBS_SEATS_REQUIRED: '1',
      }),
    /FOUR02_TRACES_SEAT/,
  );
});

await check('seat: enroll requires seatTokenId when seatsRequired', async () => {
  const { app: s } = seatStack();
  seatVerdict = { ok: true };
  const res = await enrollSeat(s, null);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'seat_required');
});

await check('seat: enroll verifies the pairing live onchain', async () => {
  const { app: s } = seatStack();
  seatVerdict = { ok: false, reason: 'seat_wallet_mismatch' };
  const badRes = await enrollSeat(s, SEAT_ID);
  assert.equal(badRes.status, 403);
  assert.equal(badRes.body.error, 'seat_ineligible');
  assert.equal(badRes.body.detail, 'seat_wallet_mismatch');
  seatVerdict = { ok: true };
  const good = await enrollSeat(s, SEAT_ID);
  assert.equal(good.status, 201);
  const w = await getJson(s, `/jobs/workers/${worker.address}`);
  assert.equal((w.body as Record<string, unknown>).seatTokenId, '11');
});

await check('seat: enroll 503s when the pairing check is unavailable', async () => {
  const { app: s } = seatStack();
  seatVerdict = { ok: false, reason: 'seat_check_unavailable' };
  const res = await enrollSeat(s, SEAT_ID);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'seat_check_unavailable');
  seatVerdict = { ok: true };
});

await check('seat: claim re-verifies live, stores seat, enforces per-seat cap', async () => {
  const { app: s, db } = seatStack();
  seatVerdict = { ok: true };
  const e = await enrollSeat(s, SEAT_ID);
  assert.equal(e.status, 201);
  const job1 = await postFundedJobOn(s, 'seat-claim-1', 501n);
  const c1 = await claimJob(job1, AGENT_ID, 'seat-claim-tx-1', s);
  assert.equal(c1.status, 200);
  assert.equal(db.getJob(job1)?.workerSeatId, '11');
  assert.equal(db.countActiveJobsForSeat('11'), 1);
  // Same seat, second job: default cap is 1 -> 403 seat_job_cap.
  const job2 = await postFundedJobOn(s, 'seat-claim-2', 502n);
  const c2 = await claimJob(job2, AGENT_ID, 'seat-claim-tx-2', s);
  assert.equal(c2.status, 403);
  assert.equal(c2.body.error, 'seat_job_cap');
});

await check('seat: claim fails when the pairing lapses after enroll', async () => {
  const { app: s } = seatStack();
  seatVerdict = { ok: true };
  const e = await enrollSeat(s, SEAT_ID);
  assert.equal(e.status, 201);
  // Seat transferred / re-paired after enrollment: the DB row still says
  // 11, but the live check must reject — never trust the row.
  seatVerdict = { ok: false, reason: 'pairing_mismatch' };
  const job = await postFundedJobOn(s, 'seat-claim-3', 503n);
  const c = await claimJob(job, AGENT_ID, 'seat-claim-tx-3', s);
  assert.equal(c.status, 403);
  assert.equal(c.body.error, 'seat_ineligible');
  seatVerdict = { ok: true };
});

await check('seat: accept re-verifies at payout; lapsed seat blocks attestation', async () => {
  const { app: s, db } = seatStack();
  seatVerdict = { ok: true };
  const e = await enrollSeat(s, SEAT_ID);
  assert.equal(e.status, 201);
  const job = await postFundedJobOn(s, 'seat-claim-4', 504n);
  const c = await claimJob(job, AGENT_ID, 'seat-claim-tx-4', s);
  assert.equal(c.status, 200);
  const sub = await submitOn(s, job);
  assert.equal(sub.status, 200);
  // Seat sold mid-job: the payout attestation must refuse.
  seatVerdict = { ok: false, reason: 'seat_wallet_mismatch' };
  const a1 = await acceptOn(s, job, 504n, 'seat-accept-tx-1');
  assert.equal(a1.status, 403);
  assert.equal(a1.body.error, 'seat_ineligible');
  assert.equal(db.getJob(job)?.state, 'submitted');
  // Seat restored: payout attests.
  seatVerdict = { ok: true };
  const a2 = await acceptOn(s, job, 504n, 'seat-accept-tx-2');
  assert.equal(a2.status, 200);
  assert.equal(a2.body.state, 'complete');
  // Completed job frees the seat for the next claim.
  assert.equal(db.countActiveJobsForSeat('11'), 0);
});

await check('seat: idempotent re-claim preserves the stored seat', async () => {
  const { app: s, db } = seatStack();
  seatVerdict = { ok: true };
  const e = await enrollSeat(s, SEAT_ID);
  assert.equal(e.status, 201);
  const job = await postFundedJobOn(s, 'seat-claim-5', 505n);
  const c1 = await claimJob(job, AGENT_ID, 'seat-claim-tx-5a', s);
  assert.equal(c1.status, 200);
  assert.equal(db.getJob(job)?.workerSeatId, '11');
  // Idempotent re-claim with a fresh tx hash: the seat must survive.
  const c2 = await claimJob(job, AGENT_ID, 'seat-claim-tx-5b', s);
  assert.equal(c2.status, 200);
  assert.equal(db.getJob(job)?.workerSeatId, '11');
});

// ---- "My Jobs" (GET /jobs/mine) ----

await check('mine: 400 on a malformed wallet', async () => {
  const res = await getJson(app, '/jobs/mine?wallet=nope');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_wallet');
});

await check('mine: empty for a wallet with no jobs', async () => {
  const res = await getJson(app, `/jobs/mine?wallet=${stranger.address}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.jobs, []);
});

await check('mine: requester and worker roles', async () => {
  const jobId = await postFundedJob('mine-1', 9001n);
  const asRequester = await getJson(app, `/jobs/mine?wallet=${requester.address}`);
  assert.equal(asRequester.status, 200);
  const mine = (asRequester.body.jobs as Record<string, unknown>[]).find(
    (j) => j.id === jobId,
  );
  assert.ok(mine, 'posted job appears in /mine');
  assert.equal(mine.role, 'requester');

  owners.set(AGENT_ID.toString(), worker.address);
  const er = await enrollWorkerWallet(worker, AGENT_ID);
  assert.ok(er.status === 201 || er.status === 200);
  const cr = await claimJob(jobId, AGENT_ID, 'mine-claim-1');
  assert.equal(cr.status, 200);
  const asWorker = await getJson(app, `/jobs/mine?wallet=${worker.address}`);
  assert.equal(asWorker.status, 200);
  const worked = (asWorker.body.jobs as Record<string, unknown>[]).find(
    (j) => j.id === jobId,
  );
  assert.ok(worked, 'claimed job appears in worker /mine');
  assert.equal(worked.role, 'worker');
});

// ---- gated submission read (POST /jobs/:id/submission) ----

async function submissionAccess(
  target: Hono,
  account: ReturnType<typeof privateKeyToAccount>,
  jobId: number,
  over: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const message = {
    jobId: BigInt(jobId),
    accessor: account.address,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(account, 'JobSubmissionAccess', message);
  return postJson(target, `/jobs/${jobId}/submission`, {
    jobId,
    accessor: account.address,
    timestamp: Number(message.timestamp),
    signature,
    ...over,
  });
}

await check('submission gate: 404 on unknown job', async () => {
  const res = await submissionAccess(app, requester, 999999);
  assert.equal(res.status, 404);
});

await check('submission gate: 409 when nothing submitted yet', async () => {
  const jobId = await postFundedJob('subgate-1', 9101n);
  const res = await submissionAccess(app, requester, jobId);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'no_submission');
});

await check('submission gate: requester and worker can read, stranger 403s, forgeries 401', async () => {
  const jobId = await postFundedJob('subgate-2', 9102n);
  owners.set(AGENT_ID.toString(), worker.address);
  const er = await enrollWorkerWallet(worker, AGENT_ID);
  assert.ok(er.status === 201 || er.status === 200);
  const cr = await claimJob(jobId, AGENT_ID, 'subgate-claim-2');
  assert.equal(cr.status, 200);
  const sub = await submitDeliverable(jobId);
  assert.equal(sub.status, 200);

  // public detail still hides the URI while under review
  const pub = await getJson(app, `/jobs/${jobId}`);
  assert.equal((pub.body.job as Record<string, unknown>).submissionUri, null);

  // requester -> 200 with uri + hash + submittedAt
  const r = await submissionAccess(app, requester, jobId);
  assert.equal(r.status, 200);
  assert.equal(r.body.submissionUri, 'ipfs://bafytest');
  assert.equal(r.body.submissionHash, keccak256(toHex('the work')));
  assert.ok(typeof r.body.submittedAt === 'number');

  // claimed worker -> 200
  const w = await submissionAccess(app, worker, jobId);
  assert.equal(w.status, 200);
  assert.equal(w.body.submissionUri, 'ipfs://bafytest');

  // stranger -> 403
  const s = await submissionAccess(app, stranger, jobId);
  assert.equal(s.status, 403);
  assert.equal(s.body.error, 'not_authorized');

  // wrong signer for the claimed accessor -> 401
  const message = {
    jobId: BigInt(jobId),
    accessor: requester.address,
    timestamp: BigInt(nowSec()),
  };
  const forged = await sign(stranger, 'JobSubmissionAccess', message);
  const f = await postJson(app, `/jobs/${jobId}/submission`, {
    jobId,
    accessor: requester.address,
    timestamp: Number(message.timestamp),
    signature: forged,
  });
  assert.equal(f.status, 401);
  assert.equal(f.body.error, 'bad_signature');

  // stale timestamp -> 401
  const staleMessage = {
    jobId: BigInt(jobId),
    accessor: requester.address,
    timestamp: BigInt(nowSec() - 3600),
  };
  const staleSig = await sign(requester, 'JobSubmissionAccess', staleMessage);
  const st = await postJson(app, `/jobs/${jobId}/submission`, {
    jobId,
    accessor: requester.address,
    timestamp: Number(staleMessage.timestamp),
    signature: staleSig,
  });
  assert.equal(st.status, 401);
  assert.equal(st.body.error, 'stale_timestamp');

  // signed jobId mismatch -> 400
  const mm = await submissionAccess(app, requester, jobId, { jobId: jobId + 1 });
  assert.equal(mm.status, 400);
  assert.equal(mm.body.error, 'job_id_mismatch');
});

// ---- live dispatch feed (GET /jobs/stream, server-push) ----

await check('feed: stream opens as SSE with a ready event', async () => {
  const res = await app.request('/jobs/stream');
  assert.equal(res.status, 200);
  assert.ok(
    (res.headers.get('content-type') || '').includes('text/event-stream'),
  );
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.ok(text.includes('event: ready'));
  await reader.cancel();
});

await check('feed: job_posted and job_claimed broadcast to subscribers', async () => {
  const feed = createJobFeed();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  feed.subscribe((event, data) => {
    events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  });
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(jobsConfig(), {
      db: new JobsDb(':memory:'),
      getReceipt,
      getOnchainJob,
      identityOwner,
      reputationSummary,
      onActivity,
      jobFeed: feed,
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  const body = await signedPost();
  const h = txHash('feed-post-seed');
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(
      77n,
      parseUnits(body.bountyUsdc as string, 6),
      BigInt(body.deadline as string),
      body.termsHash as string,
    ),
  );
  const pr = await postJson(parent, '/jobs', { ...body, txHash: h });
  assert.equal(pr.status, 201);
  const jobId = pr.body.jobId as number;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'job_posted');
  assert.equal((events[0].data.job as Record<string, unknown>).id, jobId);
  assert.equal((events[0].data.job as Record<string, unknown>).state, 'open');
  assert.equal(events[0].data.dispatch, 'open');

  owners.set('4242', worker.address); // mock registry: worker owns agent 4242
  await enrollWorkerWallet(worker, 4242n, parent);
  const cr = await claimJob(jobId, 4242n, 'feed-claim-seed', parent);
  assert.equal(cr.status, 200);
  assert.equal(events.length, 2);
  assert.equal(events[1].event, 'job_claimed');
  assert.equal(events[1].data.jobId, jobId);
  assert.equal(
    (events[1].data.worker as string).toLowerCase(),
    worker.address.toLowerCase(),
  );
});

await check('feed: dead subscriber is dropped, broadcast never throws', () => {
  const feed = createJobFeed();
  let calls = 0;
  feed.subscribe(() => {
    calls++;
    throw new Error('dead subscriber');
  });
  feed.subscribe(() => {
    calls++;
  });
  feed.broadcast('job_posted', { id: 1 });
  assert.equal(calls, 2);
  assert.equal(feed.subscriberCount, 1);
  feed.broadcast('job_posted', { id: 2 });
  assert.equal(calls, 3);
});

console.log(`\njobs: ${passed} checks passed`);
