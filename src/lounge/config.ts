/**
 * 402 Lounge — configuration. Env only, never CLI args or code.
 *
 * LOUNGE_TREASURY is the founder-controlled Ink address that receives the
 * per-post fee. It is REQUIRED when the lounge routes are enabled: loading
 * the config without it throws a clear error at startup (fail closed — we
 * must never accept a post payment to an unknown recipient).
 */
import { type Address, getAddress, isAddress, parseUnits } from 'viem';
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
