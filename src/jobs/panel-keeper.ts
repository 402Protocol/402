/**
 * panel-keeper — submits the daily reviewer-panel score batch onchain.
 *
 * Reads finalized `reviewer_stats` rows from the jobs DB, computes each
 * reviewer's lifetime quorum-agreement rate (basis points), and submits it
 * through the PanelBatchWriter contract into Four02ReputationRegistryV2.
 * The batch is a per-epoch snapshot, not a delta: "as of epoch E, reviewer
 * X has N reviews with Y bps agreement." Signed EIP-712 attestations in the
 * DB remain the audit trail; the chain holds the commitment.
 *
 * Every run writes a bundle file (JSON: epoch, per-chunk entries, batch
 * hashes) and logs its keccak256 prominently. Each chunk's batchHash is
 * ALSO committed onchain in BatchSubmitted — anyone can recompute
 * keccak256(abi.encode(epochId, agentIds, agreementBps)) and verify the
 * keeper's batch instead of trusting it. Binding the epochId means an
 * identical (agentIds, bps) payload cannot be replayed under a different
 * epochId. Pin the bundle files (IPFS/cold storage) so fabrication is
 * publicly attributable.
 *
 * Default is a dry run that prints the full batch and broadcasts nothing.
 * Add --broadcast to actually submit — the keeper key comes from
 * FOUR02_PANEL_KEEPER_KEY in env (never argv, never chat).
 *
 *   FOUR02_PANEL_KEEPER_KEY=0x... npx tsx src/jobs/panel-keeper.ts \
 *     --writer 0x... [--broadcast] [--date 20260929] [--chunk-size 70] \
 *     [--db ./jobs.db] [--rpc URL] [--bundle-dir ./panel-bundles] \
 *     [--registry 0x...]
 *
 * --registry (or FOUR02_REPUTATION_REGISTRY) pins the expected reputation
 * registry: the writer's immutable REGISTRY() is checked against it before
 * any preflight, and a mismatch refuses loudly. Without it, the allowlist
 * preflight still gates the broadcast path.
 *
 * After a broadcast run confirms, a second bundle file
 * (panel-batch-<day>.submitted.json) records what ACTUALLY landed onchain
 * (real epochIds + batchHashes + tx hashes) — simulation-failure halving
 * splits chunks under fresh chunk indices, so the submitted record can
 * differ from the pre-broadcast plan. The pre-broadcast bundle is the
 * commitment; the submitted bundle is the receipt.
 *
 * Honesty monitor: npx tsx src/jobs/panel-verify.ts --writer 0x...
 * independently recomputes the epoch's batches from reviewer_stats and
 * diffs them against the onchain BatchSubmitted events + registry state.
 * Run it before keeper output becomes load-bearing for dispatch ranking.
 *
 * epochId encoding (must match PanelBatchWriter.sol): YYYYMMDD * 1000 + chunkIndex.
 * The contract enforces the epoch day within ±2 days of block.timestamp,
 * and this script enforces the same window on --date.
 *
 * Exit codes: 0 ok · 1 refusal/fatal · 2 paging alarm (a chunk is submitted
 * onchain but not marked locally — investigate before it repeats).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { INK_RPC_URL, ink } from '../constants.js';
import { JobsDb, type ReviewerStats } from './db.js';
import { flag, keyFromEnv, optional, parseArgs } from '../cli/args.js';

/** Must match PanelBatchWriter.MAX_BATCH (measured: 70 x ~290k gas ≈ 20.3M < 30M Ink block limit). */
export const MAX_BATCH = 70;

const writerAbi = parseAbi([
  'function submitBatch(uint256 epochId, uint256[] agentIds, uint256[] agreementBps, bytes32 batchHash)',
  'function REGISTRY() external view returns (address)',
  'function keeper() external view returns (address)',
  'function epochSubmitted(uint256 epochId) external view returns (bool)',
  // Custom errors, for deterministic-revert classification in submitWithRetry:
  // a decoded revert is a keeper/operator bug, never a gas problem — refuse,
  // don't halve.
  'error NotKeeper()',
  'error InvalidEpochId()',
  'error EpochOutOfWindow()',
  'error EpochAlreadySubmitted()',
  'error BatchSizeInvalid()',
  'error LengthMismatch()',
  'error ZeroAgentId()',
  'error AgentIdsNotSorted()',
  'error ScoreOutOfRange()',
  'error BatchHashMismatch()',
]);
const registryAbi = parseAbi([
  'function isWriter(address) external view returns (bool)',
]);

