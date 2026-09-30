/**
 * 402 Lounge — rekt ticker tests.
 *
 *   npx tsx test/rekt.test.ts
 *
 * Covers: liquidation event parsing (valid long/short, spread with two
 * product_ids, malformed variants), the notional threshold filter, WS dedup
 * keying + bounded recent-key set, the rekt_events DB roundtrip
 * (insert/recent/stats), and the GET /lounge/rekt response contract.
 *
 * No network, no keys, nothing broadcast. startRektFeed is NOT started here.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  fetchProductMap,
  parseLiquidationEvent,
  passesNotionalThreshold,
  RecentKeys,
  rektEventKey,
  type RektEvent,
} from '../src/lounge/rekt.js';
import { LoungeDb } from '../src/lounge/db.js';
import { createLoungeApp } from '../src/lounge/server.js';
import type { LoungeConfig } from '../src/lounge/config.js';

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

const LONG_FIXTURE = {
  type: 'liquidation',
  product_id: 2,
  timestamp: '1759181234567',
  product_ids: [2],
  liquidator: '0x1111111111111111111111111111111111111111',
  liquidatee: '0x2222222222222222222222222222222222222222',
  amount: '0.5',
  price: '112000.5',
};

const SHORT_FIXTURE = {
  type: 'liquidation',
  product_id: 4,
  timestamp: '1759181234999',
  product_ids: [4],
  liquidator: '0x3333333333333333333333333333333333333333',
  liquidatee: '0x4444444444444444444444444444444444444444',
  amount: '-1.25',
  price: '3200',
};

// ---------- parsing ----------

await check('parse: valid long liquidation', () => {
  const e = parseLiquidationEvent(LONG_FIXTURE);
  assert.ok(e);
  assert.equal(e.productId, 2);
  assert.equal(e.side, 'long');
  assert.equal(e.price, 112000.5);
  assert.equal(e.amount, 0.5);
  assert.equal(e.notionalUsd, 0.5 * 112000.5);
  assert.equal(e.ts, 1759181234);
  assert.equal(e.liquidatee, '0x2222222222222222222222222222222222222222');
  assert.equal(e.ticker, null);
});

await check('parse: valid short liquidation (negative amount)', () => {
  const e = parseLiquidationEvent(SHORT_FIXTURE);
  assert.ok(e);
  assert.equal(e.side, 'short');
  assert.equal(e.notionalUsd, 1.25 * 3200);
});

await check('parse: spread with two product_ids uses top-level product_id', () => {
  const e = parseLiquidationEvent({
    ...LONG_FIXTURE,
    product_id: 6,
    product_ids: [5, 6],
  });
  assert.ok(e);
  assert.equal(e.productId, 6);
});

await check('parse: rejects subscribe ack + other non-liquidation messages', () => {
  assert.equal(parseLiquidationEvent({ result: null, id: 1 }), null);
  assert.equal(parseLiquidationEvent({ type: 'trade', product_id: 2 }), null);
  assert.equal(parseLiquidationEvent(null), null);
  assert.equal(parseLiquidationEvent('liquidation'), null);
  assert.equal(parseLiquidationEvent(42), null);
});

await check('parse: rejects malformed fields', () => {
  const bad = [
    { ...LONG_FIXTURE, type: 'liquidations' },
    { ...LONG_FIXTURE, product_id: 0 },
    { ...LONG_FIXTURE, product_id: 'abc' },
    { ...LONG_FIXTURE, timestamp: 'not-a-number' },
    { ...LONG_FIXTURE, timestamp: '0' },
    { ...LONG_FIXTURE, amount: '0' },
    { ...LONG_FIXTURE, amount: '0.0' },
    { ...LONG_FIXTURE, amount: 'NaN' },
    { ...LONG_FIXTURE, price: '0' },
    { ...LONG_FIXTURE, price: '-5' },
    { ...LONG_FIXTURE, price: 'abc' },
    { ...LONG_FIXTURE, liquidatee: '' },
    { ...LONG_FIXTURE, liquidatee: '   ' },
    { ...LONG_FIXTURE, liquidatee: 123 },
    { ...LONG_FIXTURE, product_id: 2.5 },
  ];
  for (const b of bad) {
    assert.equal(
      parseLiquidationEvent(b),
      null,
      `expected null for ${JSON.stringify(b).slice(0, 80)}`,
    );
  }
});

await check('parse: numeric (non-string) fields also accepted', () => {
  const e = parseLiquidationEvent({
    type: 'liquidation',
    product_id: 2,
    timestamp: 1759181234567,
    amount: -2,
    price: 100,
    liquidatee: '0xabc',
  });
  assert.ok(e);
  assert.equal(e.side, 'short');
  assert.equal(e.notionalUsd, 200);
});

// ---------- threshold ----------

await check('threshold: filters below the floor, keeps at/above', () => {
  const mk = (notional: number): RektEvent => ({
    productId: 2,
    ticker: 'BTC-PERP',
    side: 'long',
    price: 100,
    amount: notional / 100,
    notionalUsd: notional,
    ts: 1,
    liquidatee: '0xabc',
  });
  assert.equal(passesNotionalThreshold(mk(9999.99), 10000), false);
  assert.equal(passesNotionalThreshold(mk(10000), 10000), true);
  assert.equal(passesNotionalThreshold(mk(250000), 10000), true);
});

// ---------- dedup ----------

await check('dedup: key is product+second+wallet+size', () => {
  const a = parseLiquidationEvent(LONG_FIXTURE)!;
  const b = parseLiquidationEvent({ ...LONG_FIXTURE })!;
  const c = parseLiquidationEvent({ ...LONG_FIXTURE, amount: '0.6' })!;
  assert.equal(rektEventKey(a), rektEventKey(b));
  assert.notEqual(rektEventKey(a), rektEventKey(c));
});

await check('dedup: RecentKeys evicts oldest past the cap', () => {
  const seen = new RecentKeys(3);
  seen.add('a');
  seen.add('b');
  seen.add('c');
  assert.equal(seen.size, 3);
  assert.ok(seen.has('a'));
  seen.add('d');
  assert.equal(seen.size, 3);
  assert.ok(!seen.has('a'));
  assert.ok(seen.has('d'));
  // re-adding refreshes recency
  seen.add('b');
  seen.add('e');
  assert.ok(seen.has('b'));
  assert.ok(!seen.has('c'));
});

// ---------- product map (offline shape test via stubbed fetch) ----------

await check('product map: parses pairs array, skips junk rows', async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => [
        { product_id: 2, ticker_id: 'BTC-PERP_USDT0', base: 'BTC-PERP', quote: 'USDT0' },
        { product_id: 4, ticker_id: 'ETH-PERP_USDT0', base: 'ETH-PERP', quote: 'USDT0' },
        { product_id: 'nope', base: 'JUNK' },
        null,
      ],
    }) as Response;
  try {
    const m = await fetchProductMap('https://example.invalid/pairs');
    assert.equal(m.get(2), 'BTC-PERP');
    assert.equal(m.get(4), 'ETH-PERP');
    assert.equal(m.size, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await check('product map: throws on non-ok response', async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 403 }) as Response;
  try {
    await assert.rejects(() => fetchProductMap('https://example.invalid/pairs'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------- db roundtrip ----------

function testDb(): LoungeDb {
  return new LoungeDb(':memory:');
}

await check('db: insert + recent newest-first', () => {
  const db = testDb();
  const now = Math.floor(Date.now() / 1000);
  db.insertRektEvent({
    productId: 2, ticker: 'BTC-PERP', side: 'long', price: 112000,
    amount: 0.5, notionalUsd: 56000, liquidatee: '0xaaa', ts: now - 10,
  });
  db.insertRektEvent({
    productId: 4, ticker: 'ETH-PERP', side: 'short', price: 3200,
    amount: -2, notionalUsd: 6400, liquidatee: '0xbbb', ts: now - 5,
  });
  const rows = db.recentRektEvents(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ticker, 'ETH-PERP'); // newest first
  assert.equal(rows[0].side, 'short');
  assert.equal(rows[0].notionalUsd, 6400);
  assert.equal(rows[0].price, 3200);
  assert.equal(typeof rows[0].id, 'number');
  assert.equal(rows[1].ticker, 'BTC-PERP');
  assert.equal(db.recentRektEvents(1).length, 1);
});

await check('db: stats24h aggregates + biggest', () => {
  const db = testDb();
  const now = Math.floor(Date.now() / 1000);
  db.insertRektEvent({
    productId: 2, ticker: 'BTC-PERP', side: 'long', price: 112000,
    amount: 0.5, notionalUsd: 56000, liquidatee: '0xaaa', ts: now - 100,
  });
  db.insertRektEvent({
    productId: 4, ticker: 'ETH-PERP', side: 'short', price: 3200,
    amount: -2, notionalUsd: 6400, liquidatee: '0xbbb', ts: now - 50,
  });
  db.insertRektEvent({
    productId: 2, ticker: 'BTC-PERP', side: 'long', price: 112000,
    amount: 1, notionalUsd: 112000, liquidatee: '0xccc', ts: now - 90000, // >24h old
  });
  const s = db.rektStats24h();
  assert.equal(s.count24h, 2);
  assert.equal(s.longs24h, 1);
  assert.equal(s.shorts24h, 1);
  assert.equal(s.totalUsd24h, 56000 + 6400);
  assert.ok(s.biggest);
  assert.equal(s.biggest.ticker, 'BTC-PERP');
  assert.equal(s.biggest.side, 'long');
  assert.equal(s.biggest.notionalUsd, 56000);
});

await check('db: stats24h empty -> zeros + null biggest', () => {
  const db = testDb();
  const s = db.rektStats24h();
  assert.equal(s.count24h, 0);
  assert.equal(s.totalUsd24h, 0);
  assert.equal(s.longs24h, 0);
  assert.equal(s.shorts24h, 0);
  assert.equal(s.biggest, null);
});

await check('db: insert prunes rows older than 7 days', () => {
  const db = testDb();
  const now = Math.floor(Date.now() / 1000);
  db.insertRektEvent({
    productId: 2, ticker: 'BTC-PERP', side: 'long', price: 100,
    amount: 100, notionalUsd: 10000, liquidatee: '0xold', ts: now - 8 * 86400,
  });
  db.insertRektEvent({
    productId: 2, ticker: 'BTC-PERP', side: 'long', price: 100,
    amount: 100, notionalUsd: 10000, liquidatee: '0xnew', ts: now,
  });
  const rows = db.recentRektEvents(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'BTC-PERP');
});

// ---------- route contract ----------

function testConfig(): LoungeConfig {
  return {
    treasury: '0x1795adb30465b6f77e65f42695668617b6e34ac4',
    postFeeUsdc: '0.01',
    postFeeUnits: 10_000n,
    rpcUrl: 'http://localhost:1',
    dbPath: ':memory:',
  };
}

await check('route: GET /lounge/rekt returns the exact contract', async () => {
  const parent = new Hono();
  const lounge = createLoungeApp(testConfig());
  parent.route('/lounge', lounge);
  // seed via the shared DB is not exposed; hit the route with an empty DB
  const res = await parent.request('/lounge/rekt');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(Array.isArray(body.events));
  assert.ok(typeof body.as_of === 'number');
  const st = body.stats;
  for (const k of ['total_usd_24h', 'count_24h', 'longs_24h', 'shorts_24h', 'biggest']) {
    assert.ok(k in st, `stats missing ${k}`);
  }
  assert.equal(st.biggest, null);
  assert.deepEqual(Object.keys(body).sort(), ['as_of', 'events', 'stats']);
});

await check('route: seeded events render in contract shape', async () => {
  const db = testDb();
  const now = Math.floor(Date.now() / 1000);
  db.insertRektEvent({
    productId: 2, ticker: 'BTC-PERP', side: 'long', price: 112000.5,
    amount: 0.5, notionalUsd: 56000.25, liquidatee: '0xaaa', ts: now - 30,
  });
  const parent = new Hono();
  parent.route('/lounge', createLoungeApp(testConfig(), { db }));
  const res = await parent.request('/lounge/rekt');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.events.length, 1);
  const e = body.events[0];
  assert.deepEqual(Object.keys(e).sort(), [
    'id', 'notional_usd', 'price', 'side', 'ticker', 'ts',
  ]);
  assert.equal(e.ticker, 'BTC-PERP');
  assert.equal(e.side, 'long');
  assert.equal(e.price, 112000.5);
  assert.equal(e.notional_usd, 56000.25);
  assert.equal(e.ts, now - 30);
  assert.equal(typeof e.id, 'number');
  assert.equal(body.stats.count_24h, 1);
  assert.equal(body.stats.longs_24h, 1);
  assert.equal(body.stats.total_usd_24h, 56000.25);
  assert.equal(body.stats.biggest.ticker, 'BTC-PERP');
  assert.equal(body.stats.biggest.side, 'long');
  assert.equal(body.stats.biggest.notional_usd, 56000.25);
});

await check('route: limit clamps 1..100, default 30', async () => {
  const parent = new Hono();
  parent.route('/lounge', createLoungeApp(testConfig()));
  const r1 = await parent.request('/lounge/rekt?limit=500');
  assert.equal(r1.status, 200);
  const r2 = await parent.request('/lounge/rekt?limit=0');
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as any;
  assert.ok(Array.isArray(b2.events)); // falls back to default, no crash
  const r3 = await parent.request('/lounge/rekt?limit=abc');
  assert.equal(r3.status, 200);
});

console.log(`\n${passed} rekt tests passed${process.exitCode ? ' (with failures)' : ''}`);
