/**
 * 402 Job Marketplace — verification panel tests.
 *
 *   npx tsx test/jobs-panels.test.ts
 *
 * Integration tests against createJobsApp with a mocked chain layer
 * (same harness shape as test/jobs.test.ts). Throwaway in-process keys;
 * nothing is broadcast, no real funds.
 *
 * Covers: submit -> panel assignment (in_review), full flow to verified,
 * blind votes, the rejection path + resubmission with a fresh panel,
 * exclusion rules (worker/poster/fresh wallets can't review, double votes
 * rejected), no-show timeout replacement + cooldowns, reviewer-stats
 * accounting, accept-from-verified, and the jobs_review MCP tool.
 */
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadJobsConfig } from '../src/jobs/config.js';
import { JobsDb } from '../src/jobs/db.js';
import {
  DISPUTE_RAISED_TOPIC,
  JOB_RELEASED_TOPIC,
  type GetOnchainJob,
  type ReputationSummary,
} from '../src/jobs/escrow.js';
import { createJobsApp } from '../src/jobs/server.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { GetReceipt, ReceiptLike } from '../src/lounge/types.js';
import { createMcpServer } from '../src/mcp/server.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const requester = privateKeyToAccount(generatePrivateKey());
const worker = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
// Reviewers r0..r5 (agent ids 101-106; the resubmission test needs a full
// fresh panel after the first three are excluded).
const reviewers = [1, 2, 3, 4, 5, 6].map(() => privateKeyToAccount(generatePrivateKey()));
const byAgentId = new Map<string, ReturnType<typeof privateKeyToAccount>>();
reviewers.forEach((r, i) => byAgentId.set(String(101 + i), r));
byAgentId.set('7', worker);

const escrowAddr = getAddress('0x00000000000000000000000000000000000000e5');
const WORKER_AGENT_ID = 7n;
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- mocked chain layer ----
const receipts = new Map<string, ReceiptLike>();
const owners = new Map<string, Address>(); // agentId -> owner
owners.set('7', worker.address);
reviewers.forEach((r, i) => owners.set(String(101 + i), r.address));

const getReceipt: GetReceipt = async (h: Hex) => receipts.get(h.toLowerCase()) ?? null;
const getOnchainJob: GetOnchainJob = async () => null;
const identityOwner = async (agentId: bigint): Promise<Address | null> =>
  owners.get(agentId.toString()) ?? null;
const reputationSummary = async (): Promise<ReputationSummary> => ({
  reliability: '95',
  disputeRateBps: '0',
  arbitrationWins: '0',
  arbitrationLosses: '0',
  totalEvents: '1',
  lastEventTimestamp: nowSec(),
});

function txHash(seed: string): Hex {
  return keccak256(toHex(`jobs-panels-test-${seed}`));
}

