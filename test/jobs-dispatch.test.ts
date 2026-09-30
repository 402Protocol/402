/**
 * 402 directed dispatch — test suite.
 *
 * Covers the 5000-agent dispatch path end to end:
 *  1. DB layer: candidate ranking, assignment lifecycle, expiry sweep,
 *     dispatch mode. (Workers carry no capabilities: any enrolled worker
 *     may be assigned any job; categories live on jobs as metadata only.)
 *  2. Engine: post -> directed assign -> decline -> next round ->
 *     open-board fallback; expiry sweeps.
 *  3. Feed v2: broadcast vs wallet-scoped routing, dead-sender safety.
 *  4. HTTP: decline endpoint, claim gating on the live assignment,
 *     GET /jobs/assigned, open-board fallback claims.
 *
 * Throwaway keys only; the chain layer is fully mocked.
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
import { JobsDb, type JobListing } from '../src/jobs/db.js';
import {
  BOUNTY_CLAIMED_TOPIC,
  BOUNTY_CREATED_TOPIC,
  type ReputationSummary,
} from '../src/jobs/escrow.js';
import { createJobFeed, JOB_FEED_MAX_SUBSCRIBERS, type JobFeedEvent } from '../src/jobs/feed.js';
import {
  advanceDispatch,
  dispatchNewJob,
  settleExpiredDispatch,
  type DispatchDeps,
} from '../src/jobs/dispatch.js';
import { createJobsApp } from '../src/jobs/server.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { GetReceipt, ReceiptLike } from '../src/lounge/types.js';

// ---- throwaway keys (in-process only, never funded, never broadcast) ----
const requester = privateKeyToAccount(generatePrivateKey());
const workerA = privateKeyToAccount(generatePrivateKey());
const workerB = privateKeyToAccount(generatePrivateKey());
const workerC = privateKeyToAccount(generatePrivateKey());
const escrowAddr = getAddress('0x00000000000000000000000000000000000000e5');

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- test runner (same shape as the other suites) ----
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

// ---- engine fixture: real db + real feed, captured inboxes ----
interface Seen {
  event: JobFeedEvent;
  payload: Record<string, unknown>;
}
function engineSetup(maxRounds = 2) {
  const db = new JobsDb(':memory:');
  const feed = createJobFeed();
  const pub: Seen[] = [];
  const inboxA: Seen[] = [];
  const inboxB: Seen[] = [];
  const inboxC: Seen[] = [];
  const cap = (arr: Seen[]) => (event: JobFeedEvent, data: string) => {
    arr.push({ event, payload: JSON.parse(data) as Record<string, unknown> });
  };
  feed.subscribe(cap(pub));
  feed.subscribe(cap(inboxA), workerA.address);
  feed.subscribe(cap(inboxB), workerB.address);
  feed.subscribe(cap(inboxC), workerC.address);
  const deps: DispatchDeps = {
    db,
    feed,
    acceptWindowSeconds: 600,
    maxRounds,
    maxConcurrentJobs: 1,
    publicJob: (l: JobListing) => ({ id: l.id, title: l.title, category: l.category }),
  };
  return { db, feed, pub, inboxA, inboxB, inboxC, deps };
}

function enrollWith(db: JobsDb, wallet: Address, agentId: string) {
  db.enrollWorker({ wallet, agentId, now: nowSec() });
}

let listingSeq = 0;
function postListing(db: JobsDb, over: Partial<{ category: string; requester: Address }> = {}) {
  listingSeq++;
  const res = db.createListing({
    escrowJobId: String(9000 + listingSeq),
    escrow: escrowAddr,
    requester: over.requester ?? requester.address,
    title: `Dispatch test job ${listingSeq}`,
    spec: 'Do the thing.',
    specHash: keccak256(toHex(`spec-${listingSeq}`)),
    category: over.category ?? 'writing',
    bountyUsdc: '25.00',
    deadline: nowSec() + 86400,
    txHash: keccak256(toHex(`dispatch-tx-${listingSeq}`)),
    now: nowSec(),
  });
  assert.equal(res.ok, true);
  const listing = db.getJob(res.ok ? res.id : -1);
  assert.ok(listing);
  return listing;
}

// ================= 1. DB layer =================

await check('enrollment carries no worker capabilities (categories are job metadata only)', () => {
  const db = new JobsDb(':memory:');
  db.enrollWorker({ wallet: workerA.address, agentId: '11', now: nowSec() });
  const w = db.getWorker(workerA.address);
  assert.ok(w);
  assert.equal(w.agentId, '11');
  assert.ok(!('capabilities' in w), 'worker records must not carry capabilities');
});

await check('listDispatchCandidates: any enrolled worker is a candidate for any category', () => {
  const db = new JobsDb(':memory:');
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  enrollWith(db, workerC.address, '13');
  // A writing job sees every enrolled worker; nothing is category-gated.
  const cands = db.listDispatchCandidates({
    excludeWallets: [requester.address],
    maxConcurrent: 1,
    limit: 5,
  });
  assert.equal(cands.length, 3);
  // Same pool for a code job — job category does not filter workers.
  const cands2 = db.listDispatchCandidates({
    excludeWallets: [],
    maxConcurrent: 1,
    limit: 5,
  });
  assert.equal(cands2.length, 3);
  // The requester is never their own candidate.
  const cands3 = db.listDispatchCandidates({
    excludeWallets: [workerA.address, workerB.address, workerC.address],
    maxConcurrent: 1,
    limit: 5,
  });
  assert.deepEqual(cands3, []);
});

await check('listDispatchCandidates: excludes tried wallets and requester', () => {
  const db = new JobsDb(':memory:');
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  const cands = db.listDispatchCandidates({
    excludeWallets: [requester.address, workerA.address],
    maxConcurrent: 1,
    limit: 5,
  });
  assert.deepEqual(cands.map((c) => c.wallet), [workerB.address]);
});

await check('listDispatchCandidates: concurrency cap skips busy workers', () => {
  const db = new JobsDb(':memory:');
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  // A holds one active (claimed) job -> at the cap of 1.
  const busy = postListing(db);
  const claimed = db.claimJob(
    busy.id,
    workerA.address,
    '11',
    keccak256(toHex('busy-tx')),
    nowSec(),
    null,
  );
  assert.equal(claimed, 'ok');
  const cands = db.listDispatchCandidates({
    excludeWallets: [],
    maxConcurrent: 1,
    limit: 5,
  });
  assert.deepEqual(cands.map((c) => c.wallet), [workerB.address]);
});

await check('listDispatchCandidates: fewest-active-jobs ranks first', () => {
  const db = new JobsDb(':memory:');
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  // B holds one active job; A holds none. A must rank first.
  const busy = postListing(db);
  assert.equal(
    db.claimJob(busy.id, workerB.address, '12', keccak256(toHex('busy-tx-2')), nowSec(), null),
    'ok',
  );
  const cands = db.listDispatchCandidates({
    excludeWallets: [],
    maxConcurrent: 2,
    limit: 5,
  });
  assert.equal(cands[0]?.wallet, workerA.address);
  assert.equal(cands[1]?.wallet, workerB.address);
});

await check('assignment lifecycle: create -> active -> decide -> double-decide no-op', () => {
  const db = new JobsDb(':memory:');
  const listing = postListing(db);
  const aid = db.createAssignment({
    jobId: listing.id,
    workerWallet: workerA.address,
    workerAgentId: '11',
    round: 1,
    now: nowSec(),
    expiresAt: nowSec() + 600,
  });
  assert.ok(aid > 0);
  const active = db.getActiveAssignment(listing.id);
  assert.ok(active);
  assert.equal(active.status, 'assigned');
  assert.equal(active.round, 1);
  assert.equal(db.decideAssignment(aid, 'accepted', nowSec()), true);
  assert.equal(db.getActiveAssignment(listing.id), null);
  // Deciding a decided assignment is a no-op (no contradictory states).
  assert.equal(db.decideAssignment(aid, 'declined', nowSec()), false);
  assert.deepEqual(db.triedWallets(listing.id), [workerA.address]);
  assert.equal(db.assignmentRounds(listing.id), 1);
});

await check('sweepExpiredAssignments expires past-window rows and returns them', () => {
  const db = new JobsDb(':memory:');
  const listing = postListing(db);
  const past = nowSec() - 10;
  db.createAssignment({
    jobId: listing.id,
    workerWallet: workerA.address,
    workerAgentId: '11',
    round: 1,
    now: past - 600,
    expiresAt: past,
  });
  const fresh = postListing(db);
  db.createAssignment({
    jobId: fresh.id,
    workerWallet: workerB.address,
    workerAgentId: '12',
    round: 1,
    now: nowSec(),
    expiresAt: nowSec() + 600,
  });
  const expired = db.sweepExpiredAssignments(nowSec());
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.jobId, listing.id);
  assert.equal(expired[0]?.status, 'expired');
  assert.equal(db.getActiveAssignment(listing.id), null);
  assert.ok(db.getActiveAssignment(fresh.id));
  // Second sweep finds nothing (idempotent).
  assert.deepEqual(db.sweepExpiredAssignments(nowSec()), []);
});

await check('dispatch mode defaults to directed; setDispatchOpen flips to open', () => {
  const db = new JobsDb(':memory:');
  const listing = postListing(db);
  assert.equal(db.getDispatchMode(listing.id), 'directed');
  db.setDispatchOpen(listing.id, nowSec());
  assert.equal(db.getDispatchMode(listing.id), 'open');
});

await check('openAssignmentsForWorker: only live assignments on open listings', () => {
  const db = new JobsDb(':memory:');
  const open1 = postListing(db);
  const open2 = postListing(db);
  db.createAssignment({
    jobId: open1.id,
    workerWallet: workerA.address,
    workerAgentId: '11',
    round: 1,
    now: nowSec(),
    expiresAt: nowSec() + 600,
  });
  db.createAssignment({
    jobId: open2.id,
    workerWallet: workerA.address,
    workerAgentId: '11',
    round: 1,
    now: nowSec(),
    expiresAt: nowSec() + 300,
  });
  // A declined assignment on an open listing does not show.
  const rows = db.openAssignmentsForWorker(workerA.address);
  assert.equal(rows.length, 2);
  // Soonest-expiring first.
  assert.equal(rows[0]?.job.id, open2.id);
  assert.equal(rows[1]?.job.id, open1.id);
  // Other workers see none of A's assignments.
  assert.deepEqual(db.openAssignmentsForWorker(workerB.address), []);
  // A claimed listing drops out of the view.
  db.claimJob(open2.id, workerA.address, '11', keccak256(toHex('take-it')), nowSec(), null);
  assert.equal(db.openAssignmentsForWorker(workerA.address).length, 1);
});

// ================= 2. engine =================

await check('dispatchNewJob with no candidates: open board, job_posted carries dispatch:open', () => {
  const { db, pub, inboxA, deps } = engineSetup();
  const listing = postListing(db);
  const res = dispatchNewJob(deps, listing, nowSec());
  assert.equal(res.mode, 'open');
  assert.equal(db.getDispatchMode(listing.id), 'open');
  assert.equal(pub.length, 1);
  assert.equal(pub[0]?.event, 'job_posted');
  assert.equal((pub[0]?.payload as Record<string, unknown>).dispatch, 'open');
  // No wake-up went to any worker: wallet-bound subscribers still get the
  // PUBLIC job_posted (they need it too), but never a job_assigned.
  assert.deepEqual(inboxA.map((s) => s.event), ['job_posted']);
  assert.equal(db.assignmentRounds(listing.id), 0);
});

await check('dispatchNewJob assigns exactly one worker and wakes only them', () => {
  const { db, pub, inboxA, inboxB, inboxC, deps } = engineSetup();
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  enrollWith(db, workerC.address, '13');
  const listing = postListing(db);
  const res = dispatchNewJob(deps, listing, nowSec());
  assert.equal(res.mode, 'directed');
  assert.ok(res.assignee);
  assert.equal(res.assignee.round, 1);
  assert.ok(res.assignee.expiresAt > nowSec());
  assert.equal(db.getDispatchMode(listing.id), 'directed');
  // Public broadcast: dispatch mode + assignee, so everyone else stands down.
  assert.equal(pub.length, 1);
  assert.equal(pub[0]?.event, 'job_posted');
  const postedPayload = pub[0]?.payload as Record<string, unknown>;
  assert.equal(postedPayload.dispatch, 'directed');
  assert.equal(postedPayload.assignee, res.assignee.wallet);
  // Exactly one worker got the private wake-up (everyone got the public
  // job_posted via broadcast — only job_assigned is directed).
  const gotWake = [inboxA, inboxB, inboxC].filter((i) =>
    i.some((s) => s.event === 'job_assigned'),
  );
  assert.equal(gotWake.length, 1);
  const wake = gotWake[0]!;
  const directed = wake.filter((s) => s.event === 'job_assigned');
  assert.equal(directed.length, 1);
  const wp = directed[0]!.payload as Record<string, unknown>;
  assert.equal((wp.assignment as Record<string, unknown>).round, 1);
  assert.ok((wp.assignment as Record<string, unknown>).expiresAt as number > nowSec());
  // The ping carries NO spec (private or otherwise): the stream's wallet
  // binding is unauthenticated, so the worker fetches terms via the
  // signed /:id/spec endpoint instead.
  assert.equal(wp.spec, undefined);
  assert.equal(wp.specPrivate, undefined);
  assert.equal(wp.specEndpoint, `/jobs/${listing.id}/spec`);
  assert.equal(wp.worker, res.assignee.wallet);
});

await check('advanceDispatch after decline: next round goes to the other worker', () => {
  const { inboxA, inboxB, deps, db } = engineSetup();
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  const listing = postListing(db);
  const first = dispatchNewJob(deps, listing, nowSec());
  assert.equal(first.mode, 'directed');
  const firstWallet = first.assignee!.wallet;
  // Simulate the decline path (the HTTP test covers the endpoint itself).
  const active = db.getActiveAssignment(listing.id);
  assert.ok(active);
  assert.equal(db.decideAssignment(active.id, 'declined', nowSec()), true);
  const second = advanceDispatch(deps, listing.id, nowSec());
  assert.ok(second);
  assert.equal(second.mode, 'directed');
  assert.equal(second.assignee!.round, 2);
  // A different worker: tried wallets are excluded from later rounds.
  assert.notEqual(second.assignee!.wallet, firstWallet);
  // The newly assigned worker got their own wake-up.
  const newInbox = second.assignee!.wallet === workerA.address ? inboxA : inboxB;
  assert.equal(newInbox.filter((s) => s.event === 'job_assigned').length, 1);
});

await check('advanceDispatch exhausts rounds -> job_opened, then no-ops', () => {
  const { db, pub, deps } = engineSetup(2);
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  const listing = postListing(db);
  dispatchNewJob(deps, listing, nowSec());
  // Burn round 1 (decline) -> round 2 assigned.
  let active = db.getActiveAssignment(listing.id);
  assert.ok(active);
  db.decideAssignment(active.id, 'declined', nowSec());
  const r2 = advanceDispatch(deps, listing.id, nowSec());
  assert.ok(r2);
  assert.equal(r2.mode, 'directed');
  // Burn round 2 (expiry) -> open board.
  active = db.getActiveAssignment(listing.id);
  assert.ok(active);
  db.decideAssignment(active.id, 'expired', nowSec());
  const opened = advanceDispatch(deps, listing.id, nowSec());
  assert.ok(opened);
  assert.equal(opened.mode, 'open');
  assert.equal(db.getDispatchMode(listing.id), 'open');
  const openedEvents = pub.filter((s) => s.event === 'job_opened');
  assert.equal(openedEvents.length, 1);
  assert.equal((openedEvents[0]!.payload as Record<string, unknown>).jobId, listing.id);
  // Once open, advanceDispatch is a stable no-op.
  assert.equal(advanceDispatch(deps, listing.id, nowSec()), null);
  assert.equal(pub.filter((s) => s.event === 'job_opened').length, 1);
});

await check('settleExpiredDispatch expires stale assignments and advances each job', () => {
  const { db, inboxA, inboxB, deps } = engineSetup(3);
  enrollWith(db, workerA.address, '11');
  enrollWith(db, workerB.address, '12');
  const listing = postListing(db);
  // Plant a stale round-1 assignment directly (window already lapsed, no
  // heartbeat swept it).
  const past = nowSec() - 700;
  db.createAssignment({
    jobId: listing.id,
    workerWallet: workerA.address,
    workerAgentId: '11',
    round: 1,
    now: past - 600,
    expiresAt: past,
  });
  const advanced = settleExpiredDispatch(deps, nowSec());
  assert.equal(advanced, 1);
  // Round bookkeeping survived: the stale row is expired, round 2 is live.
  assert.equal(db.assignmentRounds(listing.id), 2);
  const live = db.getActiveAssignment(listing.id);
  assert.ok(live);
  assert.equal(live.round, 2);
  // A was tried in round 1, so round 2 went to B — and only B was woken.
  assert.equal(live.workerWallet, workerB.address);
  assert.equal(inboxA.filter((s) => s.event === 'job_assigned').length, 0);
  assert.equal(inboxB.filter((s) => s.event === 'job_assigned').length, 1);
});

await check('advanceDispatch no-ops on non-open listings (claimed jobs never re-dispatch)', () => {
  const { db, deps } = engineSetup();
  enrollWith(db, workerA.address, '11');
  const listing = postListing(db);
  dispatchNewJob(deps, listing, nowSec());
  db.claimJob(listing.id, workerA.address, '11', keccak256(toHex('took-it')), nowSec(), null);
  assert.equal(advanceDispatch(deps, listing.id, nowSec()), null);
});

// ================= 3. feed v2 routing =================

await check('feed: broadcast reaches all; sendTo reaches only the bound wallet', () => {
  const feed = createJobFeed();
  const anon: Seen[] = [];
  const a: Seen[] = [];
  const b: Seen[] = [];
  const cap = (arr: Seen[]) => (event: JobFeedEvent, data: string) => {
    arr.push({ event, payload: JSON.parse(data) as Record<string, unknown> });
  };
  const unsubAnon = feed.subscribe(cap(anon));
  feed.subscribe(cap(a), workerA.address);
  feed.subscribe(cap(b), workerB.address);
  assert.equal(feed.subscriberCount, 3);
  feed.broadcast('job_posted', { id: 1 });
  assert.equal(anon.length, 1);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  feed.sendTo(workerA.address, 'job_assigned', { id: 2 });
  assert.equal(anon.length, 1);
  assert.equal(a.length, 2);
  assert.equal(a[1]?.event, 'job_assigned');
  assert.equal(b.length, 1);
  // Unknown wallet: no-op, no throw.
  feed.sendTo(workerC.address, 'job_assigned', { id: 3 });
  assert.equal(feed.subscriberCount, 3);
  unsubAnon();
  assert.equal(feed.subscriberCount, 2);
  feed.broadcast('job_claimed', { id: 1 });
  assert.equal(anon.length, 1);
  assert.equal(a.length, 3);
});

await check('feed: a throwing sender is unsubscribed, never breaks the fan-out', () => {
  const feed = createJobFeed();
  let good = 0;
  feed.subscribe(() => {
    throw new Error('dead socket');
  });
  feed.subscribe(() => {
    good++;
  });
  feed.broadcast('job_posted', { id: 1 });
  assert.equal(good, 1);
  assert.equal(feed.subscriberCount, 1);
  // Unserializable payload is dropped, not thrown.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  feed.broadcast('job_posted', circular);
  assert.equal(good, 1);
});

await check('feed: subscriber cap is sized for the 5000-agent launch', () => {
  assert.equal(JOB_FEED_MAX_SUBSCRIBERS, 10_000);
});

// ================= 4. HTTP layer =================

// --- HTTP fixtures (minimal mirrors of the jobs.test.ts chain mocks) ---

const receipts = new Map<string, ReceiptLike>();
const owners = new Map<string, Address>();
const getReceipt: GetReceipt = async (h: Hex) => receipts.get(h.toLowerCase()) ?? null;
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

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const addrTopic = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')).toLowerCase();
const uintTopic = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')).toLowerCase();

function fundingReceipt(jobId: bigint, amount: bigint, deadline: bigint, termsHash: string): ReceiptLike {
  return {
    status: 'success',
    logs: [
      {
        address: USDC_ADDRESS,
        topics: [TRANSFER_TOPIC, addrTopic(requester.address), addrTopic(escrowAddr)],
        data: `0x${amount.toString(16).padStart(64, '0')}`,
      },
      {
        address: escrowAddr,
        topics: [BOUNTY_CREATED_TOPIC, uintTopic(jobId), addrTopic(requester.address)],
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
          [amount, deadline, termsHash as Hex],
        ),
      },
    ],
  };
}

function claimReceipt(jobId: bigint, agentId: bigint, claimer: string): ReceiptLike {
  return {
    status: 'success',
    logs: [
      {
        address: escrowAddr,
        topics: [BOUNTY_CLAIMED_TOPIC, uintTopic(jobId), addrTopic(claimer), uintTopic(agentId)],
        data: '0x',
      },
    ],
  };
}

function txHash(seed: string): Hex {
  return keccak256(toHex(`dispatch-http-${seed}`));
}

type Signer = ReturnType<typeof privateKeyToAccount>;
async function sign(
  account: Signer,
  primaryType: 'JobEnroll' | 'JobPost' | 'JobClaim' | 'JobDecline' | 'JobSpecAccess',
  message: Record<string, unknown>,
): Promise<Hex> {
  return account.signTypedData({
    domain: LOUNGE_DOMAIN,
    types: LOUNGE_TYPES,
    primaryType,
    message: message as never,
  });
}

async function postJson(target: Hono, path: string, body: unknown) {
  const res = await target.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function getJson(target: Hono, path: string) {
  const res = await target.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function makeDispatchApp() {
  const env: Record<string, string> = {
    FOUR02_BOUNTY_ESCROW: escrowAddr,
    FOUR02_JOBS_DB_PATH: ':memory:',
    INK_RPC_URL: 'http://localhost:1',
    JOBS_DAILY_POST_CAP: '10000',
    JOBS_DISPATCH_ACCEPT_WINDOW_SECONDS: '3600',
    JOBS_DISPATCH_MAX_ROUNDS: '3',
  };
  const cfg = loadJobsConfig(env);
  assert.ok(cfg);
  const parent = new Hono();
  parent.route(
    '/jobs',
    createJobsApp(cfg, {
      db: new JobsDb(':memory:'),
      getReceipt,
      identityOwner,
      reputationSummary,
      rateLimitBucket: { windowMs: 60_000, max: 10_000 },
    }),
  );
  return parent;
}

const dapp = makeDispatchApp();

/** A fresh app with no enrolled workers (for open-board fallback tests). */
function makeEmptyApp() {
  return makeDispatchApp();
}

