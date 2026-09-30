/**
 * 402 Phase 1 — EIP-712 invoice library.
 *
 * Invoices are offchain typed data signed by the issuer. Verification is pure
 * ECDSA recovery: anyone can verify with no RPC access at all.
 */
import {
  type Address,
  type Hex,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID, USDC_ADDRESS } from './constants.js';

export const INVOICE_DOMAIN_NAME = '402 Invoice';
export const INVOICE_DOMAIN_VERSION = '1';

export interface Invoice {
  /** Seller agent address (must match the EIP-712 signer). */
  issuer: Address;
  /** Buyer agent address. Zero address = payable by anyone. */
  payer: Address;
  /** Settlement token. Must be the verified native USDC on Ink. */
  token: Address;
  /** Amount in the token's smallest unit (6 decimals for USDC). */
  amount: bigint;
  /** Must be 57073 (Ink). Present in the struct AND the EIP-712 domain. */
  chainId: bigint;
  /** Unix seconds after which the invoice is void. */
  expiresAt: bigint;
  /** Replay protection. Must be nonzero; issuers should use a random value. */
  nonce: bigint;
  /** Human-readable line item, e.g. "10k embeddings API calls". */
  description: string;
  /** keccak256 of the full service terms document (IPFS/HTTPS). */
  termsHash: Hex;
}

export interface SignedInvoice {
  invoice: Invoice;
  /** EIP-712 signature over the invoice, by `invoice.issuer`. */
  signature: Hex;
  /** EIP-712 digest of the invoice. Content-addressed ID: any tampering breaks it. */
  id: Hex;
}

const invoiceTypes = {
  Invoice: [
    { name: 'issuer', type: 'address' },
    { name: 'payer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'chainId', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'description', type: 'string' },
    { name: 'termsHash', type: 'bytes32' },
  ],
} as const;

function domain() {
  return {
    name: INVOICE_DOMAIN_NAME,
    version: INVOICE_DOMAIN_VERSION,
    chainId: CHAIN_ID,
  } as const;
}

/** Normalize an invoice: checksummed addresses, real bigints. Throws on garbage. */
export function normalizeInvoice(inv: Invoice): Invoice {
  if (!isAddress(inv.issuer)) throw new Error('invalid issuer address');
  if (!isAddress(inv.payer)) throw new Error('invalid payer address');
  if (!isAddress(inv.token)) throw new Error('invalid token address');
  if (!/^0x[0-9a-fA-F]{64}$/.test(inv.termsHash))
    throw new Error('termsHash must be bytes32');
  return {
    issuer: getAddress(inv.issuer),
    payer: getAddress(inv.payer),
    token: getAddress(inv.token),
    amount: BigInt(inv.amount),
    chainId: BigInt(inv.chainId),
    expiresAt: BigInt(inv.expiresAt),
    nonce: BigInt(inv.nonce),
    description: String(inv.description),
    termsHash: inv.termsHash.toLowerCase() as Hex,
  };
}

/** EIP-712 digest of the invoice. This is the invoice's canonical ID. */
export function hashInvoice(invoice: Invoice): Hex {
  const inv = normalizeInvoice(invoice);
  return hashTypedData({
    domain: domain(),
    types: invoiceTypes,
    primaryType: 'Invoice',
    message: { ...inv },
  });
}

/**
 * Sign an invoice with the issuer's private key.
 * The key must correspond to `invoice.issuer` — otherwise this throws.
 * Keys come from env only; never accept them as function args from chat.
 */
export async function signInvoice(
  invoice: Invoice,
  privateKey: Hex,
): Promise<SignedInvoice> {
  const inv = normalizeInvoice(invoice);
  const account = privateKeyToAccount(privateKey);
  if (getAddress(account.address) !== inv.issuer) {
    throw new Error('signing key does not match invoice issuer');
  }
  const signature = await account.signTypedData({
    domain: domain(),
    types: invoiceTypes,
    primaryType: 'Invoice',
    message: { ...inv },
  });
  return { invoice: inv, signature, id: hashInvoice(inv) };
}

export interface VerificationResult {
  valid: boolean;
  /** Address the signature recovers to (null if recovery failed). */
  signer: Address | null;
  errors: string[];
}

/**
 * Verify a signed invoice. Pure cryptography + policy checks — no RPC needed.
 * The skill MUST call this before paying, always.
 */
export async function verifyInvoice(
  signed: SignedInvoice,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<VerificationResult> {
  const errors: string[] = [];
  let inv: Invoice;
  try {
    inv = normalizeInvoice(signed.invoice);
  } catch (e) {
    return {
      valid: false,
      signer: null,
      errors: [`malformed invoice: ${(e as Error).message}`],
    };
  }

  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: domain(),
      types: invoiceTypes,
      primaryType: 'Invoice',
      message: { ...inv },
      signature: signed.signature,
    });
  } catch {
    errors.push('signature recovery failed');
  }
  if (signer && getAddress(signer) !== inv.issuer) {
    errors.push('signature does not recover to the issuer address');
  }
  if (getAddress(inv.token) !== getAddress(USDC_ADDRESS)) {
    errors.push(`token is not the verified native USDC on Ink (${USDC_ADDRESS})`);
  }
  if (inv.chainId !== BigInt(CHAIN_ID)) {
    errors.push(`chainId is not Ink (${CHAIN_ID})`);
  }
  if (inv.amount <= 0n) errors.push('amount must be positive');
  if (inv.nonce <= 0n) errors.push('nonce must be nonzero');
  if (inv.expiresAt <= BigInt(nowSec)) errors.push('invoice is expired');
  if (!inv.description.trim()) errors.push('description is empty');

  let recomputed: Hex | null = null;
  try {
    recomputed = hashInvoice(inv);
  } catch {
    errors.push('could not hash invoice');
  }
  if (
    recomputed &&
    signed.id.toLowerCase() !== recomputed.toLowerCase()
  ) {
    errors.push('invoice id does not match the payload hash (tampered?)');
  }

  return { valid: errors.length === 0, signer, errors };
}