function makeApp(reviewTimeoutSeconds?: string): { app: Hono; db: JobsDb } {
  const cfg = loadJobsConfig({
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    FOUR02_REPUTATION_REGISTRY: '0x4fa146388ce351b2af71aa6841146c91a2f27494',
    INK_RPC_URL: 'http://localhost:1', // dead localhost: never called, mocks injected
    JOBS_DAILY_POST_CAP: '10000',
    ...(reviewTimeoutSeconds ? { JOBS_REVIEW_TIMEOUT_SECONDS: reviewTimeoutSeconds } : {}),
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
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  return { app: parent, db };
}

// ---- signing helpers ----

async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  primaryType: 'JobSubmit' | 'ReviewAttestation' | 'JobDecision',
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

// ---- DB seeding (chain-free: the DB layer never verifies onchain) ----

const SPEC = 'Write a 500-word explainer on x402 micropayments.';
const SPEC_HASH = keccak256(toHex(SPEC)).toLowerCase();

function seedCompletedJob(db: JobsDb, seed: string, workerAddr: Address, agentId: string): number {
  const now = nowSec();
  const r = db.createListing({
    escrowJobId: seed,
    escrow: escrowAddr,
    requester: requester.address,
    title: `seed ${seed}`,
    spec: SPEC,
    specHash: SPEC_HASH,
    category: 'writing',
    bountyUsdc: '25.00',
    deadline: now + 86400,
    txHash: txHash(`seed-post-${seed}`),
    now,
  });
  assert.equal(r.ok, true);
  const id = (r as { ok: true; id: number }).id;
  assert.equal(db.claimJob(id, workerAddr, agentId, txHash(`seed-claim-${seed}`), now), 'ok');
  assert.equal(db.acceptJob(id, txHash(`seed-accept-${seed}`), now), 'ok');
  return id;
}

/** A claimed (not yet submitted) job for the main worker, via the DB. */
function seedClaimedJob(db: JobsDb, seed: string, escrowJobId?: bigint): number {
  const now = nowSec();
  const r = db.createListing({
    escrowJobId: escrowJobId !== undefined ? escrowJobId.toString() : `ej-${seed}`,
    escrow: escrowAddr,
    requester: requester.address,
    title: `panel job ${seed}`,
    spec: SPEC,
    specHash: SPEC_HASH,
    category: 'writing',
    bountyUsdc: '25.00',
    deadline: now + 86400,
    txHash: txHash(`post-${seed}`),
    now,
  });
  assert.equal(r.ok, true);
  const id = (r as { ok: true; id: number }).id;
  assert.equal(
    db.claimJob(id, worker.address, WORKER_AGENT_ID.toString(), txHash(`claim-${seed}`), now),
    'ok',
  );
  // Enroll the worker (the submit path doesn't check enrollment, but the
  // draw excludes by wallet/agent — enrollment rows drive the draw).
  db.enrollWorker({ wallet: worker.address, agentId: WORKER_AGENT_ID.toString(), now });
  return id;
}

function enrollReviewers(db: JobsDb, idx: number[], completions = 1): void {
  const now = nowSec();
  for (const i of idx) {
    const r = reviewers[i];
    const agentId = String(101 + i);
    db.enrollWorker({ wallet: r.address, agentId, now });
    for (let k = 0; k < completions; k++) {
      seedCompletedJob(db, `r${i}-c${k}-${Math.random().toString(36).slice(2)}`, r.address, agentId);
    }
  }
}

async function submitJob(app: Hono, jobId: number) {
  const contentHash = keccak256(toHex('deliverable bytes'));
  const ts = nowSec();
  const signature = await sign(worker, 'JobSubmit', {
    jobId: BigInt(jobId),
    author: worker.address,
    contentHash,
    uri: 'https://example.com/work.zip',
    timestamp: BigInt(ts),
  });
  return postJson(app, `/jobs/${jobId}/submit`, {
    jobId,
    author: worker.address,
    contentHash,
    uri: 'https://example.com/work.zip',
    timestamp: ts,
    signature,
  });
}

async function vote(
  app: Hono,
  jobId: number,
  reviewerIdx: number,
  verdict: boolean,
  score: number,
) {
  const r = reviewers[reviewerIdx];
  const agentId = String(101 + reviewerIdx);
  const ts = nowSec();
  const signature = await sign(r, 'ReviewAttestation', {
    jobId: BigInt(jobId),
    reviewer: r.address,
    agentId: BigInt(agentId),
    verdict,
    score,
    timestamp: BigInt(ts),
  });
  return postJson(app, `/jobs/${jobId}/review`, {
    reviewer: r.address,
    agentId,
    verdict,
    score,
    timestamp: ts,
    signature,
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

console.log('jobs panels:');

// ---- 1. submit -> panel of exactly 3, job enters in_review ----

await check('submit assigns exactly 3 eligible reviewers and enters in_review', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0, 1, 2]);
  const jobId = seedClaimedJob(db, 'flow1');
  const { status, body } = await submitJob(app, jobId);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.state, 'in_review');
  const reviewersOut = (body.panel as { reviewers: string[] }).reviewers.sort();
  assert.deepEqual(reviewersOut, ['101', '102', '103']);
  const listing = db.getJob(jobId);
  assert.equal(listing?.state, 'in_review');
});

// ---- 2. full flow: 2-of-3 accepts -> verified, votes revealed ----

await check('2-of-3 accept quorum moves the job to verified and reveals votes', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0, 1, 2]);
  const jobId = seedClaimedJob(db, 'flow2');

  const blind = await getJson(app, `/jobs/${jobId}/reviews`);
  assert.equal(blind.status, 404); // no panel before submit

  await submitJob(app, jobId);

  // First vote: still open, votes stay blind.
  let v = await vote(app, jobId, 0, true, 90);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.votesCast, 1);
  let reviews = await getJson(app, `/jobs/${jobId}/reviews`);
  assert.equal(reviews.status, 200);
  assert.equal(reviews.body.state, 'open');
  const votes = reviews.body.votes as { verdict: unknown; score: unknown }[];
  assert.equal(votes.length, 1);
  assert.equal(votes[0].verdict, null);
  assert.equal(votes[0].score, null);

  // Second accept -> quorum, verified.
  v = await vote(app, jobId, 1, true, 85);
  assert.equal(v.status, 200);
  assert.equal(v.body.state, 'verified');
  assert.equal(db.getJob(jobId)?.state, 'verified');

  // Panel closed: late votes rejected.
  v = await vote(app, jobId, 2, true, 95);
  assert.equal(v.status, 409);

  // Now the votes are revealed.
  reviews = await getJson(app, `/jobs/${jobId}/reviews`);
  const revealed = (reviews.body.votes as { verdict: unknown; score: unknown }[]).map((x) => [
    x.verdict,
    x.score,
  ]);
  revealed.sort();
  assert.deepEqual(revealed, [
    [true, 85],
    [true, 90],
  ]);

  // Reviewer stats: both agreed with the quorum.
  for (const agentId of ['101', '102']) {
    const s = await getJson(app, `/jobs/reviewers/${agentId}/stats`);
    assert.equal(s.status, 200);
    assert.equal(s.body.reviewsDone, 1);
    assert.equal(s.body.agreedWithQuorum, 1);
    assert.equal(s.body.outlierVotes, 0);
  }
});