export interface BatchEntry {
  agentId: bigint;
  agreementBps: number;
}

/** UTC day as YYYYMMDD, e.g. 20260929. */
export function epochDayFor(d: Date): number {
  return (
    d.getUTCFullYear() * 10000 +
    (d.getUTCMonth() + 1) * 100 +
    d.getUTCDate()
  );
}

/** epochId = YYYYMMDD * 1000 + chunkIndex (chunkIndex < 1000). */
export function epochIdFor(day: number, chunk: number): number {
  if (!Number.isInteger(day) || day <= 0) throw new Error(`bad epoch day: ${day}`);
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= 1000)
    throw new Error(`bad chunk index: ${chunk}`);
  return day * 1000 + chunk;
}

/** Days in a Gregorian month (proleptic) — mirrors the contract's _daysInMonth. */
export function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  return 31;
}

/** Parse YYYYMMDD into [y, m, d]; throws on malformed input (strict day-of-month: no Feb 30, no Apr 31, no Feb 29 off-leap). */
export function parseYmd(day: number): [number, number, number] {
  if (!Number.isInteger(day) || day < 20000101 || day > 21000101)
    throw new Error(`bad YYYYMMDD: ${day}`);
  const y = Math.floor(day / 10000);
  const m = Math.floor(day / 100) % 100;
  const d = day % 100;
  if (m < 1 || m > 12 || d < 1) throw new Error(`bad YYYYMMDD: ${day}`);
  const dim = daysInMonth(y, m);
  if (d > dim)
    throw new Error(`bad YYYYMMDD: ${day} (month ${m} of ${y} has ${dim} days)`);
  return [y, m, d];
}

/** Whole days from b to a (a - b), using UTC midnights. */
export function daysBetweenYmd(a: number, b: number): number {
  const [ya, ma, da] = parseYmd(a);
  const [yb, mb, db] = parseYmd(b);
  return Math.round(
    (Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86_400_000,
  );
}

/**
 * The contract only accepts epoch days within ±2 days of block.timestamp
 * (anti grief-squatting). Enforce the same window on --date so a typo'd or
 * stale date fails fast locally instead of burning a simulation.
 */
export function validateEpochDay(day: number, today: number = epochDayFor(new Date())): void {
  const diff = daysBetweenYmd(day, today);
  if (Math.abs(diff) > 2)
    throw new Error(`--date ${day} is ${diff}d from today (${today}); must be within ±2 days`);
}

/** keccak256(abi.encode(epochId, agentIds, agreementBps)) — must match the contract's commitment. */
export function computeBatchHash(epochId: number, entries: BatchEntry[]): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'uint256[]' }],
      [
        BigInt(epochId),
        entries.map((e) => e.agentId),
        entries.map((e) => BigInt(e.agreementBps)),
      ],
    ),
  );
}

/**
 * Best-effort decode of a viem simulation error into a custom-error name.
 * Walks the viem error chain (ContractFunctionExecutionError ->
 * ContractFunctionRevertedError -> ...) looking for revert data, and tries
 * the writer ABI on it. Returns the decoded error name, or null when the
 * failure carries no decodable revert (gas estimation / RPC transport) —
 * those are the only failures the halving retry may attempt to route
 * around. Any decoded revert is deterministic: halving cannot fix it.
 */
export function decodeRevertName(e: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [e];
  while (stack.length > 0) {
    const cur = stack.pop() as {
      data?: unknown;
      cause?: unknown;
      signature?: unknown;
    } | null;
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const data = cur.data as
      | { errorName?: unknown }
      | `0x${string}`
      | undefined;
    // viem sometimes pre-decodes when the call ABI is known.
    if (
      data &&
      typeof data === 'object' &&
      typeof data.errorName === 'string'
    ) {
      return data.errorName;
    }
    if (typeof data === 'string' && data.startsWith('0x')) {
      try {
        return decodeErrorResult({ abi: writerAbi, data }).errorName;
      } catch {
        // Not decodable with the writer ABI — keep walking the chain.
      }
    }
    if (cur.cause) {
      if (Array.isArray(cur.cause)) stack.push(...cur.cause);
      else stack.push(cur.cause);
    }
  }
  return null;
}

