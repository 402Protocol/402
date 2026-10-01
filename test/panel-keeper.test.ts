/**
 * 402 verification flywheel — panel keeper unit tests.
 *
 *   npx tsx test/panel-keeper.test.ts
 *
 * Pure aggregation logic: epoch encoding, agreement-bps math, batch
 * building/chunking, and the epoch-submission bookkeeping on a throwaway
 * in-memory JobsDb. No network, no keys, no broadcasts.
 */
import assert from 'node:assert/strict';
import { encodeErrorResult, parseAbi } from 'viem';
import { JobsDb, type ReviewerStats } from '../src/jobs/db.js';
import {
  MAX_BATCH,
  buildBatch,
  chunkBatch,
  classifyChunk,
  computeAgreementBps,
  computeBatchHash,
  daysBetweenYmd,
  daysInMonth,
  decodeRevertName,
  epochDayFor,
  epochIdFor,
  parseYmd,
  validateEpochDay,
} from '../src/jobs/panel-keeper.js';
import { expectedPanelRefId } from '../src/jobs/panel-verify.js';

function stats(partial: Partial<ReviewerStats> & { reviewerAgentId: string }): ReviewerStats {
  return {
    reviewsDone: 0,
    agreedWithQuorum: 0,
    outlierVotes: 0,
    noShows: 0,
    cooldownUntil: 0,
    ...partial,
  };
}

// ---- epoch encoding ----

assert.equal(epochDayFor(new Date(Date.UTC(2026, 8, 29, 23, 59))), 20260929);
assert.equal(epochDayFor(new Date(Date.UTC(2026, 0, 1))), 20260101);
assert.equal(epochIdFor(20260929, 0), 20260929000);
assert.equal(epochIdFor(20260929, 3), 20260929003);
assert.throws(() => epochIdFor(20260929, 1000), /bad chunk index/);
assert.throws(() => epochIdFor(20260929, -1), /bad chunk index/);
assert.throws(() => epochIdFor(0, 0), /bad epoch day/);
console.log('ok - epoch encoding');

// ---- agreement bps math ----

assert.equal(computeAgreementBps(stats({ reviewerAgentId: '1' })), null, 'no reviews -> null');
assert.equal(
  computeAgreementBps(stats({ reviewerAgentId: '1', reviewsDone: 10, agreedWithQuorum: 9 })),
  9000,
);
assert.equal(
  computeAgreementBps(stats({ reviewerAgentId: '1', reviewsDone: 3, agreedWithQuorum: 2 })),
  6666,
  'floors, never rounds up',
);
assert.equal(
  computeAgreementBps(stats({ reviewerAgentId: '1', reviewsDone: 5, agreedWithQuorum: 5 })),
  10000,
);
assert.equal(
  computeAgreementBps(stats({ reviewerAgentId: '1', reviewsDone: 4, agreedWithQuorum: 0 })),
  0,
);
assert.equal(
  computeAgreementBps(stats({ reviewerAgentId: '1', reviewsDone: 2, agreedWithQuorum: 99 })),
  10000,
  'clamped at 10000 even if the DB lies',
);
assert.equal(
  computeAgreementBps(stats({ reviewerAgentId: '1', reviewsDone: 2, agreedWithQuorum: -1 })),
  null,
  'negative agreement -> null',
);
console.log('ok - agreement bps math');

// ---- batch building ----

const batch = buildBatch([
  stats({ reviewerAgentId: '9', reviewsDone: 4, agreedWithQuorum: 3 }), // 7500
  stats({ reviewerAgentId: '3' }), // no reviews -> dropped
  stats({ reviewerAgentId: '7', reviewsDone: 1, agreedWithQuorum: 1 }), // 10000
  stats({ reviewerAgentId: '0', reviewsDone: 5, agreedWithQuorum: 5 }), // zero id -> dropped
  stats({ reviewerAgentId: 'not-a-number', reviewsDone: 5, agreedWithQuorum: 5 }), // dropped
]);
assert.equal(batch.length, 2);
assert.equal(batch[0].agentId, 7n, 'sorted by numeric agent id');
assert.equal(batch[0].agreementBps, 10000);
assert.equal(batch[1].agentId, 9n);
assert.equal(batch[1].agreementBps, 7500);
assert.deepEqual(buildBatch([]), []);
// L7: duplicate agent ids collapse to one entry (first wins) — without
// this the whole batch would revert onchain with AgentIdsNotSorted.
const duped = buildBatch([
  stats({ reviewerAgentId: '7', reviewsDone: 2, agreedWithQuorum: 2 }), // 10000
  stats({ reviewerAgentId: '7', reviewsDone: 4, agreedWithQuorum: 1 }), // 2500 — dropped
  stats({ reviewerAgentId: '8', reviewsDone: 1, agreedWithQuorum: 1 }), // 10000
]);
assert.equal(duped.length, 2);
assert.equal(duped[0].agentId, 7n);
assert.equal(duped[0].agreementBps, 10000, 'first duplicate wins');
assert.equal(duped[1].agentId, 8n);
console.log('ok - batch building');

