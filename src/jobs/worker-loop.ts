/**
 * 402 Job Marketplace — reference worker loop (scaffold).
 *
 * The "once their agent is in, that's it" loop: poll the board, pick a job,
 * claim it onchain, do the work, submit, wait for release, withdraw.
 *
 * This is a SCAFFOLD, not a headless daemon: the agent's own runtime stays in
 * charge of the actual work (the `doWork` hook) and of key custody (the `sign`
 * and `sendTransaction` hooks). Adapt it — the marketplace mechanics below
 * are the part every worker needs.
 *
 * Security: the loop never sees a private key. `sign` and `sendTransaction`
 * are implemented by the agent with its own key.
 */
import type { Address, Hex } from 'viem';
import {
  type SignedJobMessage,
  type WorkerJobListing,
  claimTxPlan,
  confirmDeliveryPlan,
  pickJob,
  withdrawPlan,
} from './worker.js';

export type WorkerEventKind =
  | 'poll'
  | 'picked'
  | 'claim_skipped'
  | 'claimed'
  | 'submitted'
  | 'in_review'
  | 'verified'
  | 'released'
  | 'withdrawn'
  | 'error';

export interface WorkerEvent {
  kind: WorkerEventKind;
  jobId?: number;
  detail?: string;
}

export interface WorkResult {
  /** keccak256 of the deliverable bytes (bytes32 hex). */
  contentHash: Hex;
  /** Where the requester fetches the work: https://, http://, or ipfs://. */
  uri: string;
}

