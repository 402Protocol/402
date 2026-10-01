/**
 * panel-verify — keeper honesty monitor (High 1).
 *
 * Independently recomputes an epoch's reviewer-panel batches from
 * `reviewer_stats` (same computeAgreementBps / buildBatch / chunkBatch /
 * computeBatchHash as the keeper) and diffs them against what actually
 * landed onchain: the writer's BatchSubmitted events plus per-agent
 * registry state. Reports ANY divergence:
 *
 *   - missing chunk:      a planned chunk with no onchain BatchSubmitted
 *   - hash mismatch:      onchain batchHash != recomputed hash
 *   - count mismatch:     onchain count != chunk length
 *   - wrong bps:          the registry panel event's value != expected bps
 *   - missing panel event: agent in a verified chunk with no matching
 *                         onchain panel event (refId check)
 *   - unexpected chunk:   an onchain BatchSubmitted for the day that the
 *                         keeper's submitted receipt does not account for
 *   - agent never in a batch: an agent with writer-attributed panel events
 *                         for the epoch that the expected batch does not
 *                         contain (caught via hash/count on the chunk, and
 *                         via the per-agent refId sweep below)
 *
 * Halving splits are legitimate: when the keeper's simulation fails it
 * re-submits halves under fresh chunk indices and records them in
 * panel-batch-<day>.submitted.json (the M4 receipt). Verify reads that
 * receipt when present (--submitted-bundle, default
 * <bundle-dir>/panel-batch-<day>.submitted.json): every receipt chunk's
 * hash must recompute, the receipt's entries must union to exactly the
 * planned batch, and every receipt chunk must have a matching onchain
 * BatchSubmitted. Without a receipt, verify runs in strict mode: the
 * onchain chunks must equal the planned chunks exactly (a missing planned
 * chunk is a divergence, not an assumed split).
 *
 * This is the automated check against a dishonest-but-scheduled keeper:
 * a keeper that submits well-formed-looking batches with fabricated scores
 * fails the hash and wrong-bps checks, because the hashes commit to the
 * DB-derived contents. Run it manually before keeper output becomes
 * load-bearing for dispatch ranking (runbook: manual cadence).
 *
 * Read-only: broadcasts nothing, needs no keys.
 *
 *   npx tsx src/jobs/panel-verify.ts --writer 0x... [--date 20260929]
 *     [--db ./jobs.db] [--rpc URL] [--bundle-dir ./panel-bundles]
 *     [--chunk-size 70] [--registry 0x... | FOUR02_REPUTATION_REGISTRY]
 *
 * --chunk-size must match the keeper run being verified (default 70); it
 * only matters in strict mode (no submitted receipt).
 *
 * Exit codes: 0 clean · 1 divergence found or refusal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from 'viem';
import { INK_RPC_URL, ink } from '../constants.js';
import { JobsDb } from './db.js';
import {
  MAX_BATCH,
  buildBatch,
  chunkBatch,
  computeBatchHash,
  epochDayFor,
  epochIdFor,
  parseYmd,
  type BatchEntry,
} from './panel-keeper.js';
import { optional, parseArgs } from '../cli/args.js';

const verifyWriterAbi = parseAbi([
  'event BatchSubmitted(uint256 indexed epochId, uint256 count, bytes32 batchHash)',
  'function REGISTRY() external view returns (address)',
  'function epochSubmitted(uint256 epochId) external view returns (bool)',
]);
const verifyRegistryAbi = parseAbi([
  'function isWriter(address) external view returns (bool)',
  'function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)',
  'function events(uint256 agentId, uint256 index) external view returns (uint8 eventType, uint256 value, uint64 timestamp, bytes32 refId, address writer, address counterparty)',
]);

/** EscrowCompleted — the panel carrier event type (registry EventType enum). */
const ESCROW_COMPLETED = 3;

/**
 * The panel refId the writer commits per event:
 * keccak256(abi.encodePacked("402:panel-review/v1", epochId, agentId)).
 * Must match PanelBatchWriter.submitBatch exactly.
 */
