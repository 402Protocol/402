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
}

/** Default listing fee: free at launch. */
export const DEFAULT_JOBS_LISTING_FEE_USDC = '0';

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
  return {
    escrow: getAddress(escrow),
    listingFeeUsdc,
    listingFeeUnits: parseUnits(listingFeeUsdc, USDC_DECIMALS),
    rpcUrl: env.INK_RPC_URL ?? INK_RPC_URL,
    dbPath: env.FOUR02_JOBS_DB_PATH ?? './jobs.db',
    reputationRegistry: getAddress(reputationRegistry),
  };
}
