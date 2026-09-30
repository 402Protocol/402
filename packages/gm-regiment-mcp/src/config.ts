/**
 * gm-regiment-mcp — configuration.
 *
 * Everything is env-driven. The server never stores private keys: write
 * tools take the agent's key per-call (it is never logged, stored, or
 * transmitted anywhere except inside the signed transaction broadcast),
 * and read tools need no key at all.
 *
 *   GM_REGIMENT_INK_RPC_URL   Ink RPC for reads + writes
 *                             (default https://rpc-gel.inkonchain.com)
 */
import type { Transport } from 'viem';
import { defineChain } from 'viem';

export const CHAIN_ID = 57073;

export const DEFAULT_INK_RPC_URL = 'https://rpc-gel.inkonchain.com';

/**
 * ERC-8004 Identity Registry on Ink mainnet.
 * Verified 2026-09-25: IdentityRegistryUpgradeable with register(string).
 */
export const IDENTITY_REGISTRY_ADDRESS =
  '0x7274e874CA62410a93Bd8bf61c69d8045E399c02' as const;

/**
 * DailyAgentGM on Ink mainnet (sergio-inkfnd, the gm.ink contracts).
 * Free except gas; caller (and recipient on gmTo) must hold an ERC-8004
 * identity NFT from IDENTITY_REGISTRY_ADDRESS.
 */
export const DAILY_AGENT_GM_ADDRESS =
  '0x2B9DD9Eede2AeCB095455ce45122101109E4AeC7' as const;

/** DailyAgentGM cooldown: one free agent GM per 24h. */
export const GM_COOLDOWN_SECONDS = 86_400;

/**
 * Dust threshold: below 0.0001 ETH a wallet cannot realistically cover gas
 * on Ink, so write tools refuse to prepare a transaction and instead return
 * a "needs gas" response guiding the human to fund the wallet.
 */
export const GAS_DUST_WEI = 100_000_000_000_000n;

/** Ink mainnet chain descriptor for viem clients. */
export const ink = defineChain({
  id: CHAIN_ID,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_INK_RPC_URL] } },
});

export interface GmRegimentConfig {
  inkRpcUrl: string;
  /** Optional transport override — tests inject a mocked transport here. */
  transport?: Transport;
}

function cleanUrl(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim().replace(/\/+$/, '');
  return s || fallback;
}

export function loadGmRegimentConfig(
  env: Record<string, string | undefined> = process.env,
): GmRegimentConfig {
  return {
    inkRpcUrl: cleanUrl(env.GM_REGIMENT_INK_RPC_URL, DEFAULT_INK_RPC_URL),
  };
}
