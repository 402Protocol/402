/**
 * 402 Lounge — post payment verification.
 *
 * A post is payment-gated: the poster sends >= the post fee in Ink USDC to
 * LOUNGE_TREASURY and submits the tx hash. We fetch the receipt and require
 * a Transfer(author -> treasury, value >= fee) event emitted by the Ink
 * USDC contract. Each tx hash is single-use (see LoungeDb.markPaymentUsed).
 *
 * The receipt fetcher is injectable: viem public client in prod, a mock in
 * tests. Nothing here broadcasts — it only reads.
 */
import {
  type Address,
  type Hex,
  createPublicClient,
  http,
  keccak256,
  toHex,
} from 'viem';
import { ink, USDC_ADDRESS } from '../constants.js';
import type { GetReceipt } from './types.js';

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = keccak256(
  toHex('Transfer(address,address,uint256)'),
);

/** Address as a 32-byte left-padded topic, lowercase for comparison. */
function addressTopic(addr: string): string {
  return ('0x' + addr.slice(2).toLowerCase().padStart(64, '0')).toLowerCase();
}

export function defaultGetReceipt(rpcUrl: string): GetReceipt {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (txHash: Hex) => {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      return {
        status: receipt.status,
        logs: receipt.logs.map((l) => ({
          address: l.address,
          topics: [...l.topics] as string[],
          data: l.data,
        })),
      };
    } catch {
      return null;
    }
  };
}

export type PaymentCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify that txHash pays the post fee. Pure w.r.t. chain state except via
 * the injected getReceipt — no broadcasts, no signing.
 */
export async function verifyPostPayment(opts: {
  getReceipt: GetReceipt;
  txHash: string;
  author: Address;
  treasury: Address;
  feeUnits: bigint;
  usdc?: Address;
}): Promise<PaymentCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const receipt = await opts.getReceipt(opts.txHash as Hex);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };

  const usdc = (opts.usdc ?? USDC_ADDRESS).toLowerCase();
  const fromTopic = addressTopic(opts.author);
  const toTopic = addressTopic(opts.treasury);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
    if (log.topics[1]?.toLowerCase() !== fromTopic) continue;
    if (log.topics[2]?.toLowerCase() !== toTopic) continue;
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    if (value >= opts.feeUnits) return { ok: true };
  }
  return { ok: false, reason: 'no_matching_transfer' };
}
