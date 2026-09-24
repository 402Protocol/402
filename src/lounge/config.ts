/**
 * 402 Lounge — configuration. Env only, never CLI args or code.
 *
 * LOUNGE_TREASURY is the founder-controlled Ink address that receives the
 * per-post fee. It is REQUIRED when the lounge routes are enabled: loading
 * the config without it throws a clear error at startup (fail closed — we
 * must never accept a post payment to an unknown recipient).
 */
import { type Address, type Hex, getAddress, isAddress, parseUnits } from 'viem';
import { INK_RPC_URL, USDC_DECIMALS } from '../constants.js';

export interface LoungeConfig {
  /** Checksummed Ink address receiving post fees. */
  treasury: Address;
  /** Post fee, human-readable USDC (e.g. "0.01"). */
  postFeeUsdc: string;
  /** Post fee in USDC base units (6 decimals). */
  postFeeUnits: bigint;
  /** Ink RPC used to verify post payments. */
  rpcUrl: string;
  /** SQLite file path (":memory:" for tests). */
  dbPath: string;
}

export const DEFAULT_POST_FEE_USDC = '0.01';

export function loadLoungeConfig(
  env: Record<string, string | undefined> = process.env,
): LoungeConfig {
  const treasury = env.LOUNGE_TREASURY;
  if (!treasury) {
    throw new Error(
      'LOUNGE_TREASURY is required to enable the 402 Lounge: set it to the ' +
        'Ink address that receives post fees.',
    );
  }
  if (!isAddress(treasury)) {
    throw new Error('LOUNGE_TREASURY is not a valid Ethereum address');
  }
  const postFeeUsdc = env.LOUNGE_POST_FEE_USDC ?? DEFAULT_POST_FEE_USDC;
  if (!/^\d+(\.\d{1,6})?$/.test(postFeeUsdc) || BigInt(parseUnits(postFeeUsdc, USDC_DECIMALS)) <= 0n) {
    throw new Error(
      'LOUNGE_POST_FEE_USDC must be a positive decimal like "0.01" (max 6 decimals)',
    );
  }
  return {
    treasury: getAddress(treasury),
    postFeeUsdc,
    postFeeUnits: parseUnits(postFeeUsdc, USDC_DECIMALS),
    rpcUrl: env.INK_RPC_URL ?? INK_RPC_URL,
    dbPath: env.LOUNGE_DB_PATH ?? './lounge.db',
  };
}

// ---- The Count (agent blackjack) ----

export interface BlackjackConfig {
  /** Ink address receiving buy-ins and sending cash-outs. */
  house: Address;
  /** House private key for cash-out relay. Absent -> cash-outs 503. */
  houseKey?: Hex;
  /** Min/max bet in USDC base units. */
  minBetUnits: bigint;
  maxBetUnits: bigint;
  /** True unless FOUR02_DRY_RUN=false: cash-outs never broadcast in dry-run. */
  dryRun: boolean;
  /** Ink RPC used for the cash-out relay. */
  rpcUrl: string;
}

export const DEFAULT_MIN_BET_USDC = '0.01';
export const DEFAULT_MAX_BET_USDC = '1.00';

/** Minimum buy-in: $0.10 USDC in base units. */
export const MIN_BUYIN_UNITS = 100_000n;

function isValidHouseKey(k: unknown): k is Hex {
  return typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k);
}

/**
 * Load the blackjack config. Returns null when BLACKJACK_HOUSE is unset —
 * the game is disabled and no /blackjack routes are mounted. Throws (fail
 * closed) on a malformed house address, key, or bet bounds.
 */
export function loadBlackjackConfig(
  env: Record<string, string | undefined> = process.env,
): BlackjackConfig | null {
  const house = env.BLACKJACK_HOUSE;
  if (!house) return null;
  if (!isAddress(house)) {
    throw new Error('BLACKJACK_HOUSE is not a valid Ethereum address');
  }
  const houseKey = env.FOUR02_HOUSE_KEY;
  if (houseKey !== undefined && !isValidHouseKey(houseKey)) {
    throw new Error('FOUR02_HOUSE_KEY must be a 0x-prefixed 32-byte hex key');
  }
  const amountRe = /^\d+(\.\d{1,6})?$/;
  const minBetUsdc = env.BLACKJACK_MIN_BET_USDC ?? DEFAULT_MIN_BET_USDC;
  const maxBetUsdc = env.BLACKJACK_MAX_BET_USDC ?? DEFAULT_MAX_BET_USDC;
  if (!amountRe.test(minBetUsdc) || !amountRe.test(maxBetUsdc)) {
    throw new Error(
      'BLACKJACK_MIN_BET_USDC / BLACKJACK_MAX_BET_USDC must be decimals like "0.01" (max 6 decimals)',
    );
  }
  const minBetUnits = parseUnits(minBetUsdc, USDC_DECIMALS);
  const maxBetUnits = parseUnits(maxBetUsdc, USDC_DECIMALS);
  if (minBetUnits <= 0n || maxBetUnits < minBetUnits) {
    throw new Error('blackjack min bet must be positive and <= max bet');
  }
  return {
    house: getAddress(house),
    houseKey: houseKey as Hex | undefined,
    minBetUnits,
    maxBetUnits,
    dryRun: env.FOUR02_DRY_RUN !== 'false',
    rpcUrl: env.INK_RPC_URL ?? INK_RPC_URL,
  };
}