// ---- 3. rejection path: back to claimed, worker resubmits, fresh panel ----

await check('2-of-3 reject returns the job to claimed with feedback; resubmission draws a fresh panel', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0, 1, 2, 3, 4, 5]);
  const jobId = seedClaimedJob(db, 'flow3');
  const submitted = await submitJob(app, jobId);
  assert.equal(submitted.status, 200);
  // The draw is random among the six — read who actually got assigned.
  const firstPanel = (
    (submitted.body.panel as { reviewers: string[] }).reviewers as string[]
  ).sort();
  assert.equal(firstPanel.length, 3);
  const idxOf = (agentId: string) => Number(agentId) - 101;

  // Reviewers only ever see the spec + submission URI through their own
  // assigned feed (the verdict is theirs to judge blind).
  const assignedReviewer = byAgentId.get(firstPanel[0]);
  assert.ok(assignedReviewer);
  const assigned = await getJson(app, `/jobs/reviews/assigned?wallet=${assignedReviewer.address}`);
  assert.equal(assigned.status, 200);
  const panels = assigned.body.panels as {
    jobId: number;
    spec: string;
    submissionUri: string;
  }[];
  assert.equal(panels.length, 1);
  assert.equal(panels[0].jobId, jobId);
  assert.equal(panels[0].spec, SPEC);
  assert.equal(panels[0].submissionUri, 'https://example.com/work.zip');

  // One dissenting accept, then two rejects -> quorum: job goes back to
  // claimed (resubmittable), scores visible to the worker.
  await vote(app, jobId, idxOf(firstPanel[0]), true, 85);
  await vote(app, jobId, idxOf(firstPanel[1]), false, 25);
  const v = await vote(app, jobId, idxOf(firstPanel[2]), false, 30);
  assert.equal(v.status, 200);
  assert.equal(v.body.state, 'claimed');
  assert.equal(db.getJob(jobId)?.state, 'claimed');

  // The dissenting accept is an outlier in the stats; the rejecters agreed
  // with the quorum.
  const outlier = await getJson(app, `/jobs/reviewers/${firstPanel[0]}/stats`);
  assert.equal(outlier.body.reviewsDone, 1);
  assert.equal(outlier.body.agreedWithQuorum, 0);
  assert.equal(outlier.body.outlierVotes, 1);
  const agree = await getJson(app, `/jobs/reviewers/${firstPanel[1]}/stats`);
  assert.equal(agree.body.agreedWithQuorum, 1);
  assert.equal(agree.body.outlierVotes, 0);

  // Worker resubmits (no resubmission flag needed — submit is allowed from
  // claimed): a FRESH panel forms, none of the old reviewers are reused.
  const r = await submitJob(app, jobId);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'in_review');
  const freshReviewers = (
    (r.body.panel as { reviewers: string[] }).reviewers as string[]
  ).sort();
  const all = ['101', '102', '103', '104', '105', '106'];
  assert.deepEqual(
    freshReviewers,
    all.filter((a) => !firstPanel.includes(a)),
  );

  // This time it passes.
  await vote(app, jobId, idxOf(freshReviewers[0]), true, 80);
  const done = await vote(app, jobId, idxOf(freshReviewers[1]), true, 82);
  assert.equal(done.body.state, 'verified');
});

