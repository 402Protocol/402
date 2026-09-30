/**
 * The Tape — a public visual log of every real onchain settlement the
 * facilitator broadcasts.
 *
 * Only settled (broadcast) payments are recorded; dry-runs never touch the
 * tape. Logging happens at the route layer after settleExactPayment reports
 * success, so the audited settlement path itself is untouched.
 */
import { formatUnits, getAddress } from 'viem';
import { chainFromCaip2 } from './chains.js';
import type { SettleRequest, SettleResponse } from './types.js';

export interface SettlementInput {
  txHash: string;
  payer: string;
  payTo: string;
  amountRaw: string;
  amountUsdc: string;
  asset: string;
  network: string;
  resource: string;
  createdAt: number;
}

/**
 * Build a tape row from a settle request + successful response.
 * Returns null when the response is not a successful broadcast.
 */
export function settlementRow(
  req: SettleRequest,
  res: SettleResponse,
  resource: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SettlementInput | null {
  if (!res.success || !res.transaction || !res.payer) return null;
  const auth = req?.paymentPayload?.payload?.authorization;
  const required = req?.paymentRequirements;
  if (!auth || !required) return null;
  let amountRaw: bigint;
  try {
    amountRaw = BigInt(auth.value);
  } catch {
    return null;
  }
  // Human-readable amount: use the chain's USDC decimals when the asset
  // matches, otherwise fall back to raw units.
  let amountUsdc = auth.value;
  try {
    const cfg = chainFromCaip2(required.network);
    if (cfg && getAddress(required.asset) === getAddress(cfg.usdc.address)) {
      amountUsdc = formatUnits(amountRaw, cfg.usdc.decimals);
    }
  } catch {
    /* keep raw */
  }
  let payTo: string;
  let payer: string;
  try {
    payTo = getAddress(auth.to);
    payer = getAddress(res.payer);
  } catch {
    return null;
  }
  return {
    txHash: res.transaction,
    payer,
    payTo,
    amountRaw: amountRaw.toString(),
    amountUsdc,
    asset: required.asset,
    network: required.network,
    resource,
    createdAt: nowSec,
  };
}
