/**
 * four02-commerce-mcp — configuration.
 *
 * Everything is env-driven. Keys are OPTIONAL and env-only: the server never
 * accepts a private key as a tool argument, never logs one, and never
 * transmits one. Without the *_KEY vars the signing/payment tools return
 * client-side instructions instead of acting.
 *
 *   FOUR02_COMMERCE_FACILITATOR_URL  base URL of the 402 facilitator
 *                                    (default https://402-production.up.railway.app)
 *   FOUR02_COMMERCE_INK_RPC_URL      Ink RPC for reads
 *                                    (default https://rpc-gel.inkonchain.com)
 *   FOUR02_COMMERCE_REGISTRY         Four02ReputationRegistry address on Ink
 *                                    (default the production deployment)
 *   FOUR02_COMMERCE_INVOICE_KEY      optional issuer key for
 *                                    four02_invoice_create server-side signing
 *   FOUR02_COMMERCE_PAYER_KEY        optional payer key for
 *                                    four02_invoice_pay broadcast mode
 */
import type { Hex } from 'viem';
import { defineChain } from 'viem';

export const CHAIN_ID = 57073;

/** Native Circle-issued USDC on Ink (NOT bridged). Verified 2026-09-22. */
export const USDC_ADDRESS =
  '0x2D270e6886d130D724215A266106e6832161EAEd' as const;
export const USDC_DECIMALS = 6;

export const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000' as const;

export const DEFAULT_INK_RPC_URL = 'https://rpc-gel.inkonchain.com';
export const DEFAULT_FACILITATOR_URL = 'https://402-production.up.railway.app';

/** Four02ReputationRegistry, deployed on Ink mainnet 2026-09-25. */
export const DEFAULT_REGISTRY_ADDRESS =
  '0x33E2c56035C059553a37a3A56199B5b5b3DA3365' as const;

/** Ink mainnet chain descriptor for viem clients. */
export const ink = defineChain({
  id: CHAIN_ID,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_INK_RPC_URL] } },
});

export interface CommerceConfig {
  facilitatorUrl: string;
  inkRpcUrl: string;
  registryAddress: `0x${string}`;
  /** Optional issuer key for four02_invoice_create. Env only. */
  invoiceSignerKey?: Hex;
  /** Optional payer key for four02_invoice_pay broadcast. Env only. */
  payerKey?: Hex;
}

function cleanUrl(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim().replace(/\/+$/, '');
  return s || fallback;
}

function cleanAddress(v: string | undefined, fallback: `0x${string}`): `0x${string}` {
  const s = (v ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? (s as `0x${string}`) : fallback;
}

function cleanKey(v: string | undefined): Hex | undefined {
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : undefined;
}

export function loadCommerceConfig(
  env: Record<string, string | undefined> = process.env,
): CommerceConfig {
  return {
    facilitatorUrl: cleanUrl(env.FOUR02_COMMERCE_FACILITATOR_URL, DEFAULT_FACILITATOR_URL),
    inkRpcUrl: cleanUrl(env.FOUR02_COMMERCE_INK_RPC_URL, DEFAULT_INK_RPC_URL),
    registryAddress: cleanAddress(env.FOUR02_COMMERCE_REGISTRY, DEFAULT_REGISTRY_ADDRESS),
    invoiceSignerKey: cleanKey(env.FOUR02_COMMERCE_INVOICE_KEY),
    payerKey: cleanKey(env.FOUR02_COMMERCE_PAYER_KEY),
  };
}
