/**
 * 402 Job Marketplace v0 — tests.
 *
 *   npx tsx test/jobs.test.ts
 *
 * Integration tests against createJobsApp with a mocked chain layer:
 * getReceipt / getTransaction / identityOwner / reputationSummary are all
 * in-memory, and the RPC URL is a dead localhost (never called). Throwaway
 * in-process keys; nothing is broadcast, no real funds.
 */
import assert from 'node:assert/strict';
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
  RAISE_DISPUTE_SELECTOR,
  RELEASE_SELECTOR,
  type GetTransaction,
  type ReputationSummary,
} from '../src/jobs/escrow.js';
import { createJobsApp, type JobActivityEvent } from '../src/jobs/server.js';
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
const transactions = new Map<string, { from: string; to: string | null; input: string }>();
const owners = new Map<string, Address>(); // agentId -> owner

const getReceipt: GetReceipt = async (h: Hex) =>
  receipts.get(h.toLowerCase()) ?? null;
const getTransaction: GetTransaction = async (h: Hex) =>
  transactions.get(h.toLowerCase()) ?? null;
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
      getTransaction,
      identityOwner,
      reputationSummary,
      onActivity,
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

function fundingReceipt(jobId: bigint, amount: bigint, deadline: bigint, termsHash: string): ReceiptLike {
  return {
    status: 'success',
    logs: [
      transferLog(requester.address, escrowAddr, amount),
      bountyCreatedLog(jobId, requester.address, amount, deadline, termsHash),
    ],
  };
}

function claimReceipt(jobId: bigint, agentId: bigint): ReceiptLike {
  return {
    status: 'success',
    logs: [bountyClaimedLog(jobId, worker.address, agentId)],
  };
}

function callTx(selector: string, jobId: bigint, from: string) {
  return {
    from,
    to: escrowAddr,
    input: (selector + encodeAbiParameters([{ type: 'uint256' }], [jobId]).slice(2)).toLowerCase(),
  };
}

function txHash(seed: string): Hex {
  return keccak256(toHex(`jobs-test-${seed}`));
}

// ---- signing helpers ----

async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  primaryType: 'JobEnroll' | 'JobPost' | 'JobClaim' | 'JobSubmit' | 'JobDecision',
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
    ...over,
  };
}

async function signedPost(over: Record<string, unknown> = {}) {
  const f = jobPostFields(over);
  const signature = await sign(requester, 'JobPost', {
    requester: f.requester,
    title: f.title,
    spec: f.spec,
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
) {
  const message = {
    wallet: account.address,
    agentId,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(account, 'JobEnroll', message);
  return postJson(app, '/jobs/enroll', {
    wallet: account.address,
    agentId: agentId.toString(),
    timestamp: Number(message.timestamp),
    signature,
  });
}

async function claimJob(jobId: number, agentId: bigint, seed: string) {
  const h = txHash(seed);
  const listing = (await getJson(app, `/jobs/${jobId}`)).body.job as Record<string, unknown>;
  receipts.set(h.toLowerCase(), claimReceipt(BigInt(listing.escrowJobId as string), agentId));
  const message = {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId,
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(worker, 'JobClaim', message);
  return postJson(app, `/jobs/${jobId}/claim`, {
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

await check('valid claim -> 200 claimed; double-claim -> 409', async () => {
  const jobId = await postFundedJob('post-5', 5n);
  const res = await claimJob(jobId, AGENT_ID, 'claim-5');
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'claimed');
  const again = await claimJob(jobId, AGENT_ID, 'claim-5b');
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'wrong_state');
  const got = await getJson(app, `/jobs/${jobId}`);
  assert.equal((got.body.job as Record<string, unknown>).workerAgentId, AGENT_ID.toString());
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
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(
    h.toLowerCase(),
    callTx(RELEASE_SELECTOR, 7n, requester.address),
  );
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
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(h.toLowerCase(), callTx(RELEASE_SELECTOR, 8n, requester.address));
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
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(h.toLowerCase(), callTx(RELEASE_SELECTOR, 9n, stranger.address));
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
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(h.toLowerCase(), callTx(RELEASE_SELECTOR, 999n, requester.address));
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

async function raiseDispute(jobId: number, escrowJobId: bigint, byRequester: boolean, seed: string) {
  const signer = byRequester ? requester : worker;
  const h = txHash(seed);
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(h.toLowerCase(), callTx(RAISE_DISPUTE_SELECTOR, escrowJobId, signer.address));
  const message = {
    jobId: BigInt(jobId),
    requester: signer.address,
    decision: 'dispute',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(signer, 'JobDecision', message);
  return postJson(app, `/jobs/${jobId}/dispute`, {
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
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(h.toLowerCase(), callTx(RAISE_DISPUTE_SELECTOR, 13n, stranger.address));
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
  receipts.set(h.toLowerCase(), { status: 'success', logs: [] });
  transactions.set(h.toLowerCase(), callTx(RELEASE_SELECTOR, 14n, requester.address));
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
  const h = txHash('accept-7'); // burned by the first accept
  // Job 9 is still submitted (its accept attempt was 403, before the burn).
  const got = await getJson(app, `/jobs/9`);
  assert.equal((got.body.job as Record<string, unknown>).state, 'submitted');
  const message = {
    jobId: 9n,
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(nowSec()),
  };
  const signature = await sign(requester, 'JobDecision', message);
  const res = await postJson(app, `/jobs/9/accept`, {
    jobId: 9,
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

await check('job-activity flows into the lounge feed', async () => {
  const loungeDb = new LoungeDb(':memory:');
  const seen: JobActivityEvent[] = [];
  const parent = new Hono();
  const cfg = jobsConfig();
  const jobsApp = createJobsApp(cfg, {
    db: new JobsDb(':memory:'),
    getReceipt,
    getTransaction,
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
  assert.equal(db.resolveJob(idA, now), 'ok');
  assert.equal(db.getJob(idA)?.state, 'resolved');
  assert.equal(db.refundJob(idA, now), 'wrong_state'); // resolved is terminal

  const b = mk();
  assert.equal(b.ok, true);
  if (!b.ok) throw new Error('unreachable');
  const idB = b.id;
  assert.equal(db.claimJob(idB, worker.address, '7', txHash('db-claim-b'), now), 'ok');
  assert.equal(db.refundJob(idB, now), 'ok');
  assert.equal(db.getJob(idB)?.state, 'refunded');
  db.close();
});

console.log(`\njobs: ${passed} checks passed`);