/**
 * Lifetime quorum-agreement rate in basis points (0-10000).
 * Returns null when the reviewer has no completed reviews (nothing to score).
 */
export function computeAgreementBps(stats: ReviewerStats): number | null {
  if (stats.reviewsDone <= 0) return null;
  if (stats.agreedWithQuorum < 0) return null;
  const bps = Math.floor((stats.agreedWithQuorum * 10_000) / stats.reviewsDone);
  return Math.min(10_000, Math.max(0, bps)); // clamp: never trust the DB blindly
}

/**
 * Build the deterministic batch: reviewers with >= 1 completed review,
 * sorted by numeric agentId (the contract requires strictly increasing ids).
 * Unparseable agent ids are dropped (they can never be recorded onchain —
 * ERC-8004 ids are uint256). Duplicate agent ids collapse to one entry
 * (first wins); without this, two rows for the same reviewer would revert
 * the whole batch onchain with AgentIdsNotSorted.
 */
export function buildBatch(all: ReviewerStats[]): BatchEntry[] {
  const out: BatchEntry[] = [];
  const seen = new Set<bigint>();
  for (const s of all) {
    const bps = computeAgreementBps(s);
    if (bps === null) continue;
    let agentId: bigint;
    try {
      agentId = BigInt(s.reviewerAgentId);
    } catch {
      continue;
    }
    if (agentId === 0n) continue; // registry reverts on zero agent ids
    if (seen.has(agentId)) continue; // collapse duplicates, keep first
    seen.add(agentId);
    out.push({ agentId, agreementBps: bps });
  }
  out.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return out;
}

/** Split a batch into contract-sized chunks (default MAX_BATCH each). */
export function chunkBatch(batch: BatchEntry[], size: number = MAX_BATCH): BatchEntry[][] {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BATCH)
    throw new Error(`bad chunk size: ${size} (want 1-${MAX_BATCH})`);
  const chunks: BatchEntry[][] = [];
  for (let i = 0; i < batch.length; i += size) chunks.push(batch.slice(i, i + size));
  return chunks;
}

export type ChunkDisposition = 'submit' | 'skip' | 'alarm';

/**
 * Decide a chunk's fate from the onchain replay guard vs the local ledger.
 * onchain && !local is a PAGING ALARM: something submitted this epoch
 * outside this keeper (or the local ledger lost a write) — a human must
 * look before it repeats. Never silently skip it.
 */
export function classifyChunk(
  onchainSubmitted: boolean,
  localSubmitted: boolean,
): ChunkDisposition {
  if (onchainSubmitted && !localSubmitted) return 'alarm';
  if (onchainSubmitted) return 'skip';
  return 'submit';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
const args = parseArgs();
const broadcast = flag(args, 'broadcast');
const dateArg = optional(args, 'date', '');
const dbPath = optional(args, 'db', process.env.FOUR02_JOBS_DB_PATH ?? './jobs.db');
const writerArg = optional(args, 'writer', process.env.FOUR02_PANEL_WRITER ?? '');
const rpcUrl = optional(args, 'rpc', INK_RPC_URL);
const registryArg = optional(args, 'registry', process.env.FOUR02_REPUTATION_REGISTRY ?? '');
const bundleDir = optional(args, 'bundle-dir', process.env.FOUR02_PANEL_BUNDLE_DIR ?? './panel-bundles');
const chunkSizeArg = optional(args, 'chunk-size', process.env.FOUR02_PANEL_CHUNK_SIZE ?? String(MAX_BATCH));

if (!writerArg) {
  console.error('REFUSING: set --writer or FOUR02_PANEL_WRITER (PanelBatchWriter address).');
  process.exit(1);
}
const writerAddress = getAddress(writerArg);

const chunkSize = Number(chunkSizeArg);
if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_BATCH) {
  console.error(`REFUSING: bad --chunk-size (want 1-${MAX_BATCH}): ${chunkSizeArg}`);
  process.exit(1);
}

const day = dateArg ? Number(dateArg) : epochDayFor(new Date());
try {
  validateEpochDay(day);
} catch (e) {
  console.error(`REFUSING: ${(e as Error).message}`);
  process.exit(1);
}

