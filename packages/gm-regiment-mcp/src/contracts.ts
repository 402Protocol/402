/**
 * gm-regiment-mcp — contract ABIs + shared onchain helpers.
 *
 * Addresses are sergio-inkfnd's gm.ink family on Ink mainnet (see
 * https://github.com/sergio-inkfnd/gm-mcp for the canonical deployment
 * list). The ERC-8004 Identity Registry is the live registry the 402
 * protocol also uses for TRACES seat pairing.
 */
import { type Address, type PublicClient, parseAbi } from 'viem';
import {
  DAILY_AGENT_GM_ADDRESS,
  GAS_DUST_WEI,
  type GmRegimentConfig,
} from './config.js';
import { publicClient } from './chain.js';

export const identityRegistryAbi = parseAbi([
  'function register(string uri) returns (uint256 agentId)',
  'function ownerOf(uint256 agentId) view returns (address)',
]);

export const dailyAgentGmAbi = parseAbi([
  'function gm()',
  'function gmTo(address recipient)',
  'function lastGM(address user) view returns (uint256)',
  'function isAgent(address account) view returns (bool)',
]);

export async function readIsAgent(
  client: PublicClient,
  account: Address,
): Promise<boolean> {
  return client.readContract({
    address: DAILY_AGENT_GM_ADDRESS,
    abi: dailyAgentGmAbi,
    functionName: 'isAgent',
    args: [account],
  });
}

export async function readLastGM(
  client: PublicClient,
  account: Address,
): Promise<bigint> {
  return client.readContract({
    address: DAILY_AGENT_GM_ADDRESS,
    abi: dailyAgentGmAbi,
    functionName: 'lastGM',
    args: [account],
  });
}

export interface GasGatePass {
  ok: true;
  address: Address;
  balanceWei: bigint;
}

export interface GasGateFail {
  ok: false;
  needsGas: true;
  address: Address;
  balanceWei: bigint;
  instruction: string;
}

/**
 * Gas gate: refuse to prepare a write when the wallet cannot cover gas.
 * Returns a fail object carrying a human-readable funding instruction.
 */
export async function checkGas(
  config: GmRegimentConfig,
  address: Address,
): Promise<GasGatePass | GasGateFail> {
  const balance = await publicClient(config).getBalance({ address });
  if (balance < GAS_DUST_WEI) {
    return {
      ok: false,
      needsGas: true,
      address,
      balanceWei: balance,
      instruction:
        `This wallet holds ${balance.toString()} wei of ETH on Ink — not enough for gas. ` +
        `Ask the human to send a little ETH on Ink (chain 57073) to ${address}, ` +
        'then re-run this tool.',
    };
  }
  return { ok: true, address, balanceWei: balance };
}