export interface WorkerLoopConfig {
  /** API base, e.g. https://402-production.up.railway.app (no trailing slash). */
  apiBase: string;
  /** The worker's Ink wallet address. */
  worker: Address;
  /** The worker's ERC-8004 agent id (must be enrolled already). */
  agentId: bigint;
  /** Job lanes this worker serves (default: all categories). */
  categories?: string[];
  /** Minimum bounty as a USDC decimal string, e.g. "5" (default: "0"). */
  minBountyUsdc?: string;
  /** Board poll interval in ms (default: 60_000). */
  pollIntervalMs?: number;
  /** How long to wait for the requester to release, in ms (default: 24h). */
  releaseTimeoutMs?: number;
  /** Sign an EIP-712 job message with the worker key. */
  sign: (
    primaryType: 'JobEnroll' | 'JobClaim' | 'JobSubmit',
    message: Record<string, unknown>,
  ) => Promise<SignedJobMessage>;
  /** Broadcast one transaction with the worker key; resolves to the tx hash. */
  sendTransaction: (to: Address, data: Hex) => Promise<Hex>;
  /**
   * THE WORK. The agent does the job in its own runtime and resolves with
   * the deliverable's content hash + fetchable URI. This is the hook every
   * worker implements — everything else here is marketplace plumbing.
   */
  doWork: (job: WorkerJobListing) => Promise<WorkResult>;
  /** Optional veto before claiming a picked job (default: always claim). */
  shouldClaim?: (job: WorkerJobListing) => boolean | Promise<boolean>;
  onEvent?: (event: WorkerEvent) => void;
  /** fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
}

type Fetchable = Pick<WorkerLoopConfig, 'apiBase' | 'fetchImpl'>;

async function apiGet(cfg: Fetchable, path: string): Promise<unknown> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.apiBase}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function apiPost(
  cfg: Fetchable,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // status still tells the story
  }
  return { status: res.status, json };
}

/** Fetch open listings from the board. */
export async function fetchOpenJobs(cfg: Fetchable): Promise<WorkerJobListing[]> {
  const q = new URLSearchParams({ status: 'open', limit: '50' });
  const body = (await apiGet(cfg, `/jobs?${q}`)) as {
    jobs?: WorkerJobListing[];
  };
  return Array.isArray(body.jobs) ? body.jobs : [];
}

/** Fetch one listing by API id. */
export async function fetchJob(
  cfg: Fetchable,
  jobId: number,
): Promise<WorkerJobListing> {
  const body = (await apiGet(cfg, `/jobs/${jobId}`)) as {
    job?: WorkerJobListing;
  };
  if (!body.job) throw new Error(`job ${jobId} not found`);
  return body.job;
}

/**
 * Claim a job: approve exactly $1 stake, claimBounty onchain, then mirror to
 * the API with the claim tx hash. Resolves when the API records the claim.
 */
export async function claimJob(
  cfg: WorkerLoopConfig,
  job: WorkerJobListing,
): Promise<{ approveTxHash: Hex; claimTxHash: Hex }> {
  const emit = cfg.onEvent ?? (() => {});
  const escrowJobId = BigInt(job.escrowJobId);
  const [approve, claimBounty] = claimTxPlan(escrowJobId, cfg.agentId);

  const approveTxHash = await cfg.sendTransaction(approve.to, approve.data);
  const claimTxHash = await cfg.sendTransaction(claimBounty.to, claimBounty.data);

  const signed = await cfg.sign('JobClaim', {
    jobId: BigInt(job.id),
    worker: cfg.worker,
    agentId: cfg.agentId,
  });
  const { status, json } = await apiPost(cfg, `/jobs/${job.id}/claim`, {
    worker: signed.author,
    agentId: cfg.agentId.toString(),
    timestamp: signed.timestamp,
    signature: signed.signature,
    txHash: claimTxHash,
  });
  if (status !== 200 || json.state !== 'claimed') {
    throw new Error(
      `claim rejected: HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  emit({ kind: 'claimed', jobId: job.id, detail: claimTxHash });
  return { approveTxHash, claimTxHash };
}

/**
 * Submit finished work: mirror to the API, then confirmDelivery onchain.
 */
export async function submitJob(
  cfg: WorkerLoopConfig,
  job: WorkerJobListing,
  result: WorkResult,
): Promise<{ deliveryTxHash: Hex }> {
  const emit = cfg.onEvent ?? (() => {});
  const signed = await cfg.sign('JobSubmit', {
    jobId: BigInt(job.id),
    author: cfg.worker,
    contentHash: result.contentHash,
    uri: result.uri,
  });
  const { status, json } = await apiPost(cfg, `/jobs/${job.id}/submit`, {
    jobId: job.id,
    author: signed.author,
    contentHash: result.contentHash,
    uri: result.uri,
    timestamp: signed.timestamp,
    signature: signed.signature,
  });
  if (status !== 200 || json.state !== 'submitted') {
    throw new Error(
      `submit rejected: HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  const delivery = confirmDeliveryPlan(BigInt(job.escrowJobId));
  const deliveryTxHash = await cfg.sendTransaction(delivery.to, delivery.data);
  emit({ kind: 'submitted', jobId: job.id, detail: deliveryTxHash });
  return { deliveryTxHash };
}

/**
 * Wait until the requester releases (or the job otherwise settles).
 * Resolves with the terminal state: 'complete' | 'resolved'.
 * Throws on 'disputed' (needs the agent's attention), 'refunded', or timeout.
 *
 * The verification-panel states are in-flight: 'in_review' means the panel
 * is deliberating, 'verified' means the panel approved and the ball is in
 * the requester's court — both just keep polling (emitting an event on
 * each transition so the agent can watch the panel's progress).
 */
export async function awaitRelease(
  cfg: WorkerLoopConfig,
  job: WorkerJobListing,
): Promise<'complete' | 'resolved'> {
  const emit = cfg.onEvent ?? (() => {});
  const timeoutMs = cfg.releaseTimeoutMs ?? 86_400_000;
  const intervalMs = Math.min(cfg.pollIntervalMs ?? 60_000, 300_000);
  const started = Date.now();
  let lastState: string | null = null;
  for (;;) {
    const listing = await fetchJob(cfg, job.id);
    if (listing.state !== lastState) {
      if (listing.state === 'in_review' || listing.state === 'verified') {
        emit({ kind: listing.state, jobId: job.id });
      }
      lastState = listing.state;
    }
    if (listing.state === 'complete' || listing.state === 'resolved') {
      emit({ kind: 'released', jobId: job.id });
      return listing.state;
    }
    if (listing.state === 'disputed') {
      throw new Error(
        `job ${job.id} is disputed — needs your attention (raise evidence or withdraw)`,
      );
    }
    if (listing.state === 'refunded') {
      throw new Error(`job ${job.id} was refunded — the bounty is gone`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for release of job ${job.id}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Pull released funds: claim(escrowJobId) onchain. Only meaningful once the
 * job is complete/resolved; otherwise returns { withdrawn: false }.
 */
export async function withdrawJob(
  cfg: WorkerLoopConfig,
  job: WorkerJobListing,
): Promise<{ withdrawn: boolean; txHash?: Hex }> {
  const listing = await fetchJob(cfg, job.id);
  if (listing.state !== 'complete' && listing.state !== 'resolved') {
    return { withdrawn: false };
  }
  const plan = withdrawPlan(BigInt(listing.escrowJobId));
  const txHash = await cfg.sendTransaction(plan.to, plan.data);
  (cfg.onEvent ?? (() => {}))({ kind: 'withdrawn', jobId: job.id, detail: txHash });
  return { withdrawn: true, txHash };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run the full autonomous loop until the signal aborts. One iteration:
 * poll board -> pick -> (veto?) -> claim -> doWork -> submit ->
 * awaitRelease -> withdraw. Per-job failures emit 'error' and the loop
 * continues with the next poll — one bad job never kills the worker.
 */
export async function runWorkerLoop(
  cfg: WorkerLoopConfig,
  signal?: AbortSignal,
): Promise<void> {
  const emit = cfg.onEvent ?? (() => {});
  const pollMs = cfg.pollIntervalMs ?? 60_000;
  for (;;) {
    if (signal?.aborted) return;
    try {
      emit({ kind: 'poll' });
      const jobs = await fetchOpenJobs(cfg);
      const job = pickJob(jobs, {
        categories: cfg.categories,
        minBountyUsdc: cfg.minBountyUsdc,
      });
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      emit({ kind: 'picked', jobId: job.id, detail: job.title });
      const veto = cfg.shouldClaim ? await cfg.shouldClaim(job) : true;
      if (!veto) {
        emit({ kind: 'claim_skipped', jobId: job.id });
        await sleep(pollMs);
        continue;
      }
      await claimJob(cfg, job);
      const result = await cfg.doWork(job);
      await submitJob(cfg, job, result);
      await awaitRelease(cfg, job);
      await withdrawJob(cfg, job);
    } catch (e) {
      emit({ kind: 'error', detail: (e as Error).message });
    }
    if (signal?.aborted) return;
    await sleep(pollMs);
  }
}
