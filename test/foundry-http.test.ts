/**
 * Foundry public HTTP surface tests.
 *
 *   npx tsx test/foundry-http.test.ts
 *
 * Covers: /health shape, catalog-backed list endpoints, catalog caching (one
 * upstream fetch for two GETs), POST /dry-run mapping the body onto Hookit's
 * prepare-launch schema (lowercased pair, payout mapping), surfacing Hookit's
 * ok:false verdicts as 200+ok:false, 400 on invalid params, 502 on upstream
 * failure, the global hourly dry-run budget (429), and upstream 429
 * passthrough.
 *
 * No network (fetch is injected), no keys, nothing signed. Deterministic.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createFoundryHttpApp } from '../src/foundry/http.js';

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

const CATALOG = {
  presets: [{ id: 'clean', label: 'Clean' }],
  modules: [{ id: 'antiSnipe' }],
  pairs: [{ id: 'eth' }, { id: 'usdg' }],
};

const VERDICT = { ok: true, tx: { to: '0xabc', data: '0x1234' } };

/** Mock fetch: records calls, serves canned Hookit agent-API responses. */
function mockFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/api/agents/catalog')) {
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }
    if (url.endsWith('/api/agents/prepare-launch')) {
      return new Response(JSON.stringify(VERDICT), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** The sub-app mounted exactly like production: at /foundry. */
function mountedApp(
  opts: { fetchFn?: typeof fetch; dryRunPerHour?: number } = {},
) {
  const mock = mockFetch();
  const app = new Hono();
  app.route(
    '/foundry',
    createFoundryHttpApp({ fetchFn: opts.fetchFn ?? mock.fn, dryRunPerHour: opts.dryRunPerHour }),
  );
  return { app, mock };
}

const dryRunBody = {
  name: 'Test Coin',
  symbol: 'TST',
  pair: 'ETH',
  preset: 'clean',
  devBuyPct: 1,
};

await check('GET /foundry/health reports dry-run-only', async () => {
  const { app } = mountedApp();
  const res = await app.request('/foundry/health');
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; dryRunOnly: boolean };
  assert.equal(json.ok, true);
  assert.equal(json.dryRunOnly, true);
});

await check('GET /foundry/presets returns catalog presets', async () => {
  const { app } = mountedApp();
  const res = await app.request('/foundry/presets');
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; result: unknown[] };
  assert.equal(json.ok, true);
  assert.deepEqual(json.result, CATALOG.presets);
});

await check('catalog is cached (one upstream fetch for two GETs)', async () => {
  const { app, mock } = mountedApp();
  await app.request('/foundry/pairs');
  await app.request('/foundry/modules');
  const catalogCalls = mock.calls.filter((c) => c.url.endsWith('/api/agents/catalog'));
  assert.equal(catalogCalls.length, 1);
});

await check('POST /dry-run maps body onto prepare-launch schema', async () => {
  const { app, mock } = mountedApp();
  const res = await app.request('/foundry/dry-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...dryRunBody,
      payout: '0x1234567890123456789012345678901234567890',
    }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; dryRun: boolean; result: unknown };
  assert.equal(json.ok, true);
  assert.equal(json.dryRun, true);
  assert.deepEqual(json.result, VERDICT);
  const launchCalls = mock.calls.filter((c) =>
    c.url.endsWith('/api/agents/prepare-launch'),
  );
  assert.equal(launchCalls.length, 1);
  const sent = JSON.parse(launchCalls[0]!.init!.body as string) as Record<string, unknown>;
  assert.equal(sent.pair, 'eth'); // lowercased to Hookit's schema
  assert.deepEqual(sent.payout, {
    kind: 'wallet',
    address: '0x1234567890123456789012345678901234567890',
  });
  assert.equal(sent.name, 'Test Coin');
  assert.ok(!('dryRun' in sent)); // unsigned verdict is inherent, no flag needed
});

await check("POST /dry-run surfaces hookit's ok:false as 200+ok:false", async () => {
  const rejecting = (async (url: string) => {
    if (url.endsWith('/api/agents/prepare-launch')) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Pick a destination for the hook tax.' }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(CATALOG), { status: 200 });
  }) as unknown as typeof fetch;
  const { app } = mountedApp({ fetchFn: rejecting });
  const res = await app.request('/foundry/dry-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...dryRunBody, hookTaxPct: 2 }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /hook tax/);
});

await check('POST /dry-run rejects invalid params with 400', async () => {
  const { app, mock } = mountedApp();
  const res = await app.request('/foundry/dry-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...dryRunBody, symbol: 'BAD!!' }),
  });
  assert.equal(res.status, 400);
  assert.equal(
    mock.calls.filter((c) => c.url.endsWith('/api/agents/prepare-launch')).length,
    0,
  );
});

await check('POST /dry-run returns 502 when Hookit is unreachable', async () => {
  const failing = (async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
  const { app } = mountedApp({ fetchFn: failing });
  const res = await app.request('/foundry/dry-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dryRunBody),
  });
  assert.equal(res.status, 502);
  const json = (await res.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.match(json.error, /connection refused/);
});

await check('global dry-run budget returns 429 when exhausted', async () => {
  const { app, mock } = mountedApp({ dryRunPerHour: 1 });
  const post = () =>
    app.request('/foundry/dry-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dryRunBody),
    });
  assert.equal((await post()).status, 200);
  const res = await post();
  assert.equal(res.status, 429);
  assert.equal(
    mock.calls.filter((c) => c.url.endsWith('/api/agents/prepare-launch')).length,
    1,
  );
});

await check('upstream 429 is passed through as 429', async () => {
  const limited = (async (url: string) => {
    if (url.endsWith('/api/agents/prepare-launch')) {
      return new Response('slow down', { status: 429 });
    }
    return new Response(JSON.stringify(CATALOG), { status: 200 });
  }) as unknown as typeof fetch;
  const { app } = mountedApp({ fetchFn: limited });
  const res = await app.request('/foundry/dry-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dryRunBody),
  });
  assert.equal(res.status, 429);
});

console.log(`\nfoundry-http: ${passed} checks passed`);