export function expectedPanelRefId(epochId: number, agentId: bigint): `0x${string}` {
  return keccak256(
    encodePacked(
      ['string', 'uint256', 'uint256'],
      ['402:panel-review/v1', BigInt(epochId), agentId],
    ),
  );
}

interface ReceiptChunk {
  epochId: number;
  batchHash: string;
  txHash: string;
  entries: { agentId: string; agreementBps: number }[];
}

async function main(): Promise<void> {
  const args = parseArgs();
  const writerArg = optional(args, 'writer', process.env.FOUR02_PANEL_WRITER ?? '');
  const dateArg = optional(args, 'date', '');
  const dbPath = optional(args, 'db', process.env.FOUR02_JOBS_DB_PATH ?? './jobs.db');
  const rpcUrl = optional(args, 'rpc', INK_RPC_URL);
  const bundleDir = optional(args, 'bundle-dir', process.env.FOUR02_PANEL_BUNDLE_DIR ?? './panel-bundles');
  const registryArg = optional(args, 'registry', process.env.FOUR02_REPUTATION_REGISTRY ?? '');
  const receiptArg = optional(args, 'submitted-bundle', '');
  const chunkSizeArg = optional(args, 'chunk-size', String(MAX_BATCH));

  if (!writerArg) {
    console.error('REFUSING: set --writer or FOUR02_PANEL_WRITER (PanelBatchWriter address).');
    process.exit(1);
  }
  const writerAddress = getAddress(writerArg);
  if (!registryArg.trim()) {
    console.error('REFUSING: set --registry or FOUR02_REPUTATION_REGISTRY (expected registry).');
    process.exit(1);
  }
  let expectedRegistry: `0x${string}`;
  try {
    expectedRegistry = getAddress(registryArg.trim());
  } catch {
    console.error(`REFUSING: --registry / FOUR02_REPUTATION_REGISTRY is not an address: ${registryArg}`);
    process.exit(1);
  }

  const day = dateArg ? Number(dateArg) : epochDayFor(new Date());
  try {
    parseYmd(day); // strict; no ±2d freshness window — we read history, not submit
  } catch (e) {
    console.error(`REFUSING: ${(e as Error).message}`);
    process.exit(1);
  }

  const db = new JobsDb(dbPath);
  const publicClient = createPublicClient({ chain: ink, transport: http(rpcUrl) });

  // The writer must point at the registry we intend to verify.
  const writerRegistry = getAddress(
    (await publicClient.readContract({
      address: writerAddress,
      abi: verifyWriterAbi,
      functionName: 'REGISTRY',
    })) as `0x${string}`,
  );
  if (writerRegistry !== expectedRegistry) {
    console.error(
      `REFUSING: writer ${writerAddress} points at ${writerRegistry}, expected ${expectedRegistry}.`,
    );
    process.exit(1);
  }
  const allowlisted = await publicClient.readContract({
    address: expectedRegistry,
    abi: verifyRegistryAbi,
    functionName: 'isWriter',
    args: [writerAddress],
  });
  if (!allowlisted) {
    console.error(
      `REFUSING: writer ${writerAddress} is not allowlisted on registry ${expectedRegistry}.`,
    );
    process.exit(1);
  }

  // Independent recomputation from reviewer_stats (same functions as keeper).
  // --chunk-size must match the keeper run under verification; it only
  // matters in strict mode (with a receipt, the receipt's chunks are
  // authoritative for structure).
  const chunkSize = Number(chunkSizeArg);
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_BATCH) {
    console.error(`REFUSING: bad --chunk-size (want 1-${MAX_BATCH}): ${chunkSizeArg}`);
    process.exit(1);
  }
  const batch = buildBatch(db.listReviewerStats());
  const chunks = chunkBatch(batch, chunkSize);
  const planned: { epochId: number; entries: BatchEntry[]; hash: `0x${string}` }[] =
    chunks.flatMap((c, i) => {
      if (c.length === 0) return [];
      const epochId = epochIdFor(day, i);
      return [{ epochId, entries: c, hash: computeBatchHash(epochId, c) }];
    });

  const divergences: string[] = [];
  const diverge = (msg: string) => {
    divergences.push(msg);
    console.error(`DIVERGENCE: ${msg}`);
  };

  // Submitted receipt (the keeper's M4 record of what actually landed).
  // Without it, strict mode: onchain must equal the plan exactly.
  const receiptPath = receiptArg || join(bundleDir, `panel-batch-${day}.submitted.json`);
  let receipt: ReceiptChunk[] | null = null;
  if (existsSync(receiptPath)) {
    try {
      const parsed = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
        format?: string;
        chunks?: ReceiptChunk[];
      };
      if (parsed.format !== '402:panel-batch-submitted/v1' || !Array.isArray(parsed.chunks)) {
        diverge(`receipt ${receiptPath} has unexpected format (not 402:panel-batch-submitted/v1)`);
      } else {
        receipt = parsed.chunks;
        console.error(`receipt: ${receiptPath} (${receipt.length} chunk(s))`);
      }
    } catch (e) {
      diverge(`cannot parse receipt ${receiptPath}: ${(e as Error).message}`);
    }
  } else {
    console.error(`no submitted receipt at ${receiptPath} — strict mode (onchain must equal plan)`);
  }

  // The source of truth for "what should be onchain".
  let expected: { epochId: number; entries: BatchEntry[]; hash: `0x${string}` }[];
  if (receipt) {
    // Verify the receipt itself: hashes recompute, entries union to the plan.
    const receiptEntries = new Map<string, { bps: number; epochIds: number[] }>();
    for (const rc of receipt) {
      const entries: BatchEntry[] = rc.entries.map((e) => ({
        agentId: BigInt(e.agentId),
        agreementBps: e.agreementBps,
      }));
      const recomputed = computeBatchHash(rc.epochId, entries);
      if (recomputed.toLowerCase() !== rc.batchHash.toLowerCase()) {
        diverge(
          `receipt chunk epoch ${rc.epochId}: batchHash ${rc.batchHash} does not recompute ` +
            `(got ${recomputed}) — the receipt itself is dishonest or corrupt`,
        );
      }
      for (const e of entries) {
        const k = e.agentId.toString();
        const prev = receiptEntries.get(k);
        if (prev && prev.bps !== e.agreementBps) {
          diverge(
            `receipt lists agent ${k} with conflicting bps (${prev.bps} vs ${e.agreementBps}) across chunks`,
          );
        }
        if (prev) prev.epochIds.push(rc.epochId);
        else receiptEntries.set(k, { bps: e.agreementBps, epochIds: [rc.epochId] });
      }
    }
    const plannedMap = new Map(batch.map((e) => [e.agentId.toString(), e.agreementBps]));
    for (const [agentId, bps] of plannedMap) {
      const r = receiptEntries.get(agentId);
      if (!r) diverge(`agent ${agentId} is in the DB-derived plan but in no receipt chunk`);
      else if (r.bps !== bps)
        diverge(`agent ${agentId}: receipt bps ${r.bps} != DB-derived ${bps}`);
    }
    for (const agentId of receiptEntries.keys()) {
      if (!plannedMap.has(agentId))
        diverge(`agent ${agentId} is in a receipt chunk but NOT in the DB-derived plan (fabricated entry)`);
    }
    expected = receipt.map((rc) => ({
      epochId: rc.epochId,
      entries: rc.entries.map((e) => ({
        agentId: BigInt(e.agentId),
        agreementBps: e.agreementBps,
      })),
      hash: rc.batchHash as `0x${string}`,
    }));
  } else {
    expected = planned;
  }

  // Probe onchain chunk indices contiguously from 0 (the keeper always uses
  // contiguous indices: planned 0..n-1, then fresh indices for halving
  // splits). Stop at the first gap.
  const onchain: { epochId: number; count: bigint; hash: `0x${string}` }[] = [];
  for (let i = 0; ; i++) {
    const epochId = epochIdFor(day, i);
    const logs = await publicClient.getLogs({
      address: writerAddress,
      event: verifyWriterAbi[0],
      args: { epochId: BigInt(epochId) },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    if (logs.length === 0) break;
    if (logs.length > 1)
      diverge(`epoch ${epochId}: ${logs.length} BatchSubmitted events (replay guard should make this impossible)`);
    const l = logs[0];
    onchain.push({
      epochId,
      count: (l.args.count as bigint) ?? 0n,
      hash: l.args.batchHash as `0x${string}`,
    });
    if (i > 10_000) {
      console.error('REFUSING: absurd chunk count, aborting probe');
      process.exit(1);
    }
  }
  console.error(`onchain: ${onchain.length} BatchSubmitted chunk(s) for day ${day}`);

  const onchainByEpoch = new Map(onchain.map((o) => [o.epochId, o]));
  const expectedEpochs = new Set(expected.map((e) => e.epochId));

  for (const exp of expected) {
    const o = onchainByEpoch.get(exp.epochId);
    if (!o) {
      diverge(`missing chunk: no onchain BatchSubmitted for epoch ${exp.epochId} (${exp.entries.length} agents expected)`);
      continue;
    }
    if (o.hash.toLowerCase() !== exp.hash.toLowerCase())
      diverge(`hash mismatch: epoch ${exp.epochId} onchain ${o.hash} != expected ${exp.hash}`);
    if (o.count !== BigInt(exp.entries.length))
      diverge(`count mismatch: epoch ${exp.epochId} onchain count ${o.count} != expected ${exp.entries.length}`);
  }
  for (const o of onchain) {
    if (!expectedEpochs.has(o.epochId))
      diverge(`unexpected chunk: onchain BatchSubmitted for epoch ${o.epochId} is in no receipt/plan (outside-keeper write?)`);
  }

  // Per-agent sweep: every expected (agent, epoch) must have a matching
  // panel event onchain with the expected bps, identified by refId.
  for (const exp of expected) {
    const o = onchainByEpoch.get(exp.epochId);
    if (!o) continue; // already diverged as missing chunk
    for (const e of exp.entries) {
      const wantRef = expectedPanelRefId(exp.epochId, e.agentId);
      const n = await publicClient.readContract({
        address: expectedRegistry,
        abi: verifyRegistryAbi,
        functionName: 'getLastIndex',
        args: [e.agentId, writerAddress],
      });
      let found = false;
      for (let j = 0n; j < n; j++) {
        const ev = await publicClient.readContract({
          address: expectedRegistry,
          abi: verifyRegistryAbi,
          functionName: 'events',
          args: [e.agentId, j],
        });
        const [eventType, value, , refId, evWriter] = ev;
        if (evWriter.toLowerCase() !== writerAddress.toLowerCase()) continue;
        if ((refId as string).toLowerCase() !== wantRef.toLowerCase()) continue;
        found = true;
        if (Number(eventType) !== ESCROW_COMPLETED)
          diverge(`agent ${e.agentId} epoch ${exp.epochId}: panel event has type ${eventType}, expected EscrowCompleted(3)`);
        if (value !== BigInt(e.agreementBps))
          diverge(`wrong bps: agent ${e.agentId} epoch ${exp.epochId} onchain value ${value} != expected ${e.agreementBps}`);
        break;
      }
      if (!found)
        diverge(`missing panel event: agent ${e.agentId} has no writer-attributed event with refId for epoch ${exp.epochId}`);
    }
  }

  console.error('---');
  if (divergences.length > 0) {
    console.error(`VERIFY FAILED: ${divergences.length} divergence(s) for day ${day}`);
    process.exit(1);
  }
  console.error(
    `VERIFY CLEAN: day ${day}, ${expected.length} chunk(s), ${expected.reduce((a, e) => a + e.entries.length, 0)} agent(s) — onchain matches the DB-derived plan`,
  );
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[panel-verify] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
