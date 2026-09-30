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
import { JobsDb, type ReviewerStats } from '../src/jobs/db.js';
import {
  MAX_BATCH,
  buildBatch,
  chunkBatch,
  classifyChunk,
  computeAgreementBps,
  computeBatchHash,
  daysBetweenYmd,
  epochDayFor,
  epochIdFor,
  validateEpochDay,
} from '../src/jobs/panel-keeper.js';

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

// ---- batchHash commitment ----

const h1 = computeBatchHash([
  { agentId: 7n, agreementBps: 8000 },
  { agentId: 9n, agreementBps: 10000 },
]);
const h1again = computeBatchHash([
  { agentId: 7n, agreementBps: 8000 },
  { agentId: 9n, agreementBps: 10000 },
]);
assert.equal(h1, h1again, 'deterministic');
assert.match(h1, /^0x[0-9a-f]{64}$/, '32-byte hash');
const h2 = computeBatchHash([{ agentId: 7n, agreementBps: 8001 }]);
assert.notEqual(h1, h2, 'sensitive to contents');
// Pinned value: keccak256(abi.encode(uint256[](7,9), uint256[](8000,10000))).
// The forge BatchHashMismatch test covers the Solidity side of the same
// encoding; this pins the TS side so a future encoding change breaks loudly.
assert.equal(
  h1,
  '0xba02fb79c00e05ab3511be728de7c028e3aa8510ed894d2c98efa60e74b58f45',
  'must match keccak256(abi.encode(ids, bps)) or the contract rejects the batch',
);
console.log('ok - batchHash commitment');

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