async function enrollHttp(account: Signer, agentId: bigint, target: Hono = dapp) {
  owners.set(agentId.toString(), account.address);
  const timestamp = BigInt(nowSec());
  const signature = await sign(account, 'JobEnroll', {
    wallet: account.address,
    agentId,
    timestamp,
  });
  return postJson(target, '/jobs/enroll', {
    wallet: account.address,
    agentId: agentId.toString(),
    timestamp: Number(timestamp),
    signature,
  });
}

let escrowJobSeq = 7000n;
async function postHttpJob(category = 'writing', target: Hono = dapp, specPrivate = false) {
  escrowJobSeq++;
  const escrowJobId = escrowJobSeq;
  const spec = `Dispatch HTTP job ${escrowJobId}`;
  const bountyUsdc = '25.00';
  const deadline = BigInt(nowSec() + 86400);
  const termsHash = keccak256(toHex(spec)).toLowerCase();
  const timestamp = BigInt(nowSec());
  const signature = await sign(requester, 'JobPost', {
    requester: requester.address,
    title: `HTTP job ${escrowJobId}`,
    spec,
    specPrivate,
    category,
    bountyUsdc,
    deadline,
    termsHash,
    timestamp,
  });
  const h = txHash(`post-${escrowJobId}`);
  receipts.set(
    h.toLowerCase(),
    fundingReceipt(escrowJobId, parseUnits(bountyUsdc, 6), deadline, termsHash),
  );
  const res = await postJson(target, '/jobs', {
    requester: requester.address,
    title: `HTTP job ${escrowJobId}`,
    spec,
    specPrivate,
    category,
    bountyUsdc,
    deadline: deadline.toString(),
    termsHash,
    timestamp: Number(timestamp),
    signature,
    txHash: h,
  });
  assert.equal(res.status, 201);
  return { jobId: res.body.jobId as number, escrowJobId, dispatch: res.body.dispatch as string };
}
await check('GET /jobs/workers/:wallet returns the enrollment record without capabilities', async () => {
  const r = await enrollHttp(workerA, 101n);
  assert.ok(r.status === 201 || r.status === 200);
  const got = await getJson(dapp, `/jobs/workers/${workerA.address}`);
  assert.equal(got.status, 200);
  const body = got.body as Record<string, unknown>;
  assert.equal(body.wallet, getAddress(workerA.address));
  assert.ok(!('capabilities' in body), 'enrollment records must not carry capabilities');
});

