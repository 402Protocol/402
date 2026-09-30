import { defineChain } from 'viem';

/** Ink mainnet. EVM-compatible OP Stack L2, ETH gas token, ~1s blocks. */
export const CHAIN_ID = 57073;

/**
 * Native Circle-issued USDC on Ink.
 * Verified 2026-09-22: Circle blog "USDC & CCTP V2 on Ink" + live Ink RPC
 * eth_call (name/symbol/decimals/version) + Blockscout token record.
 * NOT the bridged deployment — use this address for all 402 payment code.
 */
export const USDC_ADDRESS =
  '0x2D270e6886d130D724215A266106e6832161EAEd' as const;

export const USDC_DECIMALS = 6;

export const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000' as const;

export const INK_RPC_URL = 'https://rpc-gel.inkonchain.com';

export const ink = defineChain({
  id: CHAIN_ID,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [INK_RPC_URL] },
  },
});