// ---- chunking ----

assert.equal(MAX_BATCH, 70, 'contract-measured cap: 70 x ~290k gas ≈ 20.3M < 30M Ink block limit');
const big = buildBatch(
  Array.from({ length: 450 }, (_, i) =>
    stats({ reviewerAgentId: String(i + 1), reviewsDone: 2, agreedWithQuorum: 2 }),
  ),
);
const chunks = chunkBatch(big);
assert.equal(chunks.length, 7);
assert.equal(chunks[0].length, 70);
assert.equal(chunks[5].length, 70);
assert.equal(chunks[6].length, 30);
assert.equal(chunkBatch([], 70).length, 0);
assert.equal(chunkBatch(big.slice(0, 70)).length, 1);
assert.equal(chunkBatch(big, 25).length, 18, 'configurable chunk size');
assert.throws(() => chunkBatch(big, 0), /bad chunk size/);
assert.throws(() => chunkBatch(big, 71), /bad chunk size/, 'cannot exceed the contract cap');
// chunk epoch ids are unique across the day
const ids = chunks.map((_, c) => epochIdFor(20260929, c));
assert.equal(new Set(ids).size, 7);
console.log('ok - chunking');

// ---- epoch-day validation (±2 days, month-boundary safe) ----

assert.equal(daysBetweenYmd(20260929, 20260929), 0);
assert.equal(daysBetweenYmd(20260930, 20260929), 1);
assert.equal(daysBetweenYmd(20261001, 20260929), 2, 'YYYYMMDD arithmetic would say 72 — must be 2');
assert.equal(daysBetweenYmd(20260927, 20260929), -2);
assert.equal(daysBetweenYmd(20260101, 20251231), 1, 'year boundary');
validateEpochDay(20260929, 20260929);
validateEpochDay(20260927, 20260929);
validateEpochDay(20261001, 20260929);
assert.throws(() => validateEpochDay(20260926, 20260929), /within ±2 days/, '-3d rejected');
assert.throws(() => validateEpochDay(20261002, 20260929), /within ±2 days/, '+3d rejected');
assert.throws(() => validateEpochDay(20261345, 20260929), /bad YYYYMMDD/);
console.log('ok - epoch-day validation');

// ---- strict YYYYMMDD parsing (L6) ----

assert.deepEqual(parseYmd(20260929), [2026, 9, 29]);
assert.deepEqual(parseYmd(20240229), [2024, 2, 29], 'leap day ok');
assert.throws(() => parseYmd(20260230), /has 28 days/, 'Feb 30 rejected');
assert.throws(() => parseYmd(20230229), /has 28 days/, 'Feb 29 on non-leap rejected');
assert.throws(() => parseYmd(20260431), /has 30 days/, 'Apr 31 rejected');
assert.throws(() => parseYmd(20261301), /bad YYYYMMDD/, 'month 13 rejected');
assert.throws(() => parseYmd(20260001), /bad YYYYMMDD/, 'month 0 rejected');
assert.equal(daysInMonth(2024, 2), 29);
assert.equal(daysInMonth(2023, 2), 28);
assert.equal(daysInMonth(2000, 2), 29, 'century leap');
assert.equal(daysInMonth(1900, 2), 28, 'century non-leap');
assert.equal(daysInMonth(2026, 4), 30);
assert.equal(daysInMonth(2026, 1), 31);
console.log('ok - strict date parsing');

// ---- deterministic revert classification (M1) ----

