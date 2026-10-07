/**
 * 402 Phase 2 — durable settlement store tests (fix #3).
 *
 *   npx tsx test/settlement-store.test.ts
 *
 * Covers the SettlementStore contract for both implementations:
 *  - restart durability (SQLite file shared across close/reopen),
 *  - authorization identity keying (chain + token + payer + nonce),
 *  - cross-instance visibility (two stores on one file),
 *  - in-flight mutual exclusion across instances + stale-claim takeover,
 *  - in-memory NonceStore parity.
 *
 * No chain access, no broadcasts — pure store behavior.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonceStore } from '../src/facilitator/nonces.js';
import {
  INFLIGHT_CLAIM_TTL_SEC,
  SqliteSettlementStore,
  type SettlementIdentity,
  type SettlementStore,
} from '../src/facilitator/settlement-store.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const tmpDirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'settle-store-test-'));
  tmpDirs.push(dir);
  return join(dir, 'settlements.db');
}

const TOKEN_A = '0x2d270e6886d130d724215a266106e6832161eaed' as `0x${string}`;
const TOKEN_B = '0x0000000000000000000000000000000000000001' as `0x${string}`;
const PAYER_A = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const PAYER_B = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const NONCE_A =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const NONCE_B =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const HASH_A =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;

function id(over: Partial<SettlementIdentity> = {}): SettlementIdentity {
  return { chainId: 57073, token: TOKEN_A, payer: PAYER_A, nonce: NONCE_A, ...over };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- restart durability ----------

await check('#3: SQLite store survives restarts (nonces + broadcasts)', async () => {
  const path = tmpDb();
  const future = nowSec() + 3600;
  {
    const s = new SqliteSettlementStore(path);
    s.mark(id(), future);
    s.setBroadcast(id(), HASH_A);
    s.close();
  }
  {
    // A "restarted" process opens the same file.
    const s = new SqliteSettlementStore(path);
    assert.equal(s.has(id(), nowSec()), true, 'nonce forgotten across restart');
    assert.equal(s.getBroadcast(id()), HASH_A, 'broadcast hash forgotten across restart');
    s.close();
  }
});

await check('#3: expired nonces stay expired across restarts', async () => {
  const path = tmpDb();
  {
    const s = new SqliteSettlementStore(path);
    s.mark(id(), nowSec() - 10);
    s.close();
  }
  const s = new SqliteSettlementStore(path);
  assert.equal(s.has(id(), nowSec()), false, 'expired nonce resurrected');
  s.close();
});

// ---------- identity keying ----------

await check('#3: authorizations are keyed by chain + token + payer + nonce', async () => {
  const s: SettlementStore = new SqliteSettlementStore(tmpDb());
  const future = nowSec() + 3600;
  s.mark(id(), future);
  assert.equal(s.has(id(), nowSec()), true, 'exact identity missed');
  assert.equal(s.has(id({ payer: PAYER_B }), nowSec()), false, 'payer not isolated');
  assert.equal(s.has(id({ token: TOKEN_B }), nowSec()), false, 'token not isolated');
  assert.equal(s.has(id({ chainId: 1 }), nowSec()), false, 'chain not isolated');
  assert.equal(s.has(id({ nonce: NONCE_B }), nowSec()), false, 'nonce not isolated');
  s.close();
});

await check('#3: keying is case-insensitive on addresses', async () => {
  const s: SettlementStore = new SqliteSettlementStore(tmpDb());
  s.mark(id(), nowSec() + 3600);
  const upper = id({ payer: PAYER_A.toUpperCase() as `0x${string}` });
  assert.equal(s.has(upper, nowSec()), true, 'checksummed payer missed');
  s.close();
});

await check('#3: broadcast entries are per-authorization', async () => {
  const s: SettlementStore = new SqliteSettlementStore(tmpDb());
  s.setBroadcast(id(), HASH_A);
  assert.equal(s.getBroadcast(id()), HASH_A);
  assert.equal(s.getBroadcast(id({ payer: PAYER_B })), undefined, 'broadcast leaked across payers');
  s.deleteBroadcast(id());
  assert.equal(s.getBroadcast(id()), undefined, 'delete did not clear');
  s.close();
});

// ---------- two instances ----------

await check('#3: two instances on one file share nonces and broadcasts', async () => {
  const path = tmpDb();
  const a = new SqliteSettlementStore(path);
  const b = new SqliteSettlementStore(path);
  a.mark(id(), nowSec() + 3600);
  assert.equal(b.has(id(), nowSec()), true, 'instance B missed instance A nonce');
  a.setBroadcast(id(), HASH_A);
  assert.equal(b.getBroadcast(id()), HASH_A, 'instance B missed instance A broadcast');
  a.close();
  b.close();
});

await check('#3: in-flight claim excludes a second instance until released', async () => {
  const path = tmpDb();
  const a = new SqliteSettlementStore(path);
  const b = new SqliteSettlementStore(path);
  const t = nowSec();
  const tokenA = a.tryClaimInFlight(id(), t);
  assert.ok(tokenA, 'first claim failed');
  assert.equal(b.tryClaimInFlight(id(), t), null, 'second instance claimed a live settlement');
  assert.equal(a.ownsClaim(id(), tokenA!), true);
  a.releaseInFlight(id(), tokenA!);
  const tokenB = b.tryClaimInFlight(id(), t);
  assert.ok(tokenB, 'claim not released');
  b.releaseInFlight(id(), tokenB!);
  a.close();
  b.close();
});

await check('#3: stale in-flight claims can be taken over (crash recovery)', async () => {
  const path = tmpDb();
  const a = new SqliteSettlementStore(path);
  const b = new SqliteSettlementStore(path);
  const t0 = nowSec();
  const tokenA = a.tryClaimInFlight(id(), t0);
  assert.ok(tokenA);
  // A "died" holding the claim; after the TTL, B takes it over.
  const tokenB = b.tryClaimInFlight(id(), t0 + INFLIGHT_CLAIM_TTL_SEC + 1);
  assert.ok(tokenB, 'stale claim not taken over');
  assert.notEqual(tokenA, tokenB, 'takeover must issue a new ownership token');
  // And A can no longer claim while B holds it fresh.
  assert.equal(a.tryClaimInFlight(id(), t0 + INFLIGHT_CLAIM_TTL_SEC + 1), null);
  b.releaseInFlight(id(), tokenB!);
  a.close();
  b.close();
});

await check('#3b: A releasing after B takes over does not delete B\'s claim', async () => {
  const path = tmpDb();
  const a = new SqliteSettlementStore(path);
  const b = new SqliteSettlementStore(path);
  const t0 = nowSec();
  const tokenA = a.tryClaimInFlight(id(), t0);
  assert.ok(tokenA, 'A should win the first claim');
  const tokenB = b.tryClaimInFlight(id(), t0 + INFLIGHT_CLAIM_TTL_SEC + 1);
  assert.ok(tokenB, 'B should take over the stale claim');
  // A's eventual cleanup runs with its stale token: must be a no-op.
  a.releaseInFlight(id(), tokenA!);
  assert.equal(b.ownsClaim(id(), tokenB!), true, "A's late release deleted B's claim");
  assert.equal(a.ownsClaim(id(), tokenA!), false);
  // B's own release still works.
  b.releaseInFlight(id(), tokenB!);
  assert.equal(b.ownsClaim(id(), tokenB!), false);
  a.close();
  b.close();
});

// ---------- in-memory parity ----------

await check('#3: NonceStore honors the same claim contract in-memory', async () => {
  const s: SettlementStore = new NonceStore();
  const t = nowSec();
  const tokenA = s.tryClaimInFlight(id(), t);
  assert.ok(tokenA);
  assert.equal(s.tryClaimInFlight(id(), t), null, 'duplicate claim allowed');
  assert.equal(s.ownsClaim(id(), tokenA!), true);
  assert.equal(s.ownsClaim(id(), '0xdead'), false);
  s.releaseInFlight(id(), tokenA!);
  const tokenB = s.tryClaimInFlight(id(), t);
  assert.ok(tokenB, 'release broken');
  // Stale takeover works in-memory too, with a fresh token.
  const tokenC = s.tryClaimInFlight(id(), t + INFLIGHT_CLAIM_TTL_SEC + 1);
  assert.ok(tokenC, 'stale in-memory claim not taken over');
  assert.notEqual(tokenB, tokenC);
  // Conditional release: wrong token is a no-op.
  s.releaseInFlight(id(), tokenB!);
  assert.equal(s.ownsClaim(id(), tokenC!), true, 'wrong-token release deleted the claim');
  s.releaseInFlight(id(), tokenC!);
  assert.equal(s.ownsClaim(id(), tokenC!), false);
  s.close();
});

await check('#3b: broadcast intent round-trips (both implementations)', async () => {
  for (const s of [new NonceStore(), new SqliteSettlementStore(tmpDb())] as SettlementStore[]) {
    assert.equal(s.hasBroadcastIntent(id()), false);
    s.setBroadcastIntent(id());
    assert.equal(s.hasBroadcastIntent(id()), true);
    // Intent is per-authorization.
    assert.equal(s.hasBroadcastIntent(id({ payer: PAYER_B })), false);
    s.deleteBroadcastIntent(id());
    assert.equal(s.hasBroadcastIntent(id()), false);
    s.close();
  }
});

await check('#3: NonceStore broadcast methods round-trip', async () => {
  const s: SettlementStore = new NonceStore();
  assert.equal(s.getBroadcast(id()), undefined);
  s.setBroadcast(id(), HASH_A);
  assert.equal(s.getBroadcast(id()), HASH_A);
  s.deleteBroadcast(id());
  assert.equal(s.getBroadcast(id()), undefined);
  s.close();
});

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} settlement-store tests passed${process.exitCode ? ' (with failures)' : ''}`);
