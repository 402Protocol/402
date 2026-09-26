/**
 * Onchain helpers: native USDC on Ink (transfers + Transfer log scans).
 *
 * VENDORED into four02-commerce-mcp from the 402 monorepo
 * (~/workspace/402/src/settle.ts). Keep in sync with the source of truth.
 */
import {
  type Address,
  type PublicClient,
  createPublicClient,
  http,
  parseAbiItem,
} from 'viem';
import { DEFAULT_INK_RPC_URL, USDC_ADDRESS, ink } from './config.js';

export const usdcTransferAbi = [
  parseAbiItem('function transfer(address to, uint256 amount) returns (bool)'),
] as const;

export const usdcTransferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export function publicClient(rpcUrl: string = DEFAULT_INK_RPC_URL): PublicClient {
  return createPublicClient({ chain: ink, transport: http(rpcUrl) });
}

export interface TransferHit {
  txHash: string;
  blockNumber: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

/** Max eth_getLogs block range the public Ink RPC accepts. */
const MAX_LOG_RANGE = 10_000n;

/**
 * Scan USDC Transfer events to `to`, optionally from a specific sender,
 * keeping only those >= minAmount. Heuristic for "was this invoice paid".
 */
export async function findUsdcTransfers(opts: {
  to: Address;
  from?: Address;
  minAmount: bigint;
  fromBlock: bigint;
  toBlock?: bigint;
  rpcUrl?: string;
}): Promise<TransferHit[]> {
  const client = publicClient(opts.rpcUrl);
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());
  const hits: TransferHit[] = [];
  // Paginate: the public RPC rejects ranges over MAX_LOG_RANGE blocks.
  for (let from = opts.fromBlock; from <= toBlock; ) {
    const chunkTo = from + MAX_LOG_RANGE - 1n > toBlock ? toBlock : from + MAX_LOG_RANGE - 1n;
    const logs = await client.getLogs({
      address: USDC_ADDRESS,
      event: usdcTransferEvent,
      args: { ...(opts.from ? { from: opts.from } : {}), to: opts.to },
      fromBlock: from,
      toBlock: chunkTo,
    });
    for (const l of logs) {
      if ((l.args.value ?? 0n) >= opts.minAmount) {
        hits.push({
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          from: l.args.from as Address,
          to: l.args.to as Address,
          value: l.args.value as bigint,
        });
      }
    }
    from = chunkTo + 1n;
  }
  return hits;
}

export async function latestBlock(rpcUrl?: string): Promise<bigint> {
  return publicClient(rpcUrl).getBlockNumber();
}