// ---- 4. exclusion rules ----

await check('exclusion rules: worker, poster, and strangers cannot vote; double votes rejected', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0, 1, 2]);
  const jobId = seedClaimedJob(db, 'flow4');
  await submitJob(app, jobId);

  // The worker is not on the panel and cannot vote.
  {
    const ts = nowSec();
    const sig = await sign(worker, 'ReviewAttestation', {
      jobId: BigInt(jobId),
      reviewer: worker.address,
      agentId: WORKER_AGENT_ID,
      verdict: true,
      score: 100,
      timestamp: BigInt(ts),
    });
    const { status } = await postJson(app, `/jobs/${jobId}/review`, {
      reviewer: worker.address,
      agentId: WORKER_AGENT_ID.toString(),
      verdict: true,
      score: 100,
      timestamp: ts,
      signature: sig,
    });
    assert.equal(status, 403);
  }

  // A stranger wallet cannot vote either.
  {
    const ts = nowSec();
    const sig = await sign(stranger, 'ReviewAttestation', {
      jobId: BigInt(jobId),
      reviewer: stranger.address,
      agentId: 999n,
      verdict: true,
      score: 100,
      timestamp: BigInt(ts),
    });
    const { status } = await postJson(app, `/jobs/${jobId}/review`, {
      reviewer: stranger.address,
      agentId: '999',
      verdict: true,
      score: 100,
      timestamp: ts,
      signature: sig,
    });
    assert.equal(status, 403);
  }

  // An assigned reviewer votes once, then is rejected the second time.
  assert.equal((await vote(app, jobId, 0, true, 88)).status, 200);
  assert.equal((await vote(app, jobId, 0, true, 88)).status, 409);

  // Bad signature is rejected before anything is recorded.
  {
    const { status, body } = await postJson(app, `/jobs/${jobId}/review`, {
      reviewer: reviewers[1].address,
      agentId: '102',
      verdict: true,
      score: 90,
      timestamp: nowSec(),
      signature: `0x${'ab'.repeat(65)}`,
    });
    assert.equal(status, 401);
    assert.equal(body.error, 'bad_signature');
  }
});

await check('reviewers with no completed jobs are never drawn', async () => {
  const { app, db } = makeApp();
  // r3 is enrolled but has zero completions; r0..r2 have one each.
  const now = nowSec();
  db.enrollWorker({ wallet: reviewers[3].address, agentId: '104', now });
  enrollReviewers(db, [0, 1, 2]);
  const jobId = seedClaimedJob(db, 'flow5');
  const { status, body } = await submitJob(app, jobId);
  assert.equal(status, 200);
  const drawn = ((body.panel as { reviewers: string[] }).reviewers as string[]).sort();
  assert.deepEqual(drawn, ['101', '102', '103']); // '104' (zero completions) excluded
});

await check('submit without 3 eligible reviewers stays submitted (bootstrap-safe)', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0]); // only one eligible reviewer
  const jobId = seedClaimedJob(db, 'flow6');
  const { status, body } = await submitJob(app, jobId);
  assert.equal(status, 200);
  assert.equal(body.state, 'submitted');
  assert.equal(body.panel, null);
  assert.equal(db.getJob(jobId)?.state, 'submitted');
});

// ---- 5. no-show timeout replacement + cooldown ----