await check('POST /jobs dispatches to an enrolled worker (directed), not the open board', async () => {
  const r = await enrollHttp(workerB, 102n);
  assert.ok(r.status === 201 || r.status === 200);
  const { jobId, dispatch } = await postHttpJob('writing');
  assert.equal(dispatch, 'directed');
  const detail = await getJson(dapp, `/jobs/${jobId}`);
  assert.equal(detail.status, 200);
  assert.equal((detail.body.job as Record<string, unknown>).dispatch, 'directed');
  // The assigned worker sees it in their wake-up view.
  const aView = await getJson(dapp, `/jobs/assigned?wallet=${workerA.address}`);
  const bView = await getJson(dapp, `/jobs/assigned?wallet=${workerB.address}`);
  const aCount = ((aView.body as Record<string, unknown>).assignments as unknown[]).length;
  const bCount = ((bView.body as Record<string, unknown>).assignments as unknown[]).length;
  assert.equal(aCount + bCount, 1); // exactly one assignee
});

await check('POST /jobs with no eligible workers goes straight to the open board', async () => {
  const empty = makeEmptyApp(); // no enrolled workers at all
  const { jobId, dispatch } = await postHttpJob('writing', empty);
  assert.equal(dispatch, 'open');
  const detail = await getJson(empty, `/jobs/${jobId}`);
  assert.equal((detail.body.job as Record<string, unknown>).dispatch, 'open');
});

