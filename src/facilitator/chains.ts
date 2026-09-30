/**
 * 402 Phase 2 — chain registry for the facilitator.
 *
 * Everything the facilitator needs to know about a chain lives here: RPC,
 * settlement token, and the EIP-712 domain that token uses for EIP-3009
 * authorizations. Adding a chain (e.g. Robinhood Chain 4663) is one entry —
 * no Ink-specific code paths exist anywhere else.
 */
import type { Address } from 'viem';
import {
  CHAIN_ID,
  INK_RPC_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from '../constants.js';

export interface ChainConfig {
  chainId: number;
  /** CAIP-2 id, e.g. "eip155:57073". */
  caip2: `eip155:${number}`;
  name: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  usdc: {
    address: Address;
    decimals: number;
    /** EIP-712 domain name — read from the live contract, not assumed. */
    eip712Name: string;
    eip712Version: string;
  };
}

export const INK_CONFIG: ChainConfig = {
  chainId: CHAIN_ID,
  caip2: `eip155:${CHAIN_ID}`,
  name: 'Ink',
  rpcUrl: INK_RPC_URL,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  usdc: {
    address: USDC_ADDRESS,
    decimals: USDC_DECIMALS,
    // Verified 2026-09-22 against Ink USDC's onchain DOMAIN_SEPARATOR:
    // name() returns "USDC" here (NOT "USD Coin" as on mainnet), version "2".
    eip712Name: 'USDC',
    eip712Version: '2',
  },
};

/** All chains this facilitator serves. Robinhood Chain (4663) plugs in here. */
export const CHAINS: Record<number, ChainConfig> = {
  [CHAIN_ID]: INK_CONFIG,
};

/** Look up a chain by CAIP-2 network id ("eip155:57073"). Null when unknown. */
export function chainFromCaip2(network: string): ChainConfig | null {
  const m = /^eip155:(\d+)$/.exec(network.trim());
  if (!m) return null;
  return CHAINS[Number(m[1])] ?? null;
}
