/**
 * 402 Job Marketplace v0 — configuration. Env only, never CLI args or code.
 *
 * FOUR02_BOUNTY_ESCROW is the BountyEscrow contract address (option A from
 * the 2026-09-26 spec: createBounty with no provider at creation time,
 * claimBounty callable once by an enrolled worker). The contract is
 * UNDEPLOYED — until it exists, the env var stays unset and /jobs is
 * disabled entirely (null config, like blackjack).
 *
 * FOUR02_JOBS_LISTING_FEE_USDC is the optional x402 listing fee per job
 * post, default "0" (free at launch — the fee is an open founder question).
 * The config plumbing is here; the verification hook in the post handler is
 * clearly marked so the fee can be switched on without a refactor.
 */
import { type Address, getAddress, isAddress, parseUnits } from 'viem';
import { INK_RPC_URL, USDC_DECIMALS } from '../constants.js';
import { REPUTATION_REGISTRY } from './escrow.js';
import { DEFAULT_IPFS_GATEWAY } from './avatars.js';

export interface JobsConfig {
  /** BountyEscrow contract address on Ink. */
  escrow: Address;
  /** Listing fee, human-readable USDC (e.g. "0.25"). "0" = free. */
  listingFeeUsdc: string;
  /** Listing fee in USDC base units (6 decimals). */
  listingFeeUnits: bigint;
  /** Ink RPC used for receipt + identity verification. */
  rpcUrl: string;
  /** SQLite file path (":memory:" for tests). */
  dbPath: string;
  /** Four02ReputationRegistry address for the worker-resume reads. */
  reputationRegistry: Address;
  /** Per-requester rolling-24h post cap (JOBS_DAILY_POST_CAP, default 50). */
  dailyPostCap: number;
  /**
   * When true, POST /jobs/:id/claim requires the worker's enrollment to
   * carry a non-null TRACES seat token id (JOBS_SEATS_REQUIRED). Default
   * off; the flip is config-only (no code change).
   */
  seatsRequired: boolean;
  /**
   * TRACES seat contract on Ink (FOUR02_TRACES_SEAT). Required when
   * seatsRequired is on — a seat gate with no contract to check against
   * fails closed at startup instead of silently passing. Null when unset.
   */
  seatsContract: Address | null;
  /**
   * IPFS gateway base used to resolve ipfs:// tokenURI/image URIs when
   * snapshotting seat artwork for agent avatars (FOUR02_IPFS_GATEWAY,
   * default https://ipfs.io/ipfs/). Optional — unset keeps the default.
   */
  ipfsGateway: string;
  /**
   * Max concurrently active (claimed/submitted/disputed) jobs one seat may
   * back (JOBS_SEAT_MAX_ACTIVE_JOBS, default 1). The seat is the license:
   * one license, one active job. Per-seat accounting is the real
   * concurrent-work enforcement (the 72h onchain pairing cooldown only
   * rate-limits serial rotation).
   */
  seatMaxActiveJobs: number;
  /**
   * Verification-panel review timeout in seconds
   * (JOBS_REVIEW_TIMEOUT_SECONDS, default 172800 = 48h). When an open
   * panel's deadline passes, assigned reviewers who never voted are
   * replaced with a fresh draw.
   */
  reviewTimeoutSeconds: number;
  /**
   * No-show reviewer cooldown in seconds (JOBS_REVIEW_COOLDOWN_SECONDS,
   * default 604800 = 7d). A reviewer replaced for never voting cannot be
   * drawn again until this elapses.
   */
  reviewCooldownSeconds: number;
  /**
   * Directed-dispatch accept window in seconds
   * (JOBS_DISPATCH_ACCEPT_WINDOW_SECONDS, default 600 = 10m). The assigned
   * worker must claim the job onchain within this window, or the
   * assignment expires and the job goes to the next candidate.
   */
  dispatchAcceptWindowSeconds: number;
  /**
   * Assignment rounds before a job falls back to the open board
   * (JOBS_DISPATCH_MAX_ROUNDS, default 3). Each decline/expiry burns one
   * round; after the last round the job is racable by any enrolled worker.
   */
  dispatchMaxRounds: number;
  /**
   * Max concurrently active (claimed/submitted/in_review/verified/disputed)
   * jobs one worker may hold for dispatch selection
   * (JOBS_DISPATCH_MAX_CONCURRENT_JOBS, default 1). A worker at the cap is
   * skipped by the assignment engine (it can still finish what it holds).
   */
  dispatchMaxConcurrentJobs: number;
}

/** Default listing fee: free at launch. */
export const DEFAULT_JOBS_LISTING_FEE_USDC = '0';

/** Default per-requester daily post cap (board-spam control). */
export const DEFAULT_JOBS_DAILY_POST_CAP = 50;

