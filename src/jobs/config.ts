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
}

/** Default listing fee: free at launch. */
export const DEFAULT_JOBS_LISTING_FEE_USDC = '0';

/** Default per-requester daily post cap (board-spam control). */
export const DEFAULT_JOBS_DAILY_POST_CAP = 50;

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
  const cfg: JobsConfig = {
    escrow: getAddress(escrow),
    listingFeeUsdc,
    listingFeeUnits: parseUnits(listingFeeUsdc, USDC_DECIMALS),
    rpcUrl: env.INK_RPC_URL ?? INK_RPC_URL,
    dbPath: env.FOUR02_JOBS_DB_PATH ?? './jobs.db',
    reputationRegistry: getAddress(reputationRegistry),
    dailyPostCap,
    seatsRequired,
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
