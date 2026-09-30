/**
 * Read-only views over the deployed Four02ReputationRegistry on Ink.
 *
 * The registry is append-only: writers (authorized 402 protocol contracts)
 * record commerce events keyed to an ERC-8004 agentId, and these views
 * derive trust signals from them. All functions here are pure reads —
 * nothing here ever writes, signs, or spends.
 */
import {
  type Address,
  type PublicClient,
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
} from 'viem';
import { DEFAULT_INK_RPC_URL, ink } from './config.js';

/** Ink chain descriptor (minimal: id + name + native currency). */

const registryAbi = parseAbi([
  'function summary(uint256 agentId) view returns (uint256 reliability, uint256 disputeRateBps, uint256 arbitrationWins, uint256 arbitrationLosses, uint256 totalEvents, uint64 lastEventTimestamp)',
  'function reliability(uint256 agentId) view returns (uint256)',
  'function disputeRate(uint256 agentId) view returns (uint256)',
  'function arbitrationRecord(uint256 agentId) view returns (uint256 wins, uint256 losses)',
  'function getVersion() view returns (string)',
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);

export interface AgentSummaryView {
  agentId: string;
  reliability: number;
  disputeRateBps: number;
  arbitrationWins: number;
  arbitrationLosses: number;
  totalEvents: number;
  lastEventTimestamp: number | null;
}

export interface FeedbackEntry {
  writer: Address;
  feedbackIndex: string;
  /** USDC value of the commerce event (6 decimals), as a decimal string. */
  valueUsdc: string;
  eventType: string;
  namespace: string;
}

export function publicClient(rpcUrl: string = DEFAULT_INK_RPC_URL): PublicClient {
  return createPublicClient({ chain: ink, transport: http(rpcUrl) });
}

export async function readSummary(
  client: PublicClient,
  registry: Address,
  agentId: bigint,
): Promise<AgentSummaryView> {
  const [reliability, disputeRateBps, arbitrationWins, arbitrationLosses, totalEvents, lastEventTimestamp] =
    await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'summary',
      args: [agentId],
    });
  return {
    agentId: agentId.toString(),
    reliability: Number(reliability),
    disputeRateBps: Number(disputeRateBps),
    arbitrationWins: Number(arbitrationWins),
    arbitrationLosses: Number(arbitrationLosses),
    totalEvents: Number(totalEvents),
    lastEventTimestamp: lastEventTimestamp === 0n ? null : Number(lastEventTimestamp),
  };
}

export async function readReliability(
  client: PublicClient,
  registry: Address,
  agentId: bigint,
): Promise<{ agentId: string; reliability: number; disputeRateBps: number }> {
  const [reliability, disputeRateBps] = await Promise.all([
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'reliability',
      args: [agentId],
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'disputeRate',
      args: [agentId],
    }),
  ]);
  return {
    agentId: agentId.toString(),
    reliability: Number(reliability),
    disputeRateBps: Number(disputeRateBps),
  };
}

/**
 * Raw commerce-event history for an agent, mapped through the ERC-8004
 * feedback interface. Newest entries last; pass `limit` to cap the tail.
 */
export async function readHistory(
  client: PublicClient,
  registry: Address,
  agentId: bigint,
  limit = 50,
): Promise<{ agentId: string; count: number; returned: number; entries: FeedbackEntry[] }> {
  const [clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s] =
    await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'readAllFeedback',
      args: [agentId, [], '', '', false],
    });
  const total = clients.length;
  const start = Math.max(0, total - limit);
  const entries: FeedbackEntry[] = [];
  for (let i = start; i < total; i++) {
    entries.push({
      writer: clients[i],
      feedbackIndex: feedbackIndexes[i].toString(),
      valueUsdc: formatUnits(values[i], valueDecimals[i]),
      eventType: tag1s[i],
      namespace: tag2s[i],
    });
  }
  return { agentId: agentId.toString(), count: total, returned: entries.length, entries };
}

export async function readRegistryVersion(
  client: PublicClient,
  registry: Address,
): Promise<string> {
  return client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: 'getVersion',
    args: [],
  });
}