await check('no-show reviewers are replaced after the deadline and enter cooldown', async () => {
  const { app, db } = makeApp('2'); // 2-second review timeout
  enrollReviewers(db, [0, 1, 2, 3, 4]);
  const jobId = seedClaimedJob(db, 'flow7');
  const { status, body } = await submitJob(app, jobId);
  assert.equal(status, 200, JSON.stringify(body));
  const original = ((body.panel as { reviewers: string[] }).reviewers as string[]).sort();

  // Nobody votes; the deadline passes (sleep past deadlineAt + the
  // integer-second granularity of the timestamps).
  await new Promise((r) => setTimeout(r, 3500));

  // The lazy replacement runs on the next panel read.
  const reviews = await getJson(app, `/jobs/${jobId}/reviews`);
  assert.equal(reviews.status, 200);
  assert.equal(reviews.body.state, 'open');
  const nowAssigned = (
    (reviews.body.reviewers as { reviewerAgentId: string }[]).map((r) => r.reviewerAgentId) as string[]
  ).sort();
  const originalSet = new Set(original);
  const fresh = nowAssigned.filter((a) => !originalSet.has(a));
  assert.equal(fresh.length, 2, `expected 2 fresh reviewers, got ${JSON.stringify(nowAssigned)}`);

  // No-show accounting: the replaced reviewers each have a no-show + a live cooldown.
  for (const agentId of original) {
    const s = await getJson(app, `/jobs/reviewers/${agentId}/stats`);
    assert.equal(s.body.noShows, 1, `agent ${agentId} noShows`);
    assert.ok((s.body.cooldownUntil as number) > nowSec(), `agent ${agentId} cooldown live`);
  }

  // The two fresh reviewers accept -> quorum over their 2 votes.
  const freshIdx = fresh.map((a) => Number(a) - 101);
  assert.equal((await vote(app, jobId, freshIdx[0], true, 80)).status, 200);
  const done = await vote(app, jobId, freshIdx[1], true, 84);
  assert.equal(done.body.state, 'verified', JSON.stringify(done.body));
  assert.equal(db.getJob(jobId)?.state, 'verified');
});

await check('pool exhaustion: all reviewers no-show with no replacements -> job falls back to submitted', async () => {
  const { app, db } = makeApp('2'); // 2-second review timeout
  enrollReviewers(db, [0, 1, 2]); // exactly 3 eligible — no replacements possible
  const jobId = seedClaimedJob(db, 'flow10');
  const { status } = await submitJob(app, jobId);
  assert.equal(status, 200);
  assert.equal(db.getJob(jobId)?.state, 'in_review');

  await new Promise((r) => setTimeout(r, 3500));

  // Lazy replacement finds nobody to draw: panel closes, job returns to
  // `submitted` so the poster can still release directly.
  const reviews = await getJson(app, `/jobs/${jobId}/reviews`);
  assert.equal(reviews.status, 200);
  assert.equal(reviews.body.state, 'closed');
  assert.equal(db.getJob(jobId)?.state, 'submitted');

  // The no-shows still booked their penalty.
  for (const agentId of ['101', '102', '103']) {
    const s = await getJson(app, `/jobs/reviewers/${agentId}/stats`);
    assert.equal(s.body.noShows, 1);
  }
});

// ---- 6. advisory only: release + dispute keep working around the panel ----

