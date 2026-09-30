/**
 * 402 Job Marketplace v0 — the /jobs Hono API.
 *
 *   POST /jobs                      -> create listing (signed JobPost + funding txHash)
 *   GET  /jobs?status=&category=&limit= -> public board, newest first
 *   GET  /jobs/:id                  -> public detail
 *   POST /jobs/:id/spec             -> gated private-spec read (signed JobSpecAccess)
 *   POST /jobs/:id/claim            -> enrolled worker claims (signed JobClaim + claim txHash)
 *   POST /jobs/:id/submit           -> worker submits deliverable (signed JobSubmit)
 *   POST /jobs/:id/accept           -> requester accepts (signed JobDecision + release txHash)
 *   POST /jobs/:id/dispute          -> either party disputes (signed JobDecision + raiseDispute txHash)
 *   POST /jobs/:id/refund           -> mirror an onchain refund (refund txHash, permissionless)
 *   POST /jobs/:id/resolve          -> mirror an onchain arbitration (resolveDispute txHash, permissionless)
 *   POST /jobs/:id/sync            -> reconcile a listing with the onchain
 *                                     job (direct contract calls bypassing
 *                                     the API), forward-only, permissionless
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
  defaultGetOnchainJob,
  defaultIdentityOwner,
  defaultReputationSummary,
  defaultVerifySeatPairing,
  verifyBountyClaimed,
  verifyBountyFunding,
  verifyDisputeRaised,
  verifyDisputeResolved,
  verifyJobRefunded,
  verifyRelease,
  ONCHAIN_JOB_STATES,
  type GetOnchainJob,
  type IdentityOwner,
  type ReputationSummary,
  type VerifySeatPairing,
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
  'in_review',
  'verified',
  'complete',
  'disputed',
  'resolved',
  'refunded',
];

export const JOBS_MAX_BODY_BYTES = 256 * 1024;
export const JOB_TITLE_MAX = 120;
export const JOB_SPEC_MAX = 64_000;
export const JOB_URI_MAX = 2048;

/**
 * Verification-panel shape (Father-approved): exactly 3 reviewers,
 * quorum 2-of-3. Reviewers earn reputation only (no USDC); the bar is >= 1
 * completed job. Panels are ADVISORY ONLY — they never move funds and
 * never trigger release/dispute; that stays with the poster/arbiter
 * escrow flow.
 */
export const PANEL_SIZE = 3;
/** Quorum: this many agreeing votes decides the panel. */
export const PANEL_QUORUM = 2;

/** Signed-action cadence: 30 writes/minute per wallet, after validation. */
export const JOBS_ACTION_BUCKET = { windowMs: 60_000, max: 30 };

/**
 * Per-IP cadence on the sybil-exposed endpoints (post + enroll): coarser
 * than the per-author bucket, so one IP minting wallets can't dodge the
 * author limit forever. 120/min is 4x the author budget — wide enough for
 * a NAT'd office, tight enough to slow a spammer.
 */
export const JOBS_IP_BUCKET = { windowMs: 60_000, max: 120 };

/** Rolling window for the per-requester daily post cap (G3). */
export const JOBS_POST_CAP_WINDOW_SECONDS = 24 * 60 * 60;

export interface JobActivityEvent {
  kind:
    | 'posted'
    | 'claimed'
    | 'submitted'
    | 'verified'
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
  identityOwner?: IdentityOwner;
  /** Onchain job reader for POST /jobs/:id/sync (eth_call getJob). */
  getOnchainJob?: GetOnchainJob;
  reputationSummary?: (agentId: bigint) => Promise<ReputationSummary | null>;
  /**
   * Live TRACES seat-pairing verifier. Defaults to a viem client against
   * config.seatsContract; null when no seat contract is configured (seat
   * paths are skipped unless JOBS_SEATS_REQUIRED is on, which requires the
   * contract at startup). Injectable for tests.
   */
  verifySeatPairing?: VerifySeatPairing | null;
  /** Fired after every board event (the Lounge's job-activity feed). */
  onActivity?: (a: JobActivityEvent) => void;
  /**
   * Override the shared rate-limit bucket. Production uses
   * JOBS_ACTION_BUCKET; tests pass a generous bucket so the suite isn't
   * coupled to the production budget (a dedicated test below still proves
   * the default bucket 429s).
   */
  rateLimitBucket?: { windowMs: number; max: number };
  /**
   * Override the per-IP bucket. Defaults to rateLimitBucket when set
   * (tests stay decoupled) and JOBS_IP_BUCKET in production.
   */
  ipRateLimitBucket?: { windowMs: number; max: number };
}