const db = new JobsDb(dbPath);
const batch = buildBatch(db.listReviewerStats());
const chunks = chunkBatch(batch, chunkSize);
const publicClient = createPublicClient({ chain: ink, transport: http(rpcUrl) });

// I1: pin the expected registry BEFORE any preflight. The writer's
// immutable REGISTRY() must match --registry / FOUR02_REPUTATION_REGISTRY —
// submitting into a writer pointed at the wrong registry would silently
// write the scores into the wrong reputation ledger.
const writerRegistry = (await publicClient.readContract({
  address: writerAddress,
  abi: writerAbi,
  functionName: 'REGISTRY',
})) as `0x${string}`;
const expectedRegistryRaw = registryArg.trim();
if (expectedRegistryRaw) {
  let expectedRegistry: `0x${string}`;
  try {
    expectedRegistry = getAddress(expectedRegistryRaw);
  } catch {
    console.error(
      `REFUSING: --registry / FOUR02_REPUTATION_REGISTRY is not an address: ${registryArg}`,
    );
    process.exit(1);
  }
  if (getAddress(writerRegistry) !== expectedRegistry) {
    console.error(
      `REFUSING: writer ${writerAddress} points at registry ${writerRegistry}, ` +
        `expected ${expectedRegistry} — refusing to submit into the wrong ledger.`,
    );
    process.exit(1);
  }
  console.error(`registry: ${expectedRegistry} (pinned, matches writer)`);
} else {
  console.error(
    `registry: ${writerRegistry} (unpinned — set --registry / FOUR02_REPUTATION_REGISTRY to pin it)`,
  );
}

