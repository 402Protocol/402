/**
 * Foundry stats tests.
 *
 *   npx tsx test/foundry-stats.test.ts
 *
 * Covers: counting exact-fee treasury payments (oldest-first), ignoring
 * non-fee transfers, fee-total math, resolving the latest launch from the
 * fee sender's most recent Hookit pool (ticker/name/URL), latest null when
 * there are no payments or no matching pool, and the /stats HTTP route
 * shape (200 + ok:true) with a 5-minute cache (one upstream burst for two
 * GETs) and 502 on upstream failure.
 *
 * No network (fetch is injected), no keys, nothing signed. Deterministic.
 */
import assert from 'node:assert/strict';
import {
  fetchFeePayments,
  getFoundryStats,
} from '../src/foundry/stats.js';
import { createFoundryHttpApp } from '../src/foundry/http.js';

const TREASURY = '0xaa4e163da1545f6967d284c0c5cfa469c644ed23';
const CREATOR = '0xAEB8E9A24ae62d9769De4AF91e20Be010BcCaa4A';
const FEE_WEI = '1000000000000000';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/** Canned Blockscout / Hookit upstream. */
function mockFetch(opts: {
  txs?: Array<Record<string, unknown>>;
  pools?: Array<Record<string, unknown>>;
  failTxs?: boolean;
}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.includes('explorer.inkonchain.com')) {
      if (opts.failTxs) return jsonResponse({ error: 'boom' }, false, 500);
      return jsonResponse({ items: opts.txs ?? [], next_page_params: null });
    }
    if (url.includes('/api/launches')) {
      return jsonResponse({ pools: opts.pools ?? [] });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const feeTx = (hash: string, ts: string) => ({
  hash,
  from: { hash: CREATOR },
  to: { hash: TREASURY },
  value: FEE_WEI,
  timestamp: ts,
});

const pool = (over: Record<string, unknown> = {}) => ({
  creator: CREATOR,
  contractAddress: '0x2f37e91b834cd5f87c06112377fa9c12a10f85a8',
  name: 'Bait',
  ticker: 'BAIT',
  launchedAt: 1791305200,
  ...over,
});

await check('counts exact-fee payments oldest-first, ignores others', async () => {
  const { fetchFn } = mockFetch({
    txs: [
      feeTx('0xBBB', '2026-10-06T16:46:44.000000Z'),
      // noise: wrong value, wrong recipient
      { hash: '0xN1', from: { hash: CREATOR }, to: { hash: TREASURY }, value: '2000000000000000', timestamp: '2026-10-06T16:00:00.000000Z' },
      { hash: '0xN2', from: { hash: CREATOR }, to: { hash: '0xdead' }, value: FEE_WEI, timestamp: '2026-10-06T16:10:00.000000Z' },
      feeTx('0xAAA', '2026-10-05T15:25:24.000000Z'),
    ],
  });
  const pays = await fetchFeePayments(fetchFn);
  assert.equal(pays.length, 2);
  assert.equal(pays[0].hash, '0xAAA');
  assert.equal(pays[1].hash, '0xBBB');
  assert.equal(pays[1].from, CREATOR);
});

await check('stats: count, fee total, latest launch resolved', async () => {
  const { fetchFn } = mockFetch({
    txs: [feeTx('0xAAA', '2026-10-05T15:25:24.000000Z'), feeTx('0xBBB', '2026-10-06T16:46:44.000000Z')],
    pools: [
      pool({ ticker: 'AGNT', name: 'AGNT TEST', contractAddress: '0xEE488deA1B8Ca9CD74fc3c9150EFA5951D0745E8', launchedAt: 1791211524 }),
      pool(),
      pool({ creator: '0xother', ticker: 'ZZZ', launchedAt: 1791400000 }),
    ],
  });
  const s = await getFoundryStats(fetchFn, 'https://www.hookit.fun');
  assert.equal(s.launches, 2);
  assert.equal(s.feePerLaunchEth, '0.001');
  assert.equal(s.feesCollectedEth, '0.002');
  assert.ok(s.latest);
  assert.equal(s.latest.n, 2);
  assert.equal(s.latest.ticker, 'BAIT');
  assert.equal(s.latest.name, 'Bait');
  assert.equal(s.latest.url, 'https://www.hookit.fun/token/0x2f37e91b834cd5f87c06112377fa9c12a10f85a8');
});

await check('stats: no payments -> zeroed, latest null', async () => {
  const { fetchFn } = mockFetch({ txs: [], pools: [pool()] });
  const s = await getFoundryStats(fetchFn, 'https://www.hookit.fun');
  assert.equal(s.launches, 0);
  assert.equal(s.feesCollectedEth, '0.000');
  assert.equal(s.latest, null);
});

await check('stats: payments but no matching pool -> latest null', async () => {
  const { fetchFn } = mockFetch({
    txs: [feeTx('0xAAA', '2026-10-05T15:25:24.000000Z')],
    pools: [pool({ creator: '0xother' })],
  });
  const s = await getFoundryStats(fetchFn, 'https://www.hookit.fun');
  assert.equal(s.launches, 1);
  assert.equal(s.latest, null);
});

await check('GET /stats returns ok:true with the stats shape', async () => {
  const { fetchFn } = mockFetch({
    txs: [feeTx('0xAAA', '2026-10-05T15:25:24.000000Z')],
    pools: [pool({ ticker: 'AGNT', name: 'AGNT TEST', contractAddress: '0xabc' })],
  });
  const app = createFoundryHttpApp({ fetchFn });
  const res = await app.request('/stats');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.launches, 1);
  assert.equal(body.feesCollectedEth, '0.001');
  assert.equal((body.latest as Record<string, unknown>).ticker, 'AGNT');
});

await check('GET /stats caches: one upstream burst for two GETs', async () => {
  const { fetchFn, calls } = mockFetch({ txs: [feeTx('0xAAA', '2026-10-05T15:25:24.000000Z')], pools: [] });
  const app = createFoundryHttpApp({ fetchFn });
  await app.request('/stats');
  await app.request('/stats');
  // 1 blockscout page + 1 hookit launches call, then cache hit
  assert.equal(calls.length, 2);
});

await check('GET /stats 502s on upstream failure', async () => {
  const { fetchFn } = mockFetch({ failTxs: true });
  const app = createFoundryHttpApp({ fetchFn });
  const res = await app.request('/stats');
  assert.equal(res.status, 502);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
});

console.log(`\n${passed} passed`);