/** Default max concurrently active jobs per TRACES seat (the license model). */
export const DEFAULT_JOBS_SEAT_MAX_ACTIVE_JOBS = 1;

/** Default verification-panel review timeout: 48h. */
export const DEFAULT_JOBS_REVIEW_TIMEOUT_SECONDS = 48 * 3600;

/** Default no-show reviewer cooldown: 7 days. */
export const DEFAULT_JOBS_REVIEW_COOLDOWN_SECONDS = 7 * 86400;

/** Default directed-dispatch accept window: 10 minutes. */
export const DEFAULT_JOBS_DISPATCH_ACCEPT_WINDOW_SECONDS = 600;

/** Default assignment rounds before open-board fallback: 3. */
export const DEFAULT_JOBS_DISPATCH_MAX_ROUNDS = 3;

/** Default max concurrently active jobs per worker for dispatch: 1. */
export const DEFAULT_JOBS_DISPATCH_MAX_CONCURRENT_JOBS = 1;

/** The superseded V1 registry: its writer allowlist is empty, so any resume
 * read against it returns all-zeros. */
export const SUPERSEDED_REPUTATION_REGISTRY_V1 = REPUTATION_REGISTRY;

/**
 * Load the jobs config. Returns null when FOUR02_BOUNTY_ESCROW is unset —
 * /jobs is not mounted. Throws (fail closed) on a malformed escrow address
 * or fee, the same posture as the lounge's treasury check.
 */