/** keccak256 of a terms document. Pass the full text (or canonical URL + text). */
export function hashTerms(terms: string): Hex {
  return keccak256(stringToHex(terms));
}

// ---- JSON serialization (bigints survive the round trip) ----

const BIGINT_FIELDS = new Set(['amount', 'chainId', 'expiresAt', 'nonce']);

export function serializeSignedInvoice(signed: SignedInvoice): string {
  return JSON.stringify(
    signed,
    (key, value) =>
      BIGINT_FIELDS.has(key) && typeof value === 'bigint'
        ? `bigint:${value.toString()}`
        : value,
    2,
  );
}

export type ParseInvoiceResult =
  | { ok: true; signed: SignedInvoice }
  | { ok: false; error: string };

/**
 * Parse a serialized signed invoice. L2: fail-SOFT — malformed input returns
 * a structured error instead of throwing, so library/server callers get a
 * clean failure. (Semantic validation still lives in verifyInvoice.)
 */
export function parseSignedInvoice(json: string): ParseInvoiceResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.invoice !== 'object' || o.invoice === null || Array.isArray(o.invoice)) {
    return { ok: false, error: 'missing "invoice" object' };
  }
  if (typeof o.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(o.signature)) {
    return { ok: false, error: 'missing or invalid "signature"' };
  }
  if (typeof o.id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.id)) {
    return { ok: false, error: 'missing or invalid "id"' };
  }
  const inv = o.invoice as Record<string, unknown>;
  let amount: bigint;
  let chainId: bigint;
  let expiresAt: bigint;
  let nonce: bigint;
  try {
    amount = toBigInt(inv.amount);
    chainId = toBigInt(inv.chainId);
    expiresAt = toBigInt(inv.expiresAt);
    nonce = toBigInt(inv.nonce);
  } catch (e) {
    return { ok: false, error: `invalid bigint field: ${(e as Error).message}` };
  }
  return {
    ok: true,
    signed: {
      invoice: { ...inv, amount, chainId, expiresAt, nonce } as Invoice,
      signature: o.signature as Hex,
      id: o.id as Hex,
    },
  };
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && v.startsWith('bigint:'))
    return BigInt(v.slice('bigint:'.length));
  return BigInt(v as string | number);
}