/** Client IP for the per-IP bucket: first X-Forwarded-For hop, 'unknown' when absent. */
function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
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
 * only revealed once the job is complete — until then, hashes only. A
 * private spec is withheld entirely (null) while the specHash stays public
 * (it is the onchain termsHash, public by definition); the full spec is
 * served only via the signed POST /jobs/:id/spec endpoint.
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
    spec: l.specPrivate ? null : escapeHtml(l.spec),
    specPrivate: l.specPrivate,
    specHash: l.specHash,
    category: l.category,
    bountyUsdc: l.bountyUsdc,
    deadline: l.deadline,
    state: l.state,
    submissionHash: l.submissionHash,
    // Escaped like title/spec: the URI is worker-supplied content the site
    // renders, so it gets the same output encoding (stored-XSS hygiene).
    submissionUri: l.state === 'complete' ? escapeHtml(l.submissionUri ?? '') : null,
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
  const getOnchainJob = deps.getOnchainJob ?? defaultGetOnchainJob(config.rpcUrl);
  const identityOwner = deps.identityOwner ?? defaultIdentityOwner(config.rpcUrl);
  const verifySeatPairing =
    deps.verifySeatPairing ??
    (config.seatsContract
      ? defaultVerifySeatPairing(config.rpcUrl, config.seatsContract)
      : null);
  const reputationSummary =
    deps.reputationSummary ??
    defaultReputationSummary(config.rpcUrl, config.reputationRegistry);
  const limiter = new AuthorRateLimiter();
  const bucket = deps.rateLimitBucket ?? JOBS_ACTION_BUCKET;
  const ipBucket = deps.ipRateLimitBucket ?? deps.rateLimitBucket ?? JOBS_IP_BUCKET;

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
    // Byte-count, not text.length: the cap is documented in bytes, and
    // multibyte UTF-8 (e.g. emoji, 4 bytes per code point) must not slip
    // past a UTF-16-code-unit count.
    if (Buffer.byteLength(text, 'utf8') > JOBS_MAX_BODY_BYTES) {
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
   * The TRACES seat gate. Verifies LIVE onchain (never the DB row) that:
   * agentToSeat(agentId) is a nonzero seat, seatToAgent(seatId) points
   * back, and the same wallet owns both the seat and the agent. Returns
   * null when the pairing is valid, otherwise the error response to send.
   * A check that cannot complete (RPC down) is 503 fail-closed; a
   * definitive mismatch is 403.
   */
  const seatGate = async (
    c: Context,
    seatId: bigint,
    agentId: bigint,
    wallet: Address,
  ): Promise<Response | null> => {
    if (!verifySeatPairing) {
      // Unreachable when JOBS_SEATS_REQUIRED is on (startup throws
      // without FOUR02_TRACES_SEAT); defensive for direct dep injection.
      return bad(
        c,
        503,
        'seat_check_unavailable',
        'no TRACES seat contract configured',
      );
    }
    const res = await verifySeatPairing(seatId, agentId, wallet);
    if (res.ok) return null;
    if (res.reason === 'seat_check_unavailable') {
      return bad(
        c,
        503,
        'seat_check_unavailable',
        'could not verify the TRACES seat pairing onchain',
      );
    }
    return bad(c, 403, 'seat_ineligible', res.reason);
  };

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
    const { wallet, agentId, timestamp, signature, seatTokenId } = b;

    if (typeof wallet !== 'string' || !isAddress(wallet)) {
      return bad(c, 400, 'invalid_wallet');
    }
    const agentIdBig = parseUint(agentId);
    if (agentIdBig === null) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be a uint256');
    }
    // The escrow's claimBounty reverts on agentId 0 (ZeroAgentId): fail fast
    // here instead of enrolling an identity that can never claim.
    if (agentIdBig === 0n) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be nonzero');
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

    // Rate limit AFTER the request is otherwise valid. The per-IP bucket
    // runs FIRST: author buckets alone are sybil-bypassable (mint wallets,
    // dodge the per-wallet limit), so a coarser IP-level brake sits in
    // front of the per-author one.
    if (!limiter.take(`jobs-enroll-ip:${clientIp(c)}`, ipBucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    if (!limiter.take(`jobs-enroll:${wallet.toLowerCase()}`, bucket)) {
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

    // TRACES seat gate at enrollment: when seats are required, the worker
    // names the seat backing their license and we verify the full pairing
    // live onchain (mappings both ways + same-wallet ownership of seat
    // and agent). The seatTokenId body field is only a hint — the chain
    // is the binding. Re-pairing later (repairSeat) just re-enrolls.
    let seatIdStr: string | null = null;
    if (config.seatsRequired) {
      const seatIdBig = parseUint(seatTokenId);
      if (seatIdBig === null || seatIdBig === 0n) {
        return bad(
          c,
          400,
          'seat_required',
          'seatTokenId (a nonzero uint256) is required: claiming needs a TRACES seat',
        );
      }
      const gateRes = await seatGate(
        c,
        seatIdBig,
        agentIdBig,
        getAddress(wallet),
      );
      if (gateRes) return gateRes;
      seatIdStr = seatIdBig.toString();
    }

    const now = Math.floor(Date.now() / 1000);
    const { isNew } = db.enrollWorker({
      wallet: getAddress(wallet),
      agentId: agentIdBig.toString(),
      seatTokenId: seatIdStr ?? undefined,
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
    const listings = db.jobsForAgent(agentId);
    const jobs = listings.map(publicJob);
    let reputation: ReputationSummary | null = null;
    try {
      reputation = await reputationSummary(agentIdBig);
    } catch {
      reputation = null;
    }
    // G1: requester concentration. A resume of 50 jobs from 1 requester
    // smells farmed; the per-requester counts make that visible.
    const jobsByRequester: Record<string, number> = {};
    for (const l of listings) {
      jobsByRequester[l.requester] = (jobsByRequester[l.requester] ?? 0) + 1;
    }
    // G2: identity-transfer halo. Agent ids are transferable NFTs, so a
    // buyer inherits the whole resume. Compare the CURRENT registry owner
    // against the worker wallet stored on each finished job: any mismatch
    // means the resume's work was done by a previous owner.
    let currentOwner: Address | null = null;
    try {
      currentOwner = await identityOwner(agentIdBig);
    } catch {
      currentOwner = null;
    }
    let ownershipChanged = false;
    if (currentOwner !== null) {
      const ownerLc = currentOwner.toLowerCase();
      // 'complete' and 'resolved' are the finished-work states (refunded =
      // ghosted, disputed = in flight). The stored worker is the wallet
      // that actually did the work, bound trustlessly at claim time.
      ownershipChanged = listings.some(
        (l) =>
          (l.state === 'complete' || l.state === 'resolved') &&
          l.worker !== null &&
          l.worker.toLowerCase() !== ownerLc,
      );
      currentOwner = getAddress(currentOwner);
    }
    // When the registry check is unavailable, currentOwner is null and
    // ownershipChanged stays false (cannot determine — not "changed").
    return c.json({
      agentId,
      jobs,
      reputation,
      uniqueRequesters: Object.keys(jobsByRequester).length,
      jobsByRequester,
      currentOwner,
      ownershipChanged,
    });
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
      specPrivate,
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
    // Unsigned read-visibility flag: the spec ITSELF is signed (and its
    // hash is the onchain termsHash), so the flag can't smuggle content —
    // it only decides whether the API withholds the spec from public
    // reads. Kept out of the JobPost typed message so existing signers
    // keep verifying (adding a field would break their signatures).
    if (specPrivate !== undefined && typeof specPrivate !== 'boolean') {
      return bad(c, 400, 'invalid_spec_private', 'specPrivate must be a boolean');
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
    // The escrow takes a uint64 deadline, but the DB stores Number(deadline)
    // and SQLite INTEGERs are 64-bit signed: beyond Number.MAX_SAFE_INTEGER
    // the DB value would silently round and diverge from the exact onchain
    // value, and beyond 2^63-1 the INSERT itself can overflow. Bound it here
    // so the DB and the onchain value can never diverge.
    if (
      deadlineBig === null ||
      deadlineBig <= BigInt(nowSec) ||
      deadlineBig > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return bad(c, 400, 'invalid_deadline', 'deadline must be a future unix timestamp (uint64, within Number.MAX_SAFE_INTEGER)');
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

    // Per-IP bucket first (sybil brake), then the daily post cap, then the
    // per-author bucket — all AFTER the request is otherwise valid, so
    // failed attempts burn no quota.
    if (!limiter.take(`jobs-post-ip:${clientIp(c)}`, ipBucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    if (
      db.countListingsSince(requester, nowSec - JOBS_POST_CAP_WINDOW_SECONDS) >=
      config.dailyPostCap
    ) {
      return bad(
        c,
        429,
        'daily_post_cap_exceeded',
        `at most ${config.dailyPostCap} listings per requester per 24h`,
      );
    }
    if (!limiter.take(`jobs-post:${requester.toLowerCase()}`, bucket)) {
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
      specPrivate: specPrivate === true,
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

  // ---- gated private-spec read ----
  //
  // A private spec is withheld from every public read (board, detail,
  // resume) and served here ONLY to the requester or the claimed worker.
  // The accessor signs a JobSpecAccess typed message; the signature proves
  // WHO is asking, and the server then checks that wallet is a party to
  // the job. For a public spec the endpoint is redundant (the spec is on
  // the board already) but harmless — the same two-party gate applies.

  app.post('/:id/spec', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { jobId, accessor, timestamp, signature } = b;

    if (typeof accessor !== 'string' || !isAddress(accessor)) {
      return bad(c, 400, 'invalid_accessor');
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
      primaryType: 'JobSpecAccess',
      message: { jobId: BigInt(id), accessor, timestamp: ts },
      signature,
      author: accessor,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    if (!limiter.take(`jobs-spec:${accessor.toLowerCase()}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

    const acc = accessor.toLowerCase();
    const isRequester = acc === listing.requester.toLowerCase();
    const isWorker =
      listing.worker !== null && acc === listing.worker.toLowerCase();
    if (!isRequester && !isWorker) {
      return bad(
        c,
        403,
        'not_authorized',
        'only the requester or the claimed worker may read this spec',
      );
    }
    return c.json({
      jobId: id,
      spec: listing.spec,
      specHash: listing.specHash,
      specPrivate: listing.specPrivate,
    });
  });

  // ---- lifecycle ----

  app.post('/:id/claim', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    // 'claimed' is allowed through for the idempotent path: when a worker
    // claimed onchain directly (or a sync mirrored it), presenting the real
    // claim tx must succeed rather than 409.
    if (listing.state !== 'open' && listing.state !== 'claimed') {
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
    if (agentIdBig === 0n) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be nonzero');
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
    if (!limiter.take(`jobs-claim:${worker.toLowerCase()}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    const alreadyClaimed = listing.state === 'claimed';
    // Seat backing this claim (verified live below); stored on the listing
    // for the per-seat active-job cap. Null when seats are not required or
    // on the idempotent path (the seat was verified on the first claim).
    let claimSeatId: string | null = null;
    if (!alreadyClaimed) {
      // Enrollment gate: the claimant must be enrolled, and the claimed
      // agent id must be the enrolled one. A stale DB row can never claim —
      // identity is re-checked onchain below, the source of truth. Skipped
      // on the idempotent path: the outcome is already mirrored and the
      // verified claim tx below is the proof.
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
      // Seat gate at assignment: the enrollment must carry a seat, and the
      // full pairing is re-verified LIVE onchain (never trusted from the
      // DB row) — the seat could have been transferred or re-paired since
      // enrollment. Then the per-seat concurrent-job cap is enforced:
      // one license backs at most seatMaxActiveJobs active jobs.
      if (config.seatsRequired) {
        if (!enrollment.seatTokenId) {
          return bad(
            c,
            403,
            'seat_required',
            'claiming requires a TRACES seat (JOBS_SEATS_REQUIRED is on)',
          );
        }
        const seatIdBig = parseUint(enrollment.seatTokenId);
        if (seatIdBig === null || seatIdBig === 0n) {
          return bad(c, 403, 'seat_required', 'enrolled seat is invalid; re-enroll');
        }
        const gateRes = await seatGate(
          c,
          seatIdBig,
          agentIdBig,
          getAddress(worker),
        );
        if (gateRes) return gateRes;
        const active = db.countActiveJobsForSeat(seatIdBig.toString());
        if (active >= config.seatMaxActiveJobs) {
          return bad(
            c,
            403,
            'seat_job_cap',
            `seat ${seatIdBig} already backs ${active} active job(s) (max ${config.seatMaxActiveJobs})`,
          );
        }
        claimSeatId = seatIdBig.toString();
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
    }

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

    if (alreadyClaimed) {
      // Idempotent: the verified BountyClaimed event binds this exact
      // worker + agent id, so a row mismatch is a genuine conflict, not a
      // retry (a second valid claimBounty tx cannot exist onchain).
      if (
        listing.worker?.toLowerCase() !== getAddress(worker).toLowerCase() ||
        listing.workerAgentId !== agentIdBig.toString()
      ) {
        return bad(c, 409, 'claim_conflict', 'job is claimed by a different worker');
      }
      return c.json({ jobId: id, state: 'claimed', worker: getAddress(worker) });
    }

    const now = Math.floor(Date.now() / 1000);
    const res = db.claimJob(
      id,
      getAddress(worker),
      agentIdBig.toString(),
      txCheck.txHash,
      now,
      claimSeatId,
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
    // Scheme allowlist: the URI is rendered by the site and fetched by the
    // requester, so javascript:/data:/vbscript: and other exotic schemes are
    // rejected at the door. The HTML escaping on output stays (stored-XSS
    // hygiene for whatever the allowed schemes can still carry).
    const uriScheme = uri.toLowerCase();
    if (
      !uriScheme.startsWith('https://') &&
      !uriScheme.startsWith('http://') &&
      !uriScheme.startsWith('ipfs://')
    ) {
      return bad(
        c,
        400,
        'invalid_uri_scheme',
        'submission uri must use https://, http://, or ipfs://',
      );
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

    if (!limiter.take(`jobs-submit:${author.toLowerCase()}`, bucket)) {
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

    // Verification panel: draw 3 reviewers and move the job to in_review.
    // The draw excludes the worker and the poster, requires >= 1 completed
    // job per reviewer, and never reuses a reviewer who already judged this
    // job. When the pool is short (< 3 eligible), the job stays `submitted`
    // (the legacy direct-release path) instead of stranding in review
    // forever — panels are advisory, and the bootstrap needs SOME way to
    // complete jobs before the reviewer population exists.
    const reviewers = db.drawReviewers({
      count: PANEL_SIZE,
      excludeAgentIds: listing.workerAgentId ? [listing.workerAgentId] : [],
      excludeWallets: [listing.requester, listing.worker ?? ''],
      excludeJobId: id,
      now,
    });
    if (reviewers.length === PANEL_SIZE) {
      const opened = db.openPanel(
        id,
        reviewers,
        now,
        now + config.reviewTimeoutSeconds,
      );
      if (opened === 'ok') {
        return c.json({
          jobId: id,
          state: 'in_review',
          panel: {
            reviewers: reviewers.map((r) => r.agentId),
            deadlineAt: now + config.reviewTimeoutSeconds,
          },
        });
      }
    }
    return c.json({ jobId: id, state: 'submitted', panel: null });
  });

  // ---- verification panels (advisory only) ----
  //
  // When a worker submits, the API draws 3 reviewers and the job enters
  // `in_review`. Reviewers sign EIP-712 ReviewAttestation verdicts; 2-of-3
  // accept -> `verified` (the poster can release with confidence), 2-of-3
  // reject -> back to `claimed` (resubmittable, scores visible to the
  // worker). Panels NEVER move funds or trigger release/dispute.
  //
  // Votes stay blind until the panel decides: GET /:id/reviews hides
  // verdicts/scores while open. No-show reviewers are lazily replaced
  // after the review timeout (fresh draw, 7-day cooldown for the no-show).

  /**
   * Lazy no-show replacement shared by the review read/write paths: when
   * an open panel's deadline has passed, reviewers who never voted are
   * swapped for a fresh draw (excluding the job's worker + poster, as at
   * assignment). No cron needed.
   */
  const replaceNoShows = (jobId: number, listing: JobListing, now: number) =>
    db.replaceNoShows(
      jobId,
      now,
      config.reviewTimeoutSeconds,
      config.reviewCooldownSeconds,
      (count, excludeAgentIds) =>
        db.drawReviewers({
          count,
          excludeAgentIds: [
            ...excludeAgentIds,
            ...(listing.workerAgentId ? [listing.workerAgentId] : []),
          ],
          excludeWallets: [listing.requester, listing.worker ?? ''],
          excludeJobId: jobId,
          now,
        }),
    );

  app.post('/:id/review', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (listing.state !== 'in_review') {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}, not in_review`);
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const b = parsed.body as Record<string, unknown>;
    const { jobId, reviewer, agentId, verdict, score, timestamp, signature } = b;

    if (typeof reviewer !== 'string' || !isAddress(reviewer)) {
      return bad(c, 400, 'invalid_reviewer');
    }
    const agentIdBig = parseUint(agentId);
    if (agentIdBig === null || agentIdBig === 0n) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be a nonzero uint256');
    }
    if (typeof verdict !== 'boolean') {
      return bad(c, 400, 'invalid_verdict', 'verdict must be a boolean (true = accept)');
    }
    if (
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > 100
    ) {
      return bad(c, 400, 'invalid_score', 'score must be an integer 0-100');
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
      primaryType: 'ReviewAttestation',
      message: {
        jobId: BigInt(id),
        reviewer,
        agentId: agentIdBig,
        verdict,
        score,
        timestamp: ts,
      },
      signature,
      author: reviewer,
    });
    if (!sig.ok) return bad(c, 401, 'bad_signature', sig.reason);

    // Rate limit AFTER the request is otherwise valid.
    if (!limiter.take(`jobs-review:${reviewer.toLowerCase()}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

    const now = Math.floor(Date.now() / 1000);
    // Lazy replacement first: a reviewer voting after the deadline may have
    // just been swapped out — their vote then correctly 409s as not_assigned.
    replaceNoShows(id, listing, now);

    const res = db.recordReview({
      jobId: id,
      reviewerWallet: getAddress(reviewer),
      reviewerAgentId: agentIdBig.toString(),
      verdict,
      score,
      signature,
      now,
    });
    if (res === 'not_assigned') {
      return bad(
        c,
        403,
        'not_assigned',
        'this wallet/agent is not an actively assigned reviewer for this job',
      );
    }
    if (res === 'already_voted') return bad(c, 409, 'already_voted');
    if (res === 'no_panel' || res === 'wrong_state') {
      return bad(c, 409, 'wrong_state', 'the review panel is no longer open');
    }
    if (res !== 'ok') return bad(c, 409, 'wrong_state', 'vote not recorded');

    const panel = db.getPanel(id);
    const votes = panel?.votes ?? [];
    const accepts = votes.filter((v) => v.verdict).length;
    const body: Record<string, unknown> = {
      jobId: id,
      state: db.getJob(id)?.state ?? listing.state,
      votesCast: votes.length,
      accepts,
      rejects: votes.length - accepts,
    };
    if (panel?.state === 'verified') {
      deps.onActivity?.({
        kind: 'verified',
        jobId: id,
        actor: getAddress(reviewer),
        title: listing.title,
        bountyUsdc: listing.bountyUsdc,
      });
    }
    return c.json(body);
  });

  /**
   * Panel status + votes. Votes stay BLIND while the panel is open
   * (verdict/score null) — reviewers cannot anchor on each other. Once the
   * panel decides, every vote is revealed (transparency is the point).
   */
  app.get('/:id/reviews', (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    const panel = db.getPanel(id);
    if (!panel) return bad(c, 404, 'no_panel', 'this job has no review panel');
    const now = Math.floor(Date.now() / 1000);
    replaceNoShows(id, listing, now);
    const fresh = db.getPanel(id);
    if (!fresh) return bad(c, 404, 'no_panel');
    const decided = fresh.state === 'verified' || fresh.state === 'rejected';
    return c.json({
      jobId: id,
      state: fresh.state,
      deadlineAt: fresh.deadlineAt,
      decidedAt: fresh.decidedAt,
      quorum: PANEL_QUORUM,
      panelSize: PANEL_SIZE,
      reviewers: fresh.reviewers
        .filter((r) => r.replacedAt === null)
        .map((r) => ({
          reviewerAgentId: r.reviewerAgentId,
          assignedAt: r.assignedAt,
          voted: r.votedAt !== null,
        })),
      votes: fresh.votes.map((v) => ({
        reviewerAgentId: v.reviewerAgentId,
        votedAt: v.votedAt,
        // Blind until the panel decides.
        verdict: decided ? v.verdict : null,
        score: decided ? v.score : null,
      })),
    });
  });

  /**
   * Reviewer discovery: open panels where `wallet` is an actively assigned
   * reviewer. Assignment implies read authorization — the response carries
   * the spec and the submission URI (both withheld from public reads) so
   * the reviewer can actually judge the work against the terms.
   */
  app.get('/reviews/assigned', (c) => {
    const wallet = c.req.query('wallet');
    if (!wallet) return bad(c, 400, 'missing_wallet', 'pass ?wallet=0x...');
    const now = Math.floor(Date.now() / 1000);
    const panels = db.assignedPanels(wallet);
    // Refresh any past-due panels before reporting (a reviewer checking in
    // after the deadline should see their replacement status, not a stale
    // assignment).
    for (const p of panels) {
      const listing = db.getJob(p.jobId);
      if (listing) replaceNoShows(p.jobId, listing, now);
    }
    return c.json({ panels: db.assignedPanels(wallet) });
  });

  /** Reviewer accounting (feeds the future onchain batch keeper). */
  app.get('/reviewers/:agentId/stats', (c) => {
    const agentIdBig = parseUint(c.req.param('agentId'));
    if (agentIdBig === null) {
      return bad(c, 400, 'invalid_agent_id', 'agentId must be a uint256');
    }
    const s = db.getReviewerStats(agentIdBig.toString());
    return c.json({
      reviewerAgentId: s.reviewerAgentId,
      reviewsDone: s.reviewsDone,
      agreedWithQuorum: s.agreedWithQuorum,
      outlierVotes: s.outlierVotes,
      noShows: s.noShows,
      cooldownUntil: s.cooldownUntil,
      agreementRate:
        s.reviewsDone > 0 ? s.agreedWithQuorum / s.reviewsDone : null,
    });
  });

  app.post('/:id/accept', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (
      listing.state !== 'submitted' &&
      listing.state !== 'claimed' &&
      listing.state !== 'in_review' &&
      listing.state !== 'verified' &&
      listing.state !== 'complete'
    ) {
      return bad(
        c,
        409,
        'wrong_state',
        `job is ${listing.state}; accept needs submitted/claimed/in_review/verified ` +
          `(if the worker claimed onchain directly, POST /jobs/${id}/sync first)`,
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

    if (!limiter.take(`jobs-accept:${requester.toLowerCase()}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Verify the onchain release: the escrow emitted JobReleased(escrowJobId)
    // on a successful receipt. The event is the binding — only release()
    // emits it, and release() reverts unless the requester (payer) called it
    // from Delivered, so no tx.from check is needed (or wanted: a multisig
    // payer's outer tx.from is an EOA submitter). The EIP-712 signature
    // above already authenticated the requester; the event proves the money
    // moved.
    const released = await verifyRelease({
      getReceipt,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      escrowJobId: BigInt(listing.escrowJobId),
    });
    if (!released.ok) {
      return bad(c, receiptStatus(released.reason), 'release_invalid', released.reason);
    }

    // Idempotent: only one release() can ever succeed onchain for a job, so
    // a verified event against an already-complete row is the same outcome.
    if (listing.state === 'complete') {
      return c.json({ jobId: id, state: 'complete' });
    }

    // Seat gate at payout: the worker's agent must still be backed by a
    // live, wallet-owned seat pairing. The money already moved onchain
    // (verified above), so this gates the API's attestation, not the
    // funds — refusing to mirror keeps unlicensed completions out of the
    // board, resumes, and activity feed. Chain truth stays reachable via
    // POST /jobs/:id/sync.
    if (config.seatsRequired) {
      const workerAddr = listing.worker ? getAddress(listing.worker) : null;
      const enrollment = workerAddr ? db.getWorker(workerAddr) : null;
      const seatStr = enrollment?.seatTokenId ?? listing.workerSeatId;
      const payoutAgentId =
        listing.workerAgentId != null ? parseUint(listing.workerAgentId) : null;
      const payoutSeatId = seatStr != null ? parseUint(seatStr) : null;
      if (
        !workerAddr ||
        !enrollment ||
        payoutAgentId === null ||
        payoutSeatId === null ||
        payoutSeatId === 0n
      ) {
        return bad(
          c,
          403,
          'seat_required',
          'worker has no verified TRACES seat; payout cannot be attested',
        );
      }
      const gateRes = await seatGate(c, payoutSeatId, payoutAgentId, workerAddr);
      if (gateRes) return gateRes;
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
    if (
      listing.state !== 'claimed' &&
      listing.state !== 'submitted' &&
      listing.state !== 'in_review' &&
      listing.state !== 'verified' &&
      listing.state !== 'disputed'
    ) {
      return bad(
        c,
        409,
        'wrong_state',
        `job is ${listing.state}; disputes need claimed/submitted/in_review/verified ` +
          `(if the action happened onchain directly, POST /jobs/${id}/sync first)`,
      );
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

    if (!limiter.take(`jobs-dispute:${signer.toLowerCase()}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;

    // Verify the onchain dispute: the escrow emitted DisputeRaised(jobId,
    // raiser) with the raiser matching the disputing party. The event is the
    // binding — only raiseDispute() emits it, and it reverts unless a party
    // called it from Funded/Delivered. The raiser topic (not tx.from) is
    // checked so multisig parties verify the same way EOAs do.
    const disputed = await verifyDisputeRaised({
      getReceipt,
      txHash: txCheck.txHash,
      escrow: config.escrow,
      escrowJobId: BigInt(listing.escrowJobId),
      raiser: getAddress(signer),
    });
    if (!disputed.ok) {
      return bad(c, receiptStatus(disputed.reason), 'dispute_invalid', disputed.reason);
    }

    // Idempotent: only one raiseDispute() can ever succeed onchain for a
    // job, so a verified event against an already-disputed row is the same
    // outcome.
    if (listing.state === 'disputed') {
      return c.json({ jobId: id, state: 'disputed', disputedAt: listing.disputedAt });
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
    // 'refunded' is allowed through for the idempotent path.
    if (
      listing.state !== 'open' &&
      listing.state !== 'claimed' &&
      listing.state !== 'refunded'
    ) {
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

    // txHash validity is checked BEFORE the rate limit (the file's own
    // convention: limits apply after the request is otherwise valid), so a
    // stranger can't burn this job's shared mirror budget with malformed or
    // already-burned hashes.
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;
    if (!limiter.take(`jobs-refund:${id}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

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

    // Idempotent: only one refund() can ever succeed onchain for a job.
    if (listing.state === 'refunded') {
      return c.json({ jobId: id, state: 'refunded' });
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
    // 'resolved' is allowed through for the idempotent path.
    if (listing.state !== 'disputed' && listing.state !== 'resolved') {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}, not disputed`);
    }
    const parsed = await readBody(c);
    if (!parsed.ok) return bad(c, parsed.status, parsed.error);
    const { txHash } = parsed.body as Record<string, unknown>;

    // txHash validity before the rate limit (same convention as refund):
    // malformed or replayed hashes must not burn the job's mirror budget.
    const txCheck = checkTxHash(c, txHash);
    if (!txCheck.ok) return txCheck.res;
    if (!limiter.take(`jobs-resolve:${id}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

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

    // Idempotent: only one resolveDispute() can ever succeed onchain.
    if (listing.state === 'resolved') {
      return c.json({ jobId: id, state: 'resolved' });
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

  // ---- onchain reconciliation: sync ----
  //
  // POST /jobs/:id/sync advances a listing toward the VERIFIED onchain job
  // state, for actions taken directly against the escrow contract WITHOUT
  // touching the API (claimBounty / confirmDelivery / release /
  // raiseDispute / resolveDispute / refund called from a site UI or the
  // worker's own agent). Without this, such listings strand in stale DB
  // states forever — the signed endpoints can't mirror them (claim is
  // enrollment-gated; accept needs submitted|claimed) and the unsigned
  // mirrors only cover refund/resolve.
  //
  // Unsigned and permissionless BY DESIGN: the proof is the escrow
  // contract's own getJob view, not a signature — there is no signature
  // that could attest to anything the chain doesn't already prove, and the
  // endpoint only ever mirrors the chain (forward-only, never backward,
  // never into or out of a terminal row). The onchain immutable terms
  // (payer/amount/deadline/termsHash) must match the listing or the sync
  // refuses (fail closed). Rate limited per job; the eth_call is cheap.
  //
  // Reorg note: like every check in this API, the read is point-in-time
  // against the RPC's current head. A deep reorg that un-happens the
  // onchain transition would leave a stale row; v0 accepts this (Ink
  // finality is fast, and money movement is always re-verifiable onchain).
  // The sync NEVER rolls a row back, so a lying/stale RPC read can only
  // fail to advance, never corrupt.

  /** Onchain JobState number -> DB target + activity kind, if syncable. */
  const SYNC_TARGETS: Record<
    number,
    { db: 'claimed' | 'disputed' | 'complete' | 'resolved' | 'refunded'; activity: JobActivityEvent['kind'] }
  > = {
    2: { db: 'claimed', activity: 'claimed' }, // Funded
    3: { db: 'claimed', activity: 'claimed' }, // Delivered (accept-from-claimed covers the release)
    4: { db: 'complete', activity: 'completed' }, // Released
    5: { db: 'disputed', activity: 'disputed' }, // Disputed
    6: { db: 'resolved', activity: 'resolved' }, // Resolved
    7: { db: 'refunded', activity: 'refunded' }, // Refunded
  };

  app.post('/:id/sync', async (c) => {
    const id = jobIdParam(c);
    if (id === null) return bad(c, 400, 'invalid_job_id');
    const listing = db.getJob(id);
    if (!listing) return bad(c, 404, 'job_not_found');
    if (
      listing.state === 'complete' ||
      listing.state === 'resolved' ||
      listing.state === 'refunded'
    ) {
      return bad(c, 409, 'wrong_state', `job is ${listing.state}; terminal`);
    }

    if (!limiter.take(`jobs-sync:${id}`, bucket)) {
      return bad(c, 429, 'rate_limited', 'slow down');
    }

    const onchain = await getOnchainJob(
      getAddress(listing.escrow),
      BigInt(listing.escrowJobId),
    );
    if (!onchain) {
      return bad(
        c,
        503,
        'sync_unavailable',
        'could not read the escrow job onchain (unknown job or RPC unreachable)',
      );
    }
    // Bind the onchain job to THIS listing. The escrow job id was verified
    // against the funding receipt at post time, but the immutable terms must
    // still match — otherwise the row and the chain disagree about what was
    // funded (wrong job, DB corruption, or a lying RPC): fail closed.
    const listedAmount = parseBountyUsdc(listing.bountyUsdc);
    const termsMatch =
      onchain.payer.toLowerCase() === listing.requester.toLowerCase() &&
      listedAmount !== null &&
      listedAmount === onchain.amount &&
      BigInt(listing.deadline) === onchain.deadline &&
      listing.specHash.toLowerCase() === onchain.termsHash.toLowerCase();
    if (!termsMatch) {
      return bad(
        c,
        409,
        'sync_mismatch',
        'onchain job terms (payer/amount/deadline/termsHash) do not match the listing',
      );
    }
    const onchainState = ONCHAIN_JOB_STATES[onchain.state] ?? 'unknown';
    if (onchain.state === 0 || onchain.state === 1) {
      // None: the listing was funded (verified BountyCreated event), so the
      // job must exist — a reorg is the only explanation. Open: nothing to do
      // (but if the DB already advanced past open, say so — never roll back).
      if (onchain.state === 0) {
        return bad(
          c,
          409,
          'sync_mismatch',
          'escrow job does not exist onchain (was funded; possible deep reorg)',
        );
      }
      return c.json({
        jobId: id,
        state: listing.state,
        onchainState,
        synced: false,
        ...(listing.state !== 'open' ? { note: 'db_ahead_of_chain' } : {}),
      });
    }

    const target = SYNC_TARGETS[onchain.state];
    if (!target) {
      return bad(c, 503, 'sync_unavailable', `unknown onchain state ${onchain.state}`);
    }

    // Bind worker/agentId from the chain when leaving 'open' — the contract
    // verified identity at claimBounty time, so this is trustless. Zero
    // address / zero agentId (unclaimed states) bind nothing.
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    const worker =
      onchain.provider.toLowerCase() === zeroAddr ? null : getAddress(onchain.provider);
    const agentId = onchain.agentId === 0n ? null : onchain.agentId.toString();

    const now = Math.floor(Date.now() / 1000);
    const res = db.syncJobState(id, target.db, { worker, agentId, now });
    if (res === 'not_found') return bad(c, 404, 'job_not_found');
    if (res === 'no_path') {
      // The DB is ahead of the chain (e.g. a reorged-away tx): never roll
      // back, just report both states.
      return c.json({
        jobId: id,
        state: listing.state,
        onchainState,
        synced: false,
        note: 'db_ahead_of_chain',
      });
    }
    if (res === 'ok') {
      deps.onActivity?.({
        kind: target.activity,
        jobId: id,
        actor: worker ?? listing.requester,
        title: listing.title,
        bountyUsdc: listing.bountyUsdc,
      });
    }
    const updated = db.getJob(id);
    return c.json({
      jobId: id,
      state: updated?.state ?? listing.state,
      onchainState,
      synced: res === 'ok',
    });
  });

  return app;
}

/** Reasons a tx hash can be burned for each purpose (DB layer export). */
export type { JobsTxPurpose };
