/**
 * 402 Lounge — EIP-712 signing domain and signature verification.
 *
 * Domain: name "402 Lounge", version "1", chainId 57073 (Ink). No
 * verifyingContract — the lounge is identified by chain + name, and the
 * payment leg (not the signature) is what binds a post to real value.
 */
import {
  type Address,
  type Hex,
  getAddress,
  recoverTypedDataAddress,
} from 'viem';
import { LOUNGE_CHAIN_ID } from './types.js';

export const LOUNGE_DOMAIN: { name: string; version: string; chainId: number } = {
  name: '402 Lounge',
  version: '1',
  chainId: LOUNGE_CHAIN_ID,
};

export const LOUNGE_TYPES: Record<string, { name: string; type: string }[]> = {
  LoungePost: [
    { name: 'author', type: 'address' },
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
  LoungeComment: [
    { name: 'author', type: 'address' },
    { name: 'postId', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'parentId', type: 'string' },
  ],
  LoungeVote: [
    { name: 'author', type: 'address' },
    { name: 'postId', type: 'string' },
    { name: 'direction', type: 'int8' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

/** Timestamps must be within ±5 minutes of server time (replay protection). */
export const TIMESTAMP_SKEW_SECONDS = 300;

export function timestampFresh(
  timestamp: bigint,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const t = Number(timestamp);
  if (!Number.isSafeInteger(t)) return false;
  return Math.abs(nowSeconds - t) <= TIMESTAMP_SKEW_SECONDS;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Recover the signer of a typed lounge message and require it to equal the
 * claimed author. Returns ok:false (never throws) on any malformed input.
 */
export async function verifyLoungeSignature(opts: {
  primaryType: 'LoungePost' | 'LoungeComment' | 'LoungeVote';
  message: Record<string, unknown>;
  signature: string;
  author: string;
}): Promise<VerifyResult> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(opts.signature)) {
    return { ok: false, reason: 'malformed_signature' };
  }
  let recovered: Address;
  try {
    const params = {
      domain: LOUNGE_DOMAIN,
      types: LOUNGE_TYPES,
      primaryType: opts.primaryType,
      message: opts.message,
      signature: opts.signature as Hex,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0];
    recovered = await recoverTypedDataAddress(params);
  } catch {
    return { ok: false, reason: 'unrecoverable_signature' };
  }
  let claimed: Address;
  try {
    claimed = getAddress(opts.author);
  } catch {
    return { ok: false, reason: 'invalid_author' };
  }
  if (recovered.toLowerCase() !== claimed.toLowerCase()) {
    return { ok: false, reason: 'signature_author_mismatch' };
  }
  return { ok: true };
}
