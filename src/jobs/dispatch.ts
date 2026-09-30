/**
 * 402 Job Marketplace — directed dispatch engine.
 *
 * Built for the 5000-agent launch: when a job is posted, the server assigns
 * it to exactly ONE eligible worker and wakes that worker over the feed
 * (`job_assigned`, routed to their connection only). No claim races, no
 * thundering herd, no wasted gas on reverted claims.
 *
 * Assignment lifecycle per job:
 *   post -> round 1 assigned (accept window) -> claimed (accepted)
 *                                            -> declined/expired -> round 2
 *                                            -> ... -> open board fallback
 *
 * After `maxRounds` failed rounds (declines + expiries), the job falls back
 * to the open board (`job_opened`, public): any enrolled worker may claim
 * it, exactly like the pre-dispatch board. Nothing ever dead-ends.
 *
 * Eligibility is enrollment only: any enrolled worker may be assigned
 * any job — workers carry no platform capabilities. Categories live on
 * jobs as metadata (floor pricing, board filtering); the dispatcher
 * ranks on fewest active jobs -> least-recently-assigned -> random.
 *
 * Ranking: fewest active jobs -> least-recently-assigned -> random.
 * (Reputation weighting needs an onchain read per candidate — it does not
 * scale to thousands of workers per post. A keeper-fed cached reputation
 * column is the follow-up.)
 *
 * Trust note: directed dispatch is API-layer. The escrow contract stays
 * permissionless — a sniper COULD claimBounty onchain for an assigned job,
 * but they would still have to stake $1 AND do the work to get paid, so
 * sniping steals an obligation, not money. Economically irrational by
 * construction.
 */

import type { Address } from 'viem';
import type { JobListing, JobsDb } from './db.js';
import type { JobFeed } from './feed.js';

export interface DispatchDeps {
  db: JobsDb;
  feed: JobFeed;
  /** Seconds the assigned worker has to claim before expiry. */
  acceptWindowSeconds: number;
  /** Failed rounds before the job falls back to the open board. */
  maxRounds: number;
  /** Active-job cap for candidate selection. */
  maxConcurrentJobs: number;
  /** Public job shape for event payloads. */
  publicJob: (l: JobListing) => Record<string, unknown>;
}

export interface DispatchResult {
  /** 'directed' when a worker was assigned, 'open' on fallback. */
  mode: 'directed' | 'open';
  assignee?: { wallet: Address; agentId: string; round: number; expiresAt: number };
}

/**
 * Dispatch a freshly posted job: try one directed assignment, else open
 * the board. Broadcasts `job_posted` (public, with the dispatch mode) and,
 * when directed, the private `job_assigned` wake-up.
 */
export function dispatchNewJob(
  deps: DispatchDeps,
  listing: JobListing,
  now: number,
): DispatchResult {
  const { db, feed } = deps;
  const exclude = [listing.requester];
  const candidates = db.listDispatchCandidates({
    excludeWallets: exclude,
    maxConcurrent: deps.maxConcurrentJobs,
    limit: 1,
  });
  const job = deps.publicJob(listing);
  if (candidates.length === 0) {
    db.setDispatchOpen(listing.id, now);
    feed.broadcast('job_posted', { job, dispatch: 'open' as const });
    return { mode: 'open' };
  }
  const c = candidates[0]!;
  const expiresAt = now + deps.acceptWindowSeconds;
  db.createAssignment({
    jobId: listing.id,
    workerWallet: c.wallet,
    workerAgentId: c.agentId,
    round: 1,
    now,
    expiresAt,
  });
  feed.broadcast('job_posted', {
    job,
    dispatch: 'directed' as const,
    assignee: c.wallet,
  });
  // The wake-up: routed ONLY to the assignee's connection(s). This is a
  // PING, not a payload — it carries no spec, private or otherwise. The
  // stream's wallet binding is unauthenticated (anyone can subscribe as
  // any wallet), so private terms never ride the stream: the worker
  // fetches them via POST /jobs/:id/spec with a JobSpecAccess signature,
  // which proves key ownership. An impersonated subscription leaks only
  // what job_posted already made public.
  feed.sendTo(c.wallet, 'job_assigned', {
    job,
    worker: c.wallet,
    agentId: c.agentId,
    assignment: { round: 1, assignedAt: now, expiresAt },
    specEndpoint: `/jobs/${listing.id}/spec`,
  });
  return {
    mode: 'directed',
    assignee: { wallet: c.wallet, agentId: c.agentId, round: 1, expiresAt },
  };
}

/**
 * Advance a job after a decline or expiry: next round, or open the board
 * when rounds (or candidates) run out. No-op unless the listing is still
 * open and still on the directed path.
 */
export function advanceDispatch(
  deps: DispatchDeps,
  jobId: number,
  now: number,
): DispatchResult | null {
  const { db, feed } = deps;
  const listing = db.getJob(jobId);
  if (!listing || listing.state !== 'open') return null;
  if (db.getDispatchMode(jobId) === 'open') return null;

  const openIt = (): DispatchResult => {
    db.setDispatchOpen(jobId, now);
    feed.broadcast('job_opened', {
      jobId,
      job: deps.publicJob(listing),
    });
    return { mode: 'open' };
  };

  const rounds = db.assignmentRounds(jobId);
  if (rounds >= deps.maxRounds) return openIt();

  const tried = db.triedWallets(jobId);
  const candidates = db.listDispatchCandidates({
    excludeWallets: [listing.requester, ...tried],
    maxConcurrent: deps.maxConcurrentJobs,
    limit: 1,
  });
  if (candidates.length === 0) return openIt();

  const c = candidates[0]!;
  const round = rounds + 1;
  const expiresAt = now + deps.acceptWindowSeconds;
  db.createAssignment({
    jobId,
    workerWallet: c.wallet,
    workerAgentId: c.agentId,
    round,
    now,
    expiresAt,
  });
  feed.sendTo(c.wallet, 'job_assigned', {
    job: deps.publicJob(listing),
    worker: c.wallet,
    agentId: c.agentId,
    assignment: { round, assignedAt: now, expiresAt },
    specEndpoint: `/jobs/${jobId}/spec`,
  });
  return {
    mode: 'directed',
    assignee: { wallet: c.wallet, agentId: c.agentId, round, expiresAt },
  };
}

/**
 * Lazy expiry sweeper: expire every live assignment past its window, then
 * advance each affected job (next round or open board). Runs on the
 * dispatch read/write paths — no cron needed. Returns the number of jobs
 * advanced.
 */
export function settleExpiredDispatch(deps: DispatchDeps, now: number): number {
  const expired = deps.db.sweepExpiredAssignments(now);
  let advanced = 0;
  for (const a of expired) {
    if (advanceDispatch(deps, a.jobId, now)) advanced++;
  }
  return advanced;
}
