/**
 * 402 Job Marketplace v0 — the /jobs Hono API.
 *
 *   POST /jobs                      -> create listing (signed JobPost + funding txHash)
 *   GET  /jobs?status=&category=&limit= -> public board, newest first
 *   GET  /jobs/:id                  -> public detail
 *   POST /jobs/:id/claim            -> enrolled worker claims (signed JobClaim + claim txHash)
 *   POST /jobs/:id/submit           -> worker submits deliverable (signed JobSubmit)
 *   POST /jobs/:id/accept           -> requester accepts (signed JobDecision + release txHash)
 *   POST /jobs/:id/dispute          -> either party disputes (signed JobDecision + raiseDispute txHash)
 *   POST /jobs/:id/refund           -> mirror an onchain refund (refund txHash, permissionless)
 *   POST /jobs/:id/resolve          -> mirror an onchain arbitration (resolveDispute txHash, permissionless)
 *   POST /jobs/enroll               -> worker enrollment (signed JobEnroll + onchain ownerOf check)
 *   GET  /jobs/workers/:wallet      -> enrollment record
 *   GET  /jobs/worker/:agentId/history -> DB history + onchain reputation summary
 *
 * Conventions mirror the lounge: EIP-712 agent actions on the shared
 * "402 Lounge" domain (see lounge/signing.ts), txHash receipt verification
 * for anything that moves money (the blackjack buy-in pattern), single-use
 * tx hashes, { error, detail } error bodies, per-author rate limits applied
 * AFTER the request is otherwise valid.
 *
 * The API never broadcasts, never signs for users, and NEVER writes
 * reputation — the BountyEscrow contract calls
 * Four02ReputationRegistryV2.recordCommerceEvent itself. Every state
 * transition here mirrors a verified onchain transition.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  type Address,
  type Hex,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
} from 'viem';
import { USDC_DECIMALS } from '../constants.js';
import { escapeHtml } from '../lounge/escape.js';
import { AuthorRateLimiter } from '../lounge/ratelimit.js';
import {
  timestampFresh,
  verifyLoungeSignature,
} from '../lounge/signing.js';
import { defaultGetReceipt } from '../lounge/payments.js';
import type { GetReceipt } from '../lounge/types.js';
import type { JobsConfig } from './config.js';
import { JobsDb, type JobListing, type JobsTxPurpose, type JobState } from './db.js';
import {
  defaultGetTransaction,
  defaultIdentityOwner,
  defaultReputationSummary,
  verifyBountyClaimed,
  verifyBountyFunding,
  verifyDisputeResolved,
  verifyEscrowCall,
  verifyJobRefunded,
  type GetTransaction,
  type IdentityOwner,
  type ReputationSummary,
} from './escrow.js';

/** v0 categories. `security-audit` is explicitly rejected (founder rule). */
export const JOB_CATEGORIES = [
  'oracle-panel',
  'writing',
  'code',
  'design',
  'data',
] as const;

/** All states the board filter accepts. */
export const JOB_STATES: JobState[] = [
  'open',
  'claimed',
  'submitted',
  'complete',
  'disputed',
  'resolved',
  'refunded',
];

export const JOBS_MAX_BODY_BYTES = 256 * 1024;
export const JOB_TITLE_MAX = 120;
export const JOB_SPEC_MAX = 64_000;
export const JOB_URI_MAX = 2048;

/** Signed-action cadence: 30 writes/minute per wallet, after validation. */
export const JOBS_ACTION_BUCKET = { windowMs: 60_000, max: 30 };

export interface JobActivityEvent {
  kind:
    | 'posted'
    | 'claimed'
    | 'submitted'
    | 'completed'
    | 'disputed'
    | 'resolved'
    | 'refunded';
  jobId: number;
  actor: string;
  title: string;
  bountyUsdc: string;
}

export interface JobsDeps {
  db?: JobsDb;
  getReceipt?: GetReceipt;
  getTransaction?: GetTransaction;
  identityOwner?: IdentityOwner;
  reputationSummary?: (agentId: bigint) => Promise<ReputationSummary | null>;
  /** Fired after every board event (the Lounge's job-activity feed). */
  onActivity?: (a: JobActivityEvent) => void;
}