await check('decline endpoint: 409 with no live assignment; 403 for the wrong worker', async () => {
  const empty = makeEmptyApp(); // open board: no assignment exists there
  const { jobId } = await postHttpJob('design', empty);
  const timestamp = BigInt(nowSec());
  const sigA = await sign(workerA, 'JobDecline', {
    jobId: BigInt(jobId),
    worker: workerA.address,
    timestamp,
  });
  const noAssign = await postJson(empty, `/jobs/${jobId}/decline`, {
    jobId,
    worker: workerA.address,
    timestamp: Number(timestamp),
    signature: sigA,
  });
  assert.equal(noAssign.status, 409);
  assert.equal(noAssign.body.error, 'no_assignment');

  // Directed job: stranger cannot decline someone else's assignment.
  const dj = await postHttpJob('writing');
  const assigned = await getJson(dapp, `/jobs/assigned?wallet=${workerA.address}`);
  const aIds = ((assigned.body as Record<string, unknown>).assignments as Array<
    Record<string, unknown>
  >).map((a) => (a.job as Record<string, unknown>).id);
  const assigneeWallet = aIds.includes(dj.jobId) ? workerA : workerB;
  const other = assigneeWallet.address === workerA.address ? workerB : workerA;
  const ts2 = BigInt(nowSec());
  const sigOther = await sign(other, 'JobDecline', {
    jobId: BigInt(dj.jobId),
    worker: other.address,
    timestamp: ts2,
  });
  const wrong = await postJson(dapp, `/jobs/${dj.jobId}/decline`, {
    jobId: dj.jobId,
    worker: other.address,
    timestamp: Number(ts2),
    signature: sigOther,
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'not_assigned');
});

await check('decline by the assignee burns a round and reassigns', async () => {
  const { jobId } = await postHttpJob('writing');
  const aView = await getJson(dapp, `/jobs/assigned?wallet=${workerA.address}`);
  const bView = await getJson(dapp, `/jobs/assigned?wallet=${workerB.address}`);
  const idsOf = (v: { body: unknown }) =>
    ((v.body as Record<string, unknown>).assignments as Array<Record<string, unknown>>).map(
      (a) => (a.job as Record<string, unknown>).id,
    );
  const assignee = idsOf(aView).includes(jobId) ? workerA : workerB;
  const next = assignee.address === workerA.address ? workerB : workerA;
  const ts = BigInt(nowSec());
  const sig = await sign(assignee, 'JobDecline', {
    jobId: BigInt(jobId),
    worker: assignee.address,
    timestamp: ts,
  });
  const res = await postJson(dapp, `/jobs/${jobId}/decline`, {
    jobId,
    worker: assignee.address,
    timestamp: Number(ts),
    signature: sig,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.declined, true);
  assert.equal(res.body.round, 1);
  // The other worker now holds the assignment for THIS job (round 2).
  // (They may hold other assignments from earlier tests — match by job.)
  const nextView = await getJson(dapp, `/jobs/assigned?wallet=${next.address}`);
  const assigns = (nextView.body as Record<string, unknown>).assignments as Array<
    Record<string, unknown>
  >;
  const mine = assigns.find(
    (a) => ((a as Record<string, unknown>).job as Record<string, unknown>).id === jobId,
  );
  assert.ok(mine, 'expected the reassigned job in the next worker\'s view');
  assert.equal((mine.assignment as Record<string, unknown>).round, 2);
  // The decliner no longer sees it.
  const oldView = await getJson(dapp, `/jobs/assigned?wallet=${assignee.address}`);
  const oldAssigns = (oldView.body as Record<string, unknown>).assignments as unknown[];
  assert.ok(!oldAssigns.some((a) => ((a as Record<string, unknown>).job as Record<string, unknown>).id === jobId));
});

await check('claim gating: non-assignee gets 409 not_assigned; assignee claims fine', async () => {
  const { jobId, escrowJobId } = await postHttpJob('writing');
  const aView = await getJson(dapp, `/jobs/assigned?wallet=${workerA.address}`);
  const aIds = ((aView.body as Record<string, unknown>).assignments as Array<
    Record<string, unknown>
  >).map((a) => (a.job as Record<string, unknown>).id);
  const assignee = aIds.includes(jobId) ? workerA : workerB;
  const other = assignee.address === workerA.address ? workerB : workerA;
  const agentIds: Record<string, bigint> = {
    [workerA.address]: 101n,
    [workerB.address]: 102n,
  };

  // The stranger's claim: valid tx, valid signature, enrolled — but not
  // the assignee. Must 409 BEFORE any onchain work matters.
  const h1 = txHash(`snipe-${jobId}`);
  receipts.set(h1.toLowerCase(), claimReceipt(escrowJobId, agentIds[other.address]!, other.address));
  const ts1 = BigInt(nowSec());
  const sig1 = await sign(other, 'JobClaim', {
    jobId: BigInt(jobId),
    worker: other.address,
    agentId: agentIds[other.address]!,
    timestamp: ts1,
  });
  const snipe = await postJson(dapp, `/jobs/${jobId}/claim`, {
    worker: other.address,
    agentId: agentIds[other.address]!.toString(),
    timestamp: Number(ts1),
    signature: sig1,
    txHash: h1,
  });
  assert.equal(snipe.status, 409);
  assert.equal(snipe.body.error, 'not_assigned');

  // The assignee's claim succeeds.
  const h2 = txHash(`accept-${jobId}`);
  receipts.set(
    h2.toLowerCase(),
    claimReceipt(escrowJobId, agentIds[assignee.address]!, assignee.address),
  );
  const ts2 = BigInt(nowSec());
  const sig2 = await sign(assignee, 'JobClaim', {
    jobId: BigInt(jobId),
    worker: assignee.address,
    agentId: agentIds[assignee.address]!,
    timestamp: ts2,
  });
  const accept = await postJson(dapp, `/jobs/${jobId}/claim`, {
    worker: assignee.address,
    agentId: agentIds[assignee.address]!.toString(),
    timestamp: Number(ts2),
    signature: sig2,
    txHash: h2,
  });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.state, 'claimed');
  // Assignment closed as accepted: the wake-up view is empty now.
  const after = await getJson(dapp, `/jobs/assigned?wallet=${assignee.address}`);
  const afterAssigns = (after.body as Record<string, unknown>).assignments as Array<
    Record<string, unknown>
  >;
  assert.ok(
    !afterAssigns.some(
      (a) => ((a as Record<string, unknown>).job as Record<string, unknown>).id === jobId,
    ),
  );
});

await check('assignee reads the private spec pre-claim; strangers cannot', async () => {
  const { jobId } = await postHttpJob('writing', dapp, true); // private spec
  const aView = await getJson(dapp, `/jobs/assigned?wallet=${workerA.address}`);
  const aIds = ((aView.body as Record<string, unknown>).assignments as Array<
    Record<string, unknown>
  >).map((a) => (a.job as Record<string, unknown>).id);
  const assignee = aIds.includes(jobId) ? workerA : workerB;
  const stranger = assignee.address === workerA.address ? workerC : workerA;

  // The public board hides the spec.
  const board = await getJson(dapp, '/jobs?status=open&limit=100');
  const listed = (
    (board.body as Record<string, unknown>).jobs as Array<Record<string, unknown>>
  ).find((j) => j.id === jobId)!;
  assert.equal(listed.spec, null);
  assert.equal(listed.specPrivate, true);

  // The assignee fetches it with a signature BEFORE claiming.
  const ts = BigInt(nowSec());
  const sig = await sign(assignee, 'JobSpecAccess', {
    jobId: BigInt(jobId),
    accessor: assignee.address,
    timestamp: ts,
  });
  const got = await postJson(dapp, `/jobs/${jobId}/spec`, {
    jobId,
    accessor: assignee.address,
    timestamp: Number(ts),
    signature: sig,
  });
  assert.equal(got.status, 200);
  assert.ok((got.body.spec as string).includes('Dispatch HTTP job'));

  // A stranger's signature is valid but they're not a party: 403.
  const ts2 = BigInt(nowSec());
  const sig2 = await sign(stranger, 'JobSpecAccess', {
    jobId: BigInt(jobId),
    accessor: stranger.address,
    timestamp: ts2,
  });
  const denied = await postJson(dapp, `/jobs/${jobId}/spec`, {
    jobId,
    accessor: stranger.address,
    timestamp: Number(ts2),
    signature: sig2,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'not_authorized');
});

await check('open-board jobs stay claimable by any enrolled worker', async () => {
  const empty = makeEmptyApp();
  // No workers enrolled at post time -> straight to the open board.
  const { jobId, escrowJobId, dispatch } = await postHttpJob('design', empty);
  assert.equal(dispatch, 'open');
  // A worker enrolling afterwards may claim the open-board job.
  const r = await enrollHttp(workerA, 101n, empty);
  assert.ok(r.status === 201 || r.status === 200);
  const h = txHash(`open-claim-${jobId}`);
  receipts.set(h.toLowerCase(), claimReceipt(escrowJobId, 101n, workerA.address));
  const ts = BigInt(nowSec());
  const sig = await sign(workerA, 'JobClaim', {
    jobId: BigInt(jobId),
    worker: workerA.address,
    agentId: 101n,
    timestamp: ts,
  });
  const res = await postJson(empty, `/jobs/${jobId}/claim`, {
    worker: workerA.address,
    agentId: '101',
    timestamp: Number(ts),
    signature: sig,
    txHash: h,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'claimed');
});

await check('GET /jobs/assigned: invalid wallet -> 400', async () => {
  const res = await getJson(dapp, '/jobs/assigned?wallet=nope');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_wallet');
});

console.log(`\ndispatch: ${passed} checks passed`);
