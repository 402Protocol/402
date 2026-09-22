/**
 * 402 Phase 2 — /verify core for the `exact` scheme on EVM.
 *
 * Pure offchain checks (no RPC): signature recovery plus policy checks
 * against the payment requirements. On success the nonce is marked consumed
 * (unless opts.markUsed is false) so the same authorization can't verify
 * twice — that's the replay protection.
 *
 * Endpoint policy (H1): the public POST /verify passes markUsed: false — it
 * is a read-only check. Nonce consumption happens only in /settle (after
 * broadcast confirmation / passed simulation) and in /demo/data (on grant).
 *
 * invalidReason codes are our interpretation of the x402 error taxonomy
 * (e.g. "invalid_exact_evm_payload_signature"); see README for the list.
 */
import {
  type Address,
  type Hex,
  getAddress,
  isAddress,
  isHex,
  recoverTypedDataAddress,
} from 'viem';
import { chainFromCaip2, type ChainConfig } from './chains.js';
import { EIP3009_TYPES, eip3009Domain } from './eip3009.js';
import { NonceStore } from './nonces.js';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyRequest,
  VerifyResponse,
} from './types.js';

export interface VerifyOptions {
  store: NonceStore;
  /** Mark the nonce consumed on success. Default true. */
  markUsed?: boolean;
  nowSec?: number;
}

function fail(reason: string): VerifyResponse {
  return { isValid: false, invalidReason: reason };
}

/** Parse a base-10 or 0x-quantity string to bigint. Null on garbage. */
function parseUintString(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * The resource server tells the facilitator what it required; the payload
 * carries what the payer accepted. They must agree on the money fields.
 */
function acceptedMatchesRequirements(
  accepted: PaymentRequirements,
  required: PaymentRequirements,
): boolean {
  return (
    accepted.scheme === required.scheme &&
    accepted.network === required.network &&
    sameAddress(accepted.asset, required.asset) &&
    accepted.amount === required.amount &&
    sameAddress(accepted.payTo, required.payTo)
  );
}

export async function verifyExactPayment(
  req: VerifyRequest,
  opts: VerifyOptions,
): Promise<VerifyResponse> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const markUsed = opts.markUsed ?? true;

  const { paymentPayload, paymentRequirements } = req ?? {};
  if (!paymentPayload || !paymentRequirements) return fail('invalid_request');

  const payload: PaymentPayload = paymentPayload;
  const required: PaymentRequirements = paymentRequirements;

  if (payload.x402Version !== 2) return fail('unsupported_version');
  if (required.scheme !== 'exact') return fail('unsupported_scheme');

  const cfg: ChainConfig | null = chainFromCaip2(required.network);
  if (!cfg) return fail('invalid_network');

  if (!payload.accepted || !acceptedMatchesRequirements(payload.accepted, required)) {
    return fail('requirements_mismatch');
  }
  if (!isAddress(required.asset) || !sameAddress(required.asset, cfg.usdc.address)) {
    return fail('invalid_asset');
  }
  const amount = parseUintString(required.amount);
  if (amount === null || amount <= 0n) return fail('invalid_amount');
  if (!isAddress(required.payTo)) return fail('invalid_pay_to');

  const inner = payload.payload;
  const auth = inner?.authorization;
  if (
    !inner ||
    typeof inner.signature !== 'string' ||
    !isHex(inner.signature) ||
    !auth ||
    typeof auth.from !== 'string' ||
    typeof auth.to !== 'string'
  ) {
    return fail('invalid_exact_evm_payload');
  }

  const value = parseUintString(auth.value);
  const validAfter = parseUintString(auth.validAfter);
  const validBefore = parseUintString(auth.validBefore);
  if (
    value === null ||
    validAfter === null ||
    validBefore === null ||
    !isHex(auth.nonce) ||
    auth.nonce.length !== 66 ||
    !isAddress(auth.from) ||
    !isAddress(auth.to)
  ) {
    return fail('invalid_exact_evm_payload');
  }

  if (value !== amount) return fail('amount_mismatch');
  if (!sameAddress(auth.to, required.payTo)) return fail('recipient_mismatch');

  // Signature must recover to authorization.from over the token's EIP-712 domain.
  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: eip3009Domain(cfg),
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(auth.from),
        to: getAddress(auth.to),
        value,
        validAfter,
        validBefore,
        nonce: auth.nonce as Hex,
      },
      signature: inner.signature as Hex,
    });
  } catch {
    return fail('invalid_exact_evm_payload_signature');
  }
  if (!sameAddress(signer, auth.from)) {
    return fail('invalid_exact_evm_payload_signature');
  }

  if (BigInt(nowSec) < validAfter) return fail('authorization_not_yet_valid');
  if (BigInt(nowSec) >= validBefore) return fail('authorization_expired');

  if (opts.store.has(cfg.chainId, auth.nonce, nowSec)) {
    return fail('nonce_replay');
  }
  if (markUsed) {
    opts.store.mark(cfg.chainId, auth.nonce, Number(validBefore));
  }

  return {
    isValid: true,
    invalidReason: '',
    payer: getAddress(auth.from),
  };
}
