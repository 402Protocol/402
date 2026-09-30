/**
 * 402 Phase 2 — x402 v2 wire types for the facilitator surface.
 *
 * Field names follow the x402 spec (Coinbase/x402, x402Version 2):
 *   GET  /supported -> SupportedResponse
 *   POST /verify    -> { paymentPayload, paymentRequirements } -> VerifyResponse
 *   POST /settle    -> { paymentPayload, paymentRequirements } -> SettleResponse
 *
 * This facilitator implements the `exact` scheme on EVM, where the payment
 * payload is an EIP-3009 `transferWithAuthorization` signed by the payer.
 */
import type { Address, Hex } from 'viem';

export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2 network id, e.g. "eip155:57073". */
  network: string;
  /** Settlement token contract address. */
  asset: string;
  /** Amount in the token's smallest unit, base-10 string. */
  amount: string;
  /** Recipient of the payment. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface ExactEvmAuthorization {
  from: string;
  to: string;
  /** Atomic token units, base-10 (or 0x hex) string. */
  value: string;
  validAfter: string;
  validBefore: string;
  /** bytes32 hex. */
  nonce: Hex;
}

export interface ExactEvmPayload {
  /** EIP-712 signature over the TransferWithAuthorization struct. */
  signature: Hex;
  authorization: ExactEvmAuthorization;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}

export interface VerifyRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  /** Empty string when valid; machine-readable code otherwise. */
  invalidReason: string;
  payer?: Address;
}

export interface SettleRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface SettleResponse {
  success: boolean;
  /** Onchain tx hash. Present only when a transaction was actually broadcast. */
  transaction?: Hex;
  /** CAIP-2 network id. */
  network?: string;
  payer?: Address;
  /** Machine-readable code, present when success is false. */
  errorReason?: string;
  /** True when the dry-run path was used (nothing broadcast). */
  dryRun?: boolean;
  detail?: string;
}

export interface SupportedResponse {
  kinds: { x402Version: number; scheme: string; network: string }[];
  extensions: string[];
  /** Settler addresses per network. Omitted when no settler key is configured. */
  signers?: Record<string, Address[]>;
}

export interface PaymentRequired {
  x402Version: number;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}