export function loadJobsConfig(
  env: Record<string, string | undefined> = process.env,
): JobsConfig | null {
  const escrow = env.FOUR02_BOUNTY_ESCROW;
  if (!escrow) return null;
  if (!isAddress(escrow)) {
    throw new Error('FOUR02_BOUNTY_ESCROW is not a valid Ethereum address');
  }
  const listingFeeUsdc =
    env.FOUR02_JOBS_LISTING_FEE_USDC ?? DEFAULT_JOBS_LISTING_FEE_USDC;
  if (!/^\d+(\.\d{1,6})?$/.test(listingFeeUsdc)) {
    throw new Error(
      'FOUR02_JOBS_LISTING_FEE_USDC must be a decimal like "0.25" (max 6 decimals)',
    );
  }
  // Reputation registry for the worker-resume reads. Defaults to the
  // SUPERSEDED V1; set to the V2 address after Four02ReputationRegistryV2
  // deploys (no code change needed).
  const reputationRegistry = env.FOUR02_REPUTATION_REGISTRY ?? REPUTATION_REGISTRY;
  if (!isAddress(reputationRegistry)) {
    throw new Error('FOUR02_REPUTATION_REGISTRY is not a valid Ethereum address');
  }
  const dailyPostCapRaw = env.JOBS_DAILY_POST_CAP ?? String(DEFAULT_JOBS_DAILY_POST_CAP);
  if (!/^\d+$/.test(dailyPostCapRaw)) {
    throw new Error('JOBS_DAILY_POST_CAP must be a positive integer');
  }
  const dailyPostCap = parseInt(dailyPostCapRaw, 10);
  if (dailyPostCap <= 0) {
    throw new Error('JOBS_DAILY_POST_CAP must be a positive integer');
  }
  const seatsRequiredRaw = (env.JOBS_SEATS_REQUIRED ?? '').trim().toLowerCase();
  const seatsRequired = seatsRequiredRaw === 'true' || seatsRequiredRaw === '1';
  const seatsContractRaw = (env.FOUR02_TRACES_SEAT ?? '').trim();
  if (seatsRequired && !seatsContractRaw) {
    throw new Error(
      'JOBS_SEATS_REQUIRED is on but FOUR02_TRACES_SEAT is unset — ' +
        'the seat gate has no contract to verify against (fail closed)',
    );
  }
  if (seatsContractRaw && !isAddress(seatsContractRaw)) {
    throw new Error('FOUR02_TRACES_SEAT is not a valid Ethereum address');
  }
  // Optional IPFS gateway override for avatar snapshots; the default
  // gateway works with no extra configuration.
  let ipfsGateway = (env.FOUR02_IPFS_GATEWAY ?? DEFAULT_IPFS_GATEWAY).trim();
  if (!/^https?:\/\//i.test(ipfsGateway)) {
    throw new Error('FOUR02_IPFS_GATEWAY must be an http(s) URL');
  }
  if (!ipfsGateway.endsWith('/')) ipfsGateway += '/';
  const seatMaxActiveJobsRaw =
    env.JOBS_SEAT_MAX_ACTIVE_JOBS ?? String(DEFAULT_JOBS_SEAT_MAX_ACTIVE_JOBS);
  if (!/^\d+$/.test(seatMaxActiveJobsRaw)) {
    throw new Error('JOBS_SEAT_MAX_ACTIVE_JOBS must be a positive integer');
  }
  const seatMaxActiveJobs = parseInt(seatMaxActiveJobsRaw, 10);
  if (seatMaxActiveJobs <= 0) {
    throw new Error('JOBS_SEAT_MAX_ACTIVE_JOBS must be a positive integer');
  }
  const reviewTimeoutRaw = env.JOBS_REVIEW_TIMEOUT_SECONDS ?? String(DEFAULT_JOBS_REVIEW_TIMEOUT_SECONDS);
  if (!/^\d+$/.test(reviewTimeoutRaw) || parseInt(reviewTimeoutRaw, 10) <= 0) {
    throw new Error('JOBS_REVIEW_TIMEOUT_SECONDS must be a positive integer');
  }
  const reviewCooldownRaw = env.JOBS_REVIEW_COOLDOWN_SECONDS ?? String(DEFAULT_JOBS_REVIEW_COOLDOWN_SECONDS);
  if (!/^\d+$/.test(reviewCooldownRaw) || parseInt(reviewCooldownRaw, 10) <= 0) {
    throw new Error('JOBS_REVIEW_COOLDOWN_SECONDS must be a positive integer');
  }
  const dispatchAcceptWindowRaw =
    env.JOBS_DISPATCH_ACCEPT_WINDOW_SECONDS ?? String(DEFAULT_JOBS_DISPATCH_ACCEPT_WINDOW_SECONDS);
  if (!/^\d+$/.test(dispatchAcceptWindowRaw) || parseInt(dispatchAcceptWindowRaw, 10) <= 0) {
    throw new Error('JOBS_DISPATCH_ACCEPT_WINDOW_SECONDS must be a positive integer');
  }
  const dispatchMaxRoundsRaw =
    env.JOBS_DISPATCH_MAX_ROUNDS ?? String(DEFAULT_JOBS_DISPATCH_MAX_ROUNDS);
  if (!/^\d+$/.test(dispatchMaxRoundsRaw) || parseInt(dispatchMaxRoundsRaw, 10) <= 0) {
    throw new Error('JOBS_DISPATCH_MAX_ROUNDS must be a positive integer');
  }
  const dispatchMaxConcurrentRaw =
    env.JOBS_DISPATCH_MAX_CONCURRENT_JOBS ?? String(DEFAULT_JOBS_DISPATCH_MAX_CONCURRENT_JOBS);
  if (!/^\d+$/.test(dispatchMaxConcurrentRaw) || parseInt(dispatchMaxConcurrentRaw, 10) <= 0) {
    throw new Error('JOBS_DISPATCH_MAX_CONCURRENT_JOBS must be a positive integer');
  }
  const cfg: JobsConfig = {
    escrow: getAddress(escrow),
    listingFeeUsdc,
    listingFeeUnits: parseUnits(listingFeeUsdc, USDC_DECIMALS),
    rpcUrl: env.INK_RPC_URL ?? INK_RPC_URL,
    dbPath: env.FOUR02_JOBS_DB_PATH ?? './jobs.db',
    reputationRegistry: getAddress(reputationRegistry),
    dailyPostCap,
    seatsRequired,
    seatsContract: seatsContractRaw ? getAddress(seatsContractRaw) : null,
    ipfsGateway,
    seatMaxActiveJobs,
    reviewTimeoutSeconds: parseInt(reviewTimeoutRaw, 10),
    reviewCooldownSeconds: parseInt(reviewCooldownRaw, 10),
    dispatchAcceptWindowSeconds: parseInt(dispatchAcceptWindowRaw, 10),
    dispatchMaxRounds: parseInt(dispatchMaxRoundsRaw, 10),
    dispatchMaxConcurrentJobs: parseInt(dispatchMaxConcurrentRaw, 10),
  };
  // G5: the V1 registry is SUPERSEDED and its writer allowlist is empty —
  // every reputation summary read against it returns all-zeros, so worker
  // resumes would silently show zero history. Loud on startup so the
  // missing V2 env var can't go unnoticed.
  if (cfg.reputationRegistry.toLowerCase() === SUPERSEDED_REPUTATION_REGISTRY_V1.toLowerCase()) {
    console.warn(
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
      '!!! 402 JOBS: FOUR02_REPUTATION_REGISTRY is the SUPERSEDED V1\n' +
      `!!! (${SUPERSEDED_REPUTATION_REGISTRY_V1})\n` +
      '!!! Its writer allowlist is EMPTY — worker resumes read all-zeros.\n' +
      '!!! Set FOUR02_REPUTATION_REGISTRY to the V2 address after it deploys.\n' +
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    );
  }
  return cfg;
}