// ---- bundle commitment: JSON file + prominent keccak256 ----
const bundle = {
  format: '402:panel-batch/v1',
  epochDay: day,
  chunkSize,
  writer: writerAddress,
  generatedAt: new Date().toISOString(),
  chunks: chunks.map((c, i) => ({
    epochId: epochIdFor(day, i),
    batchHash: computeBatchHash(epochIdFor(day, i), c),
    entries: c.map((e) => ({ agentId: e.agentId.toString(), agreementBps: e.agreementBps })),
  })),
};
const bundleJson = JSON.stringify(bundle, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
mkdirSync(bundleDir, { recursive: true });
const bundlePath = join(bundleDir, `panel-batch-${day}.json`);
writeFileSync(bundlePath, bundleJson);
const bundleHash = keccak256(toBytes(bundleJson));

console.error(`writer:   ${writerAddress}`);
console.error(`db:       ${dbPath}`);
console.error(`epoch:    ${day} (${chunks.length} chunk${chunks.length === 1 ? '' : 's'}, size ${chunkSize})`);
console.error(`reviewers in batch: ${batch.length}`);
for (const e of batch.slice(0, 10)) {
  console.error(`  agent ${e.agentId}: ${e.agreementBps} bps agreement`);
}
if (batch.length > 10) console.error(`  ... and ${batch.length - 10} more`);
console.error('=== BUNDLE COMMITMENT ===');
console.error(`bundle file: ${bundlePath}`);
console.error(`bundle hash: ${bundleHash}`);
console.error('Verify: recompute keccak256(abi.encode(epochId, agentIds, agreementBps)) per chunk');
console.error('and compare to the batchHash in the onchain BatchSubmitted event.');
console.error('=========================');

if (batch.length === 0) {
  console.error('Nothing to submit — no reviewers with completed reviews.');
  process.exit(0);
}

// Onchain preflight (read-only): classify each planned chunk.
const alarms: number[] = [];
const pending: { epochId: number; chunkIndex: number; chunk: BatchEntry[] }[] = [];
for (let c = 0; c < chunks.length; c++) {
  const epochId = epochIdFor(day, c);
  const submitted = await publicClient.readContract({
    address: writerAddress,
    abi: writerAbi,
    functionName: 'epochSubmitted',
    args: [BigInt(epochId)],
  });
  const local = db.isEpochSubmitted(epochId);
  const disposition = classifyChunk(submitted, local);
  if (disposition === 'alarm') {
    alarms.push(epochId);
    console.error(`!!! ALARM: epoch ${epochId} is submitted ONCHAIN but not in the local ledger.`);
    console.error('!!! Someone (or something) submitted this batch outside this keeper.');
    console.error('!!! A human must investigate — this chunk will NOT be retried silently.');
    continue;
  }
  if (disposition === 'skip') {
    console.error(`epoch ${epochId}: already submitted onchain — skipping`);
    continue;
  }
  if (local) {
    console.error(`epoch ${epochId}: marked submitted locally but NOT onchain — will resubmit`);
  }
  pending.push({ epochId, chunkIndex: c, chunk: chunks[c] });
}

if (pending.length === 0 && alarms.length === 0) {
  console.error('All chunks already submitted. Nothing to do.');
  process.exit(0);
}

if (!broadcast) {
  console.error('---');
  console.error('DRY RUN — nothing broadcast. Re-run with --broadcast to submit.');
  for (const p of pending) {
    console.error(`  would submit epoch ${p.epochId}: ${p.chunk.length} agents, batchHash ${computeBatchHash(p.epochId, p.chunk)}`);
  }
  if (alarms.length > 0) {
    console.error(`ALARM: ${alarms.length} chunk(s) need human investigation: ${alarms.join(', ')}`);
    process.exit(2);
  }
  process.exit(0);
}

// ---- broadcast path ----
const keeperKey = keyFromEnv('FOUR02_PANEL_KEEPER_KEY');
const account = privateKeyToAccount(keeperKey);
console.error(`keeper:   ${account.address}`);

// Safety: the writer must be allowlisted on the registry, or every
// recordCommerceEvent call reverts and we burn gas for nothing.
// (writerRegistry was read once up front for the I1 registry pin.)
const registry = writerRegistry;
const allowlisted = await publicClient.readContract({
  address: getAddress(registry),
  abi: registryAbi,
  functionName: 'isWriter',
  args: [writerAddress],
});
if (!allowlisted) {
  console.error(
    `REFUSING: writer ${writerAddress} is NOT allowlisted on registry ${registry} — have the owner call addWriter first.`,
  );
  process.exit(1);
}
const onchainKeeper = (await publicClient.readContract({
  address: writerAddress,
  abi: writerAbi,
  functionName: 'keeper',
})) as `0x${string}`;
if (getAddress(onchainKeeper) !== account.address) {
  console.error(
    `REFUSING: this key (${account.address}) is not the writer's keeper (${onchainKeeper}).`,
  );
  process.exit(1);
}

const eth = await publicClient.getBalance({ address: account.address });
if (eth < 500_000_000_000_000n) {
  console.error('WARN: keeper ETH looks low for gas — fund it with a dust of ETH.');
}

const wallet = createWalletClient({ account, chain: ink, transport: http(rpcUrl) });

// Fresh chunk indices for simulation-failure splits (never collide with
// planned indices; re-checked onchain before each attempt).
let nextChunkIndex = chunks.length;

// M4: what ACTUALLY landed onchain. Halving splits chunks under fresh
// chunk indices, so the submitted record can differ from the pre-broadcast
// bundle plan — this array is the receipt.
const submitted: {
  epochId: number;
  batchHash: `0x${string}`;
  txHash: `0x${string}`;
  entries: BatchEntry[];
}[] = [];

async function submitWithRetry(
  chunkDay: number,
  chunkIndex: number,
  entries: BatchEntry[],
): Promise<void> {
  const epochId = epochIdFor(chunkDay, chunkIndex);
  const onchain = await publicClient.readContract({
    address: writerAddress,
    abi: writerAbi,
    functionName: 'epochSubmitted',
    args: [BigInt(epochId)],
  });
  const disposition = classifyChunk(onchain, db.isEpochSubmitted(epochId));
  if (disposition === 'alarm') {
    alarms.push(epochId);
    console.error(`!!! ALARM: epoch ${epochId} submitted onchain outside this keeper — skipping, needs a human.`);
    return;
  }
  if (disposition === 'skip') {
    console.error(`epoch ${epochId}: already submitted — skipping`);
    return;
  }

  const agentIds = entries.map((e) => e.agentId);
  const bps = entries.map((e) => BigInt(e.agreementBps));
  const batchHash = computeBatchHash(epochId, entries);
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      account,
      address: writerAddress,
      abi: writerAbi,
      functionName: 'submitBatch',
      args: [BigInt(epochId), agentIds, bps, batchHash],
    }));
  } catch (e) {
    // M1: duplicate-submission race. A previous attempt (concurrent run,
    // retried cron) may have landed while we were simulating. Re-read the
    // replay guard for the ORIGINAL epochId first: if it is submitted now,
    // skip — never halve, never broadcast.
    const raced = await publicClient.readContract({
      address: writerAddress,
      abi: writerAbi,
      functionName: 'epochSubmitted',
      args: [BigInt(epochId)],
    });
    const raceDisp = classifyChunk(raced, db.isEpochSubmitted(epochId));
    if (raceDisp === 'alarm') {
      alarms.push(epochId);
      console.error(
        `!!! ALARM: epoch ${epochId} was submitted onchain during our simulation — outside this keeper. Skipping.`,
      );
      return;
    }
    if (raceDisp === 'skip') {
      console.error(`epoch ${epochId}: submitted while simulating — skipping`);
      return;
    }
    // A decoded contract revert is deterministic (bad input, stale epoch,
    // wrong keeper, hash mismatch): halving cannot fix it. Refuse loudly.
    const revertName = decodeRevertName(e);
    if (revertName !== null) {
      console.error(
        `REFUSING: submitBatch simulation reverted deterministically with ${revertName} ` +
          `for epoch ${epochId} — fix the input/config, do not rerun blindly.`,
      );
      process.exit(1);
    }
    if (entries.length <= 1) throw e;
    // Only non-revert failures (gas estimation over the block limit on a
    // congested RPC, transport errors) reach here: halve the chunk and
    // retry each half under fresh chunk indices. Recursion bottoms out at
    // single entries.
    console.error(
      `simulation failed for epoch ${epochId} (${entries.length} entries): ${(e as Error).message}`,
    );
    console.error('halving the chunk and retrying...');
    const half = Math.ceil(entries.length / 2);
    const i1 = nextChunkIndex++;
    const i2 = nextChunkIndex++;
    await submitWithRetry(chunkDay, i1, entries.slice(0, half));
    await submitWithRetry(chunkDay, i2, entries.slice(half));
    return;
  }
  const hash = await wallet.writeContract(request);
  console.error(`broadcast epoch ${epochId}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error(`REFUSING: tx ${hash} failed onchain — epoch ${epochId} NOT marked submitted.`);
    process.exit(1);
  }
  db.markEpochSubmitted(epochId, hash);
  submitted.push({ epochId, batchHash, txHash: hash, entries });
  console.error(`confirmed in block ${receipt.blockNumber}`);
}

for (const p of pending) {
  await submitWithRetry(day, p.chunkIndex, p.chunk);
}

// M4: the submitted receipt. The pre-broadcast bundle is the commitment;
// this file records reality (halving may have split chunks under fresh
// epochIds with different batchHashes). A bundle-drift monitor must treat
// a mismatch after a keeper-logged halving split as expected, not as
// "stop the cron".
if (submitted.length > 0) {
  const submittedBundle = {
    format: '402:panel-batch-submitted/v1',
    epochDay: day,
    writer: writerAddress,
    registry: writerRegistry,
    generatedAt: new Date().toISOString(),
    preBroadcastBundleHash: bundleHash,
    chunks: submitted.map((s) => ({
      epochId: s.epochId,
      batchHash: s.batchHash,
      txHash: s.txHash,
      entries: s.entries.map((e) => ({
        agentId: e.agentId.toString(),
        agreementBps: e.agreementBps,
      })),
    })),
  };
  const submittedJson = JSON.stringify(
    submittedBundle,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  const submittedPath = join(bundleDir, `panel-batch-${day}.submitted.json`);
  writeFileSync(submittedPath, submittedJson);
  const submittedHash = keccak256(toBytes(submittedJson));
  console.error('=== SUBMITTED RECEIPT ===');
  console.error(`submitted file: ${submittedPath}`);
  console.error(`submitted hash: ${submittedHash}`);
  console.error('=========================');
}

if (alarms.length > 0) {
  console.error('===');
  console.error(`ALARM: ${alarms.length} chunk(s) submitted outside this keeper: ${alarms.join(', ')}`);
  console.error('Investigate before the next run. Exiting 2 for the pager.');
  process.exit(2);
}
console.error('done.');
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[panel-keeper] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