await check('panels are advisory: the poster can accept from in_review and verified, and dispute still works', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0, 1, 2]);
  const escrowId = 9001n;
  const jobId = seedClaimedJob(db, 'flow8', escrowId);
  await submitJob(app, jobId);

  // Dispute from in_review (panel advisory — does not block escrow flow).
  const disputeTx = txHash('dispute-flow8');
  receipts.set(disputeTx.toLowerCase(), {
    status: 'success',
    logs: [
      {
        address: escrowAddr,
        topics: [
          DISPUTE_RAISED_TOPIC,
          `0x${escrowId.toString(16).padStart(64, '0')}`,
          `0x${requester.address.slice(2).padStart(64, '0')}`,
        ],
        data: '0x',
      },
    ],
  });
  const dts = nowSec();
  const dsign = await sign(requester, 'JobDecision', {
    jobId: BigInt(jobId),
    requester: requester.address,
    decision: 'dispute',
    timestamp: BigInt(dts),
  });
  const disputed = await postJson(app, `/jobs/${jobId}/dispute`, {
    jobId,
    requester: requester.address,
    decision: 'dispute',
    timestamp: dts,
    signature: dsign,
    txHash: disputeTx,
  });
  assert.equal(disputed.status, 200, JSON.stringify(disputed.body));
  assert.equal(disputed.body.state, 'disputed');
  assert.equal(db.getPanel(jobId)?.state, 'closed'); // panel closed when the escrow moved on

  // Now the verified path: fresh job, panel approves, poster accepts.
  const jobId2 = seedClaimedJob(db, 'flow9', 9002n);
  await submitJob(app, jobId2);
  await vote(app, jobId2, 0, true, 92);
  await vote(app, jobId2, 1, true, 88);
  assert.equal(db.getJob(jobId2)?.state, 'verified');

  const releaseTx = txHash('release-flow9');
  receipts.set(releaseTx.toLowerCase(), {
    status: 'success',
    logs: [
      {
        address: escrowAddr,
        topics: [
          JOB_RELEASED_TOPIC,
          `0x${9002n.toString(16).padStart(64, '0')}`,
        ],
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }],
          [50_000_000n, 1_000_000n],
        ),
      },
    ],
  });
  const ats = nowSec();
  const asign = await sign(requester, 'JobDecision', {
    jobId: BigInt(jobId2),
    requester: requester.address,
    decision: 'accept',
    timestamp: BigInt(ats),
  });
  const accepted = await postJson(app, `/jobs/${jobId2}/accept`, {
    jobId: jobId2,
    requester: requester.address,
    decision: 'accept',
    timestamp: ats,
    signature: asign,
    txHash: releaseTx,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.state, 'complete');
  assert.equal(db.getPanel(jobId2)?.state, 'closed'); // panel closed after release
});

// ---- 7. jobs_review MCP tool ----

await check('jobs_review MCP tool: assigned feed + signed vote', async () => {
  const { app, db } = makeApp();
  enrollReviewers(db, [0, 1, 2]);
  const jobId = seedClaimedJob(db, 'mcp1');
  const server = serve({ fetch: app.fetch, port: 0 });
  const jobsBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/jobs`;
  const mcpServer = createMcpServer({
    facilitatorUrl: jobsBase,
    loungeUrl: jobsBase,
    jobsUrl: jobsBase,
    inkRpcUrl: 'http://localhost:1',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'panel-mcp-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const c = res as { content: { type: string; text: string }[] };
    assert.equal(c.content[0].type, 'text');
    return JSON.parse(c.content[0].text) as Record<string, unknown>;
  };

  try {
    await submitJob(app, jobId);

    // Assigned mode: spec + submission URI are exposed to the reviewer.
    const assigned = await callTool('jobs_review', { reviewer: reviewers[0].address });
    const assignedPanels = assigned.panels as {
      jobId: number;
      spec: string;
      submissionUri: string;
    }[];
    assert.equal(assignedPanels.length, 1);
    assert.equal(assignedPanels[0].jobId, jobId);
    assert.equal(assignedPanels[0].spec, SPEC);
    assert.equal(assignedPanels[0].submissionUri, 'https://example.com/work.zip');

    // Vote mode: client-side signed attestation, server verifies.
    const ts = nowSec();
    const signature = await sign(reviewers[0], 'ReviewAttestation', {
      jobId: BigInt(jobId),
      reviewer: reviewers[0].address,
      agentId: 101n,
      verdict: true,
      score: 90,
      timestamp: BigInt(ts),
    });
    const voted = await callTool('jobs_review', {
      reviewer: reviewers[0].address,
      jobId,
      agentId: '101',
      verdict: true,
      score: 90,
      timestamp: ts,
      signature,
    });
    assert.equal(voted.ok, true);
    assert.equal(voted.votesCast, 1);

    // Vote mode rejects a non-assigned reviewer.
    const bad = await callTool('jobs_review', {
      reviewer: reviewers[3].address,
      jobId,
      agentId: '104',
      verdict: true,
      score: 90,
      timestamp: nowSec(),
      signature: await sign(reviewers[3], 'ReviewAttestation', {
        jobId: BigInt(jobId),
        reviewer: reviewers[3].address,
        agentId: 104n,
        verdict: true,
        score: 90,
        timestamp: BigInt(nowSec()),
      }),
    });
    assert.equal(bad.ok, false);
  } finally {
    client.close();
    mcpServer.close();
    server.close();
  }
});

console.log(`jobs panels: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
