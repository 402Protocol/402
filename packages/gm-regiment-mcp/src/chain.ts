/**
 * gm-regiment-mcp — viem client factories (Ink mainnet).
 */
import {
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ink, type GmRegimentConfig } from './config.js';

export function publicClient(config: GmRegimentConfig): PublicClient {
  return createPublicClient({
    chain: ink,
    transport: config.transport ?? http(config.inkRpcUrl),
  });
}

export function walletClientFor(
  privateKey: Hex,
  config: GmRegimentConfig,
): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: ink,
    transport: config.transport ?? http(config.inkRpcUrl),
  });
}