const revertAbi = parseAbi(['error EpochAlreadySubmitted()', 'error BatchHashMismatch()']);
// viem nests revert data: ContractFunctionExecutionError -> cause -> { data }
assert.equal(
  decodeRevertName({
    cause: { data: encodeErrorResult({ abi: revertAbi, errorName: 'EpochAlreadySubmitted' }) },
  }),
  'EpochAlreadySubmitted',
  'decodes a writer custom error from the viem chain',
);
assert.equal(
  decodeRevertName({ data: { errorName: 'EpochOutOfWindow' } }),
  'EpochOutOfWindow',
  'handles viem pre-decoded shape',
);
assert.equal(
  decodeRevertName(new Error('connect ECONNRESET')),
  null,
  'transport failure has no revert -> halve path',
);
assert.equal(decodeRevertName(null), null);
assert.equal(decodeRevertName({ cause: { data: '0x12345678' } }), null, 'undecodable data -> halve path');
console.log('ok - revert classification');

// ---- chunk disposition: the alarm path ----

assert.equal(classifyChunk(false, false), 'submit');
assert.equal(classifyChunk(false, true), 'submit', 'local mark without onchain write -> resubmit');
assert.equal(classifyChunk(true, true), 'skip');
assert.equal(
  classifyChunk(true, false),
  'alarm',
  'onchain but not local: NEVER a silent skip — page a human',
);
console.log('ok - chunk disposition');

// ---- batchHash commitment (epoch-bound) ----

const h1 = computeBatchHash(20260929000, [
  { agentId: 7n, agreementBps: 8000 },
  { agentId: 9n, agreementBps: 10000 },
]);
const h1again = computeBatchHash(20260929000, [
  { agentId: 7n, agreementBps: 8000 },
  { agentId: 9n, agreementBps: 10000 },
]);
assert.equal(h1, h1again, 'deterministic');
assert.match(h1, /^0x[0-9a-f]{64}$/, '32-byte hash');
const h2 = computeBatchHash(20260929000, [{ agentId: 7n, agreementBps: 8001 }]);
assert.notEqual(h1, h2, 'sensitive to contents');
const h3 = computeBatchHash(20260929001, [
  { agentId: 7n, agreementBps: 8000 },
  { agentId: 9n, agreementBps: 10000 },
]);
assert.notEqual(h1, h3, 'sensitive to epochId — no cross-epoch replay');
// Pinned value: keccak256(abi.encode(20260929000, uint256[](7,9), uint256[](8000,10000))).
// The forge BatchHashMismatch test covers the Solidity side of the same
// encoding; this pins the TS side so a future encoding change breaks loudly.
assert.equal(
  h1,
  '0x0811edb1ae1335c298f30f75f5125f9f22db92cba568a2a0f6918f3c21ca01da',
  'must match keccak256(abi.encode(epochId, ids, bps)) or the contract rejects the batch',
);
console.log('ok - batchHash commitment');

// ---- panel refId (verify mode) ----

// Pinned against the contract's encoding (forge ScratchPin):
// keccak256(abi.encodePacked("402:panel-review/v1", 20260929000, 42)).
assert.equal(
  expectedPanelRefId(20260929000, 42n),
  '0x3000bd9ca38e569f67f3485e008fa3922ed7cc0050e28f04ea4111e19d63ab06',
  'verify refId must match the contract or the per-agent sweep misses',
);
assert.notEqual(
  expectedPanelRefId(20260929000, 42n),
  expectedPanelRefId(20260929001, 42n),
  'refId binds the epoch',
);
console.log('ok - panel refId');

// ---- epoch submission bookkeeping (in-memory DB) ----

const db = new JobsDb(':memory:');
assert.deepEqual(db.listReviewerStats(), []);
assert.equal(db.isEpochSubmitted(20260929000), false);
db.markEpochSubmitted(20260929000, '0xabc');
assert.equal(db.isEpochSubmitted(20260929000), true);
assert.equal(db.isEpochSubmitted(20260929001), false);
db.markEpochSubmitted(20260929000, '0xdef'); // idempotent, first write wins
assert.equal(db.isEpochSubmitted(20260929000), true);
console.log('ok - epoch submission bookkeeping');

console.log('\nAll panel-keeper tests passed.');