function parseUint(v: unknown): bigint | null {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function parseTimestamp(v: unknown): bigint | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function parseBytes32(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null;
}

/** USDC decimal string (max 6dp) -> base units, or null. */
function parseBountyUsdc(v: unknown): bigint | null {
  if (typeof v !== 'string') return null;
  if (!/^\d+(\.\d{1,6})?$/.test(v)) return null;
  try {
    const units = parseUnits(v, USDC_DECIMALS);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

/**
 * Public job shape. The submission URI is deliverable access, so it is
 * only revealed once the job is complete — until then, hashes only.
 */
function publicJob(l: JobListing): Record<string, unknown> {
  return {
    id: l.id,
    escrowJobId: l.escrowJobId,
    escrow: l.escrow,
    requester: l.requester,
    worker: l.worker,
    workerAgentId: l.workerAgentId,
    title: escapeHtml(l.title),
    spec: escapeHtml(l.spec),
    category: l.category,
    bountyUsdc: l.bountyUsdc,
    deadline: l.deadline,
    state: l.state,
    submissionHash: l.submissionHash,
    submissionUri: l.state === 'complete' ? l.submissionUri : null,
    disputedAt: l.disputedAt,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

export function createJobsApp(
  config: JobsConfig,
  deps: JobsDeps = {},
): Hono {
  const app = new Hono();
  const db = deps.db ?? new JobsDb(config.dbPath);
  const getReceipt = deps.getReceipt ?? defaultGetReceipt(config.rpcUrl);
  const getTransaction =
    deps.getTransaction ?? defaultGetTransaction(config.rpcUrl);
  const identityOwner = deps.identityOwner ?? defaultIdentityOwner(config.rpcUrl);
  const reputationSummary =
    deps.reputationSummary ??
    defaultReputationSummary(config.rpcUrl, config.reputationRegistry);
  const limiter = new AuthorRateLimiter();

  async function readBody(
    c: Context,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; status: 400 | 413; error: string }
  > {
    let text: string;
    try {
      text = await c.req.text();
    } catch {
      return { ok: false, status: 400, error: 'unreadable_body' };
    }
    if (text.length > JOBS_MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: 'body_too_large' };
    }
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: 400, error: 'invalid_json' };
    }
  }

  const bad = (
    c: Context,
    status: ContentfulStatusCode,
    error: string,
    detail?: string,
  ) => c.json(detail ? { error, detail } : { error }, status);

  /** Payment-receipt failures: malformed hashes are 400, the rest 402. */
  const receiptStatus = (reason: string): ContentfulStatusCode =>
    reason === 'malformed_tx_hash' ? 400 : 402;

  /**
   * Validate a tx hash and fail fast on replays BEFORE the (expensive)
   * receipt verification. The DB transition still burns the hash
   * atomically, so a concurrent double-submit races to a single winner.
   */
  const checkTxHash = (
    c: Context,
    txHash: unknown,
  ): { ok: true; txHash: string } | { ok: false; res: Response } => {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { ok: false, res: bad(c, 400, 'invalid_tx_hash') };
    }
    if (db.isTxUsed(txHash)) {
      return { ok: false, res: bad(c, 409, 'tx_hash_reused') };
    }
    return { ok: true, txHash };
  };

  /** Parse a :id param into a DB row id, or null. */
  function jobIdParam(c: Context): number | null {
    const raw = parseUint(c.req.param('id'));
    if (raw === null || raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(raw);
  }

  // ---- enrollment ----

  app.post('/enroll', async (c) => {
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { wallet, agentId, timestamp, signature } = b;

    if (typeof wallet !== 'string' || !isAddress(wallet)) {
      return bad(c, 400, 'invalid_wallet');
    }
    const agentIdBig = parseUint(agentId);
    if (agentIdBig === null) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be a uint256');
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'JobEnroll',
      message: { wallet, agentId: agentIdBig, timestamp: ts },
      signature,
      author: wallet,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    // Rate limit AFTER the request is otherwise valid.
    if (!limiter.take(`jobs-enroll:${wallet.toLowerCase()}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

    // Onchain identity is the source of truth: the wallet must own the
    // agent id in the ERC-8004 registry. Fail closed when the check itself
    // is unavailable.
    const owner = await identityOwner(agentIdBig);
    if (owner === null) {
      return bad(c, 503, 'identity_check_unavailable', 'could not reach the identity registry');
    }
    if (owner.toLowerCase() !== wallet.toLowerCase()) {
      return bad(
        c,
        403,
        'identity_mismatch',
        `registry ownerOf(${agentIdBig}) is not ${getAddress(wallet)}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const { isNew } = db.enrollWorker({
      wallet: getAddress(wallet),
      agentId: agentIdBig.toString(),
      now,
    });
    return c.json(
      { wallet: getAddress(wallet), agentId: agentIdBig.toString(), enrolled: true },
      isNew ? 201 : 200,
    );
  });

  app.get('/workers/:wallet', (c) => {
    const w = db.getWorker(c.req.param('wallet'));
    if (!w) return bad(c, 404, 'not_enrolled');
    return c.json({
      wallet: w.wallet,
      agentId: w.agentId,
      seatTokenId: w.seatTokenId,
      enrolledAt: w.enrolledAt,
      lastVerifiedAt: w.lastVerifiedAt,
    });
  });

  app.get('/worker/:agentId/history', async (c) => {
    const agentIdBig = parseUint(c.req.param('agentId'));
    if (agentIdBig === null) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be a uint256');
    }
    const agentId = agentIdBig.toString();
    const jobs = db.jobsForAgent(agentId).map(publicJob);
    let reputation: ReputationSummary | null = null;
    try {
      reputation = await reputationSummary(agentIdBig);
    } catch {
      reputation = null;
    }
    return c.json({ agentId, jobs, reputation });
  });

  // ---- board ----

  app.post('/', async (c) => {
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const {
      requester,
      title,
      spec,
      category,
      bountyUsdc,
      deadline,
      termsHash,
      timestamp,
      signature,
      txHash,
    } = b;

    if (typeof requester !== 'string' || !isAddress(requester)) {
      return bad(c, 400, 'invalid_requester');
    }
    if (typeof title !== 'string' || title.length === 0 || title.length > JOB_TITLE_MAX) {
      return bad(c, 400, 'invalid_title', `title must be 1-${JOB_TITLE_MAX} chars`);
    }
    if (typeof spec !== 'string' || spec.length === 0 || spec.length > JOB_SPEC_MAX) {
      return bad(c, 400, 'invalid_spec', `spec must be 1-${JOB_SPEC_MAX} chars`);
    }
    if (typeof category !== 'string') {
      return bad(c, 400, 'invalid_category');
    }
    if (category === 'security-audit') {
      return bad(
        c,
        400,
        'category_rejected',
        'security audits are excluded from the v0 job board by founder rule',
      );
    }
    if (!(JOB_CATEGORIES as readonly string[]).includes(category)) {
      return bad(
        c,
        400,
        'invalid_category',
        `category must be one of: ${JOB_CATEGORIES.join(', ')}`,
      );
    }
    const bountyUnits = parseBountyUsdc(bountyUsdc);
    if (bountyUnits === null) {
      return bad(c, 400, 'invalid_bounty', 'bountyUsdc must be a positive decimal (max 6dp)');
    }
    const deadlineBig = parseUint(deadline);
    const nowSec = Math.floor(Date.now() / 1000);
    // The escrow takes a uint64 deadline: bound it here so the DB (which
    // stores Number(deadline)) and the onchain value can never diverge.
    if (
      deadlineBig === null ||
      deadlineBig <= BigInt(nowSec) ||
      deadlineBig > 0xffffffffffffffffn
    ) {
      return bad(c, 400, 'invalid_deadline', 'deadline must be a future unix timestamp (uint64)');
    }
    const terms = parseBytes32(termsHash);
    if (terms === null) {
      return bad(c, 400, 'invalid_terms_hash', 'termsHash must be a 0x-prefixed bytes32');
    }
    // No bait-and-switch: the posted spec must hash to the onchain termsHash.
    const computed = keccak256(toHex(spec)).toLowerCase();
    if (computed !== terms) {
      return bad(
        c,
        400,
        'terms_hash_mismatch',
        'termsHash must equal keccak256(spec)',
      );
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'JobPost',
      message: {
        requester,
        title,
        spec,
        category,
        bountyUsdc,
        deadline: deadlineBig,
        termsHash: terms,
        timestamp: ts,
      },
      signature,
      author: requester,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    // Rate limit AFTER the request is otherwise valid.
    if (!limiter.take(`jobs-post:${requester.toLowerCase()}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

    // HOOK: optional x402 listing fee (FOUR02_JOBS_LISTING_FEE_USDC, default
    // "0" = free at launch — the fee itself is an open founder question).
    // When a fee is priced, verify the requester's payment here (a USDC
    // transfer to the fee recipient, or the oracle-style x402
    // challenge/verify flow) before listing. Fail closed until then: a
    // nonzero fee with no verification implemented must never list.
    if (config.listingFeeUnits > 0n) {
      return bad(
        c,
        501,
        'listing_fee_unconfigured',
        'a listing fee is configured but its verification is not implemented yet',
      );
    }

    // Verify the funding: createBounty was really called with >= bounty
    // USDC from the requester into the escrow, with matching termsHash.
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;
    const funding = await verifyBountyFunding({
      getReceipt,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      requester: getAddress(requester),
      minUnits: bountyUnits,
      expectedDeadline: deadlineBig,
      expectedTermsHash: terms,
    });
    if (!funding.ok || funding.jobId === undefined) {
      return bad(
        c,
        receiptStatus(funding.ok ? 'no_bounty_created_event' : funding.reason),
        'funding_invalid',
        funding.ok ? 'no_bounty_created_event' : funding.reason,
      );
    }

    const res = db.createListing({
      escrowJobId: funding.jobId.toString(),
      escrow: config.escrow,
      requester: getAddress(requester),
      title,
      spec,
      specHash: terms,
      category,
      bountyUsdc: bountyUsdc as string,
      deadline: Number(deadlineBig),
      txHash: txCheck.txHash,
      now: nowSec,
    });
    if (!res.ok) return bad(c, 409, 'tx_hash_reused');

    deps.onActivity?.({
      kind: 'posted',
      jobId: res.id,
      actor: getAddress(requester),
      title,
      bountyUsdc: bountyUsdc as string,
    });
    return c.json({ jobId: res.id }, 201);
  });

  app.get('/', (c) => {
    const statusRaw = c.req.query('status');
    const categoryRaw = c.req.query('category');
    const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
    const limit =
      Number.isSafeInteger(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, 100)
        : 20;
    let status: JobState | undefined;
    if (statusRaw) {
      if (!(JOB_STATES as readonly string[]).includes(statusRaw)) {
        return bad(
          c,
          400,
          'invalid_status',
          `status must be one of: ${JOB_STATES.join(', ')}`,
        );
      }
      status = statusRaw as JobState;
    }
    if (categoryRaw && !(JOB_CATEGORIES as readonly string[]).includes(categoryRaw)) {
      return bad(
        c,
        400,
        'invalid_category',
        `category must be one of: ${JOB_CATEGORIES.join(', ')}`,
      );
    }
    return c.json({
      jobs: db
        .listJobs({ status, category: categoryRaw || undefined, limit })
        .map(publicJob),
    });
  });

  app.get('/:id', (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    return c.json({ job: publicJob(listing) });
  });

  // ---- lifecycle ----

  app.post('/:id/claim', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (listing.state !== 'open') {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}, not open`);
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { worker, agentId, timestamp, signature, txHash } = b;

    if (typeof worker !== 'string' || !isAddress(worker)) {
      return bad(c, 400, 'invalid_worker');
    }
    const agentIdBig = parseUint(agentId);
    if (agentIdBig === null) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be a uint256');
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'JobClaim',
      message: { jobId: BigInt(id), worker, agentId: agentIdBig, timestamp: ts },
      signature,
      author: worker,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    // Rate limit AFTER the request is otherwise valid.
    if (!limiter.take(`jobs-claim:${worker.toLowerCase()}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Enrollment gate: the claimant must be enrolled, and the claimed
    // agent id must be the enrolled one. A stale DB row can never claim —
    // identity is re-checked onchain below, the source of truth.
    const enrollment = db.getWorker(worker);
    if (!enrollment) {
      return bad(c, 403, 'not_enrolled', 'enroll at POST /jobs/enroll first');
    }
    if (enrollment.agentId !== agentIdBig.toString()) {
      return bad(
        c,
        403,
        'agent_not_enrolled',
        'this agent id is not enrolled for the claiming wallet',
      );
    }
    const owner = await identityOwner(agentIdBig);
    if (owner === null) {
      return bad(c, 503, 'identity_check_unavailable', 'could not reach the identity registry');
    }
    if (owner.toLowerCase() !== worker.toLowerCase()) {
      return bad(
        c,
        403,
        'identity_mismatch',
        `registry ownerOf(${agentIdBig}) is not ${getAddress(worker)}`,
      );
    }
    // Refresh the verification timestamp on a successful onchain re-check.
    const now = Math.floor(Date.now() / 1000);
    db.enrollWorker({
      wallet: getAddress(worker),
      agentId: agentIdBig.toString(),
      now,
    });

    // Verify the onchain claim: claimBounty(jobId, agentId) really ran,
    // binding this worker + agent id to the escrow's bounty.
    const claimed = await verifyBountyClaimed({
      getReceipt,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      escrowJobId: BigInt(listing.escrowJobId),
      worker: getAddress(worker),
      agentId: agentIdBig,
    });
    if (!claimed.ok) {
      return bad(c, receiptStatus(claimed.reason), 'claim_invalid', claimed.reason);
    }

    const res = db.claimJob(
      id,
      getAddress(worker),
      agentIdBig.toString(),
      txCheck.txHash,
      now,
    );
    if (res === 'tx_reused') return bad(c, 409, 'tx_hash_reused');
    if (res !== 'ok') return bad(c, 409, 'wrong_state', `job is no longer open`);

    deps.onActivity?.({
      kind: 'claimed',
      jobId: id,
      actor: getAddress(worker),
      title: listing.title,
      bountyUsdc: listing.bountyUsdc,
    });
    return c.json({ jobId: id, state: 'claimed', worker: getAddress(worker) });
  });

  app.post('/:id/submit', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (listing.state !== 'claimed') {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}, not claimed`);
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { jobId, author, contentHash, uri, timestamp, signature } = b;

    if (typeof author !== 'string' || !isAddress(author)) {
      return bad(c, 400, 'invalid_author');
    }
    if (author.toLowerCase() !== listing.worker?.toLowerCase()) {
      return bad(c, 403, 'not_the_worker', 'only the claiming worker may submit');
    }
    const hash = parseBytes32(contentHash);
    if (hash === null) {
      return bad(c, 400, 'invalid_content_hash', 'contentHash must be a 0x-prefixed bytes32');
    }
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > JOB_URI_MAX) {
      return bad(c, 400, 'invalid_uri', `uri must be 1-${JOB_URI_MAX} chars`);
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    if (jobId !== undefined && parseUint(jobId)?.toString() !== String(id)) {
      return bad(c, 400, 'job_id_mismatch', 'signed jobId does not match the URL');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'JobSubmit',
      message: {
        jobId: BigInt(id),
        author,
        contentHash: hash,
        uri,
        timestamp: ts,
      },
      signature,
      author,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    if (!limiter.take(`jobs-submit:${author.toLowerCase()}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

    const now = Math.floor(Date.now() / 1000);
    const res = db.submitJob(id, hash, uri, now);
    if (res !== 'ok') return bad(c, 409, 'wrong_state', 'job is no longer claimed');

    deps.onActivity?.({
      kind: 'submitted',
      jobId: id,
      actor: getAddress(author),
      title: listing.title,
      bountyUsdc: listing.bountyUsdc,
    });
    return c.json({ jobId: id, state: 'submitted' });
  });

  app.post('/:id/accept', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (listing.state !== 'submitted' && listing.state !== 'claimed') {
      return bad(
        c,
        409,
        'wrong_state',
        `job is ${listing.state}; accept needs submitted/claimed`,
      );
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { jobId, requester, decision, timestamp, signature, txHash } = b;

    if (decision !== 'accept') {
      return bad(c, 400, 'invalid_decision', 'decision must be "accept"');
    }
    if (typeof requester !== 'string' || !isAddress(requester)) {
      return bad(c, 400, 'invalid_requester');
    }
    if (requester.toLowerCase() !== listing.requester.toLowerCase()) {
      return bad(c, 403, 'not_the_requester', 'only the job requester may accept');
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    if (jobId !== undefined && parseUint(jobId)?.toString() !== String(id)) {
      return bad(c, 400, 'job_id_mismatch', 'signed jobId does not match the URL');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'JobDecision',
      message: {
        jobId: BigInt(id),
        requester,
        decision: 'accept',
        timestamp: ts,
      },
      signature,
      author: requester,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    if (!limiter.take(`jobs-accept:${requester.toLowerCase()}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Verify the onchain release: release(escrowJobId) called by the
    // requester on the escrow contract. This is what pays the worker —
    // the escrow's release() itself calls
    // Four02ReputationRegistryV2.recordCommerceEvent, so the API never
    // writes reputation; it only mirrors the verified outcome.
    const released = await verifyEscrowCall({
      getReceipt,
      getTransaction,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      from: getAddress(requester),
      fn: 'release',
      escrowJobId: BigInt(listing.escrowJobId),
    });
    if (!released.ok) {
      return bad(c, receiptStatus(released.reason), 'release_invalid', released.reason);
    }

    const now = Math.floor(Date.now() / 1000);
    const res = db.acceptJob(id, txCheck.txHash, now);
    if (res === 'tx_reused') return bad(c, 409, 'tx_hash_reused');
    if (res !== 'ok') return bad(c, 409, 'wrong_state', 'job is no longer submitted');

    deps.onActivity?.({
      kind: 'completed',
      jobId: id,
      actor: getAddress(requester),
      title: listing.title,
      bountyUsdc: listing.bountyUsdc,
    });
    return c.json({ jobId: id, state: 'complete' });
  });

  app.post('/:id/dispute', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (listing.state !== 'claimed' && listing.state !== 'submitted') {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}; disputes need claimed/submitted`);
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    // Note: the JobDecision typed message names this field `requester`,
    // but on the dispute path it is whichever party raises the dispute.
    const { jobId, requester: signer, decision, timestamp, signature, txHash } = b;

    if (decision !== 'dispute') {
      return bad(c, 400, 'invalid_decision', 'decision must be "dispute"');
    }
    if (typeof signer !== 'string' || !isAddress(signer)) {
      return bad(c, 400, 'invalid_signer');
    }
    const isRequester = signer.toLowerCase() === listing.requester.toLowerCase();
    const isWorker =
      listing.worker !== null &&
      signer.toLowerCase() === listing.worker.toLowerCase();
    if (!isRequester && !isWorker) {
      return bad(c, 403, 'not_a_party', 'only the requester or worker may dispute');
    }
    const ts = parseTimestamp(timestamp);
    if (ts === null || !timestampFresh(ts)) {
      return bad(c, 401, 'stale_timestamp', 'timestamp must be within ±5 minutes');
    }
    if (typeof signature !== 'string') {
      return bad(c, 400, 'missing_signature');
    }
    if (jobId !== undefined && parseUint(jobId)?.toString() !== String(id)) {
      return bad(c, 400, 'job_id_mismatch', 'signed jobId does not match the URL');
    }
    const sig = await verifyLoungeSignature({
      primaryType: 'JobDecision',
      message: {
        jobId: BigInt(id),
        requester: signer,
        decision: 'dispute',
        timestamp: ts,
      },
      signature,
      author: signer,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    if (!limiter.take(`jobs-dispute:${signer.toLowerCase()}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Verify the onchain dispute: raiseDispute(escrowJobId) called by the
    // disputing party on the escrow contract.
    const disputed = await verifyEscrowCall({
      getReceipt,
      getTransaction,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      from: getAddress(signer),
      fn: 'raiseDispute',
      escrowJobId: BigInt(listing.escrowJobId),
    });
    if (!disputed.ok) {
      return bad(c, receiptStatus(disputed.reason), 'dispute_invalid', disputed.reason);
    }

    const now = Math.floor(Date.now() / 1000);
    const res = db.disputeJob(id, txCheck.txHash, now);
    if (res === 'tx_reused') return bad(c, 409, 'tx_hash_reused');
    if (res !== 'ok') return bad(c, 409, 'wrong_state', 'job can no longer be disputed');

    deps.onActivity?.({
      kind: 'disputed',
      jobId: id,
      actor: getAddress(signer),
      title: listing.title,
      bountyUsdc: listing.bountyUsdc,
    });
    return c.json({ jobId: id, state: 'disputed', disputedAt: now });
  });

  // ---- terminal mirrors: refund / resolve ----
  //
  // These two endpoints are intentionally UNSIGNED. The escrow's refund()
  // and resolveDispute() are permissionless onchain calls, and the API only
  // MIRRORS a verified onchain event (JobRefunded / DisputeResolved) into
  // the DB — there is no signature that could attest to anything the event
  // doesn't already prove. The single-use txHash burn makes replays
  // impossible; rate limits are per job rather than per author. Without
  // these mirrors, refunded/arbitrated jobs would sit in stale DB states
  // forever (the DB must never INVENT an outcome, but it must reflect real
  // ones).
  //
  // Reorg note: like every txHash check in this API, verification is
  // point-in-time against the RPC's current head. A deep reorg that un-happens
  // the mirrored tx would leave a stale row; v0 accepts this (Ink finality
  // is fast, and money movement is always re-verifiable onchain).

  app.post('/:id/refund', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    // Mirrors the escrow: refund() only succeeds from Open/Funded onchain.
    if (listing.state !== 'open' && listing.state !== 'claimed') {
      return bad(
        c,
        409,
        'wrong_state',
        `job is ${listing.state}; refund needs open/claimed`,
      );
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const { txHash } = parsed.body as Record<string, unknown>;

    if (!limiter.take(`jobs-refund:${id}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Verify the onchain refund: JobRefunded(escrowJobId) emitted by the
    // escrow contract. The contract itself records WorkerGhosted for a
    // claimed-but-undelivered bounty — the API never writes reputation.
    const refunded = await verifyJobRefunded({
      getReceipt,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      escrowJobId: BigInt(listing.escrowJobId),
    });
    if (!refunded.ok) {
      return bad(c, receiptStatus(refunded.reason), 'refund_invalid', refunded.reason);
    }

    const now = Math.floor(Date.now() / 1000);
    const res = db.refundJob(id, txCheck.txHash, now);
    if (res === 'tx_reused') return bad(c, 409, 'tx_hash_reused');
    if (res !== 'ok') return bad(c, 409, 'wrong_state', 'job can no longer be refunded');

    deps.onActivity?.({
      kind: 'refunded',
      jobId: id,
      actor: listing.requester,
      title: listing.title,
      bountyUsdc: listing.bountyUsdc,
    });
    return c.json({ jobId: id, state: 'refunded' });
  });

  app.post('/:id/resolve', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (listing.state !== 'disputed') {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}, not disputed`);
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const { txHash } = parsed.body as Record<string, unknown>;

    if (!limiter.take(`jobs-resolve:${id}`, JOBS_ACTION_BUCKET)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Verify the onchain arbitration: DisputeResolved(escrowJobId, ...)
    // emitted by the escrow contract. The contract recorded
    // DisputeResolved + ArbitrationWon/Lost itself — the API only mirrors.
    const resolved = await verifyDisputeResolved({
      getReceipt,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      escrowJobId: BigInt(listing.escrowJobId),
    });
    if (!resolved.ok) {
      return bad(c, receiptStatus(resolved.reason), 'resolve_invalid', resolved.reason);
    }

    const now = Math.floor(Date.now() / 1000);
    const res = db.resolveJob(id, txCheck.txHash, now);
    if (res === 'tx_reused') return bad(c, 409, 'tx_hash_reused');
    if (res !== 'ok') return bad(c, 409, 'wrong_state', 'job can no longer be resolved');

    deps.onActivity?.({
      kind: 'resolved',
      jobId: id,
      actor: listing.worker ?? listing.requester,
      title: listing.title,
      bountyUsdc: listing.bountyUsdc,
    });
    return c.json({ jobId: id, state: 'resolved' });
  });

  return app;
}

/** Reasons a tx hash can be burned for each purpose (DB layer export). */
export type { JobsTxPurpose };
