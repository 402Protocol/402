/**
 * 402 Oracles v0 — tests.
 *
 *   npx tsx test/oracle.test.ts
 *
 * Unit tests for the data sources (mocked fetch) plus full x402-flow
 * integration tests against createOracleApp in dry-run mode, using
 * throwaway in-process keys. Nothing is broadcast.
 */
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { INK_CONFIG } from '../src/facilitator/chains.js';
import { loadConfig } from '../src/facilitator/config.js';
import {
  randomNonce,
  signAuthorization,
} from '../src/facilitator/eip3009.js';
import { NonceStore } from '../src/facilitator/nonces.js';
import {
  clearPriceCache,
  createOracleApp,
  fetchGasPriceWei,
  fetchPriceUsd,
  getPriceUsd,
  oracleRequirements,
  PRICE_CACHE_TTL_MS,
  type OracleQuery,
} from '../src/facilitator/oracle.js';
import type {
  PaymentPayload,
  PaymentRequirements,
} from '../src/facilitator/types.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const oraclePayTo = privateKeyToAccount(generatePrivateKey()).address;

process.env.FOUR02_DRY_RUN = 'true';
process.env.FOUR02_ORACLE_PAYTO = oraclePayTo;
process.env.FOUR02_ORACLE_PRICE_USDC = '0.001';

const now = () => Math.floor(Date.now() / 1000);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    clearPriceCache();
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// ---- mocked upstream -------------------------------------------------------

const DEX_MOCK = {
  pairs: [
    { priceUsd: '3000.50', liquidity: { usd: 1_000 } },
    { priceUsd: '2999.00', liquidity: { usd: 50_000 } }, // best liquidity wins
    { priceUsd: '3010.00' }, // no liquidity info
  ],
};

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes('dexscreener.com')) {
    return Promise.resolve(
      new Response(JSON.stringify(DEX_MOCK), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  if (init?.method === 'POST') {
    // eth_gasPrice mock: 2 gwei
    return Promise.resolve(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x77359400' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

const failingFetch = (): Promise<Response> =>
  Promise.resolve(new Response('boom', { status: 500 }));

// ---- data source unit tests ------------------------------------------------

await check('fetchPriceUsd picks the best-liquidity pair', async () => {
  const q = await fetchPriceUsd('ETH', mockFetch as typeof fetch);
  assert.equal(q.priceUsd, '2999.00');
});

await check('fetchPriceUsd throws when no priced pair exists', async () => {
  const empty = () =>
    Promise.resolve(
      new Response(JSON.stringify({ pairs: [] }), { status: 200 }),
    );
  await assert.rejects(fetchPriceUsd('ETH', empty as typeof fetch));
});

await check('getPriceUsd caches within TTL (one upstream hit)', async () => {
  let hits = 0;
  const counting = (...a: Parameters<typeof fetch>) => {
    hits++;
    return mockFetch(...a);
  };
  await getPriceUsd('ETH', counting as typeof fetch);
  await getPriceUsd('ETH', counting as typeof fetch);
  assert.equal(hits, 1);
});

await check('getPriceUsd serves stale cache when upstream fails', async () => {
  const t0 = Date.now();
  await getPriceUsd('ETH', mockFetch as typeof fetch, t0); // warm the cache
  // Jump past the TTL with a dead upstream: stale entry must be served.
  const q = await getPriceUsd(
    'ETH',
    failingFetch as typeof fetch,
    t0 + PRICE_CACHE_TTL_MS + 1,
  );
  assert.equal(q.stale, true);
  assert.equal(q.priceUsd, '2999.00');
});

await check('getPriceUsd throws with cold cache and dead upstream', async () => {
  await assert.rejects(getPriceUsd('ETH', failingFetch as typeof fetch));
});

await check('fetchGasPriceWei parses hex gwei', async () => {
  const g = await fetchGasPriceWei(mockFetch as typeof fetch);
  assert.equal(g.gasPriceWei, '2000000000');
});

// ---- app-level tests --------------------------------------------------------

function testApp(onQuery?: (q: OracleQuery) => void) {
  const served: OracleQuery[] = [];
  const app = createOracleApp(loadConfig(), {
    store: new NonceStore(),
    fetchFn: mockFetch as typeof fetch,
    onQueryServed: (q) => {
      served.push(q);
      onQuery?.(q);
    },
  });
  return { app, served };
}

async function oracleReqs(app: {
  request: (u: string, init?: RequestInit) => Response | Promise<Response>;
}): Promise<PaymentRequirements> {
  const noPay = (await app.request('/price?symbol=ETH')) as Response;
  const h = noPay.headers.get('PAYMENT-REQUIRED') as string;
  return (
    JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as {
      accepts: PaymentRequirements[];
    }
  ).accepts[0];
}

async function signedSigHeader(reqs: PaymentRequirements): Promise<string> {
  const exact = await signAuthorization(INK_CONFIG, payerKey, {
    from: payer.address,
    to: getAddress(reqs.payTo),
    value: BigInt(reqs.amount),
    validAfter: 0n,
    validBefore: BigInt(now() + 300),
    nonce: randomNonce(),
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: reqs,
    payload: exact,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

await check('oracleRequirements prices at 0.001 USDC to the oracle recipient', async () => {
  const reqs = oracleRequirements(loadConfig());
  assert.equal(reqs.amount, '1000'); // 0.001 USDC, 6 decimals
  assert.equal(getAddress(reqs.payTo), getAddress(oraclePayTo));
  assert.equal(reqs.network, 'eip155:57073');
});

await check('GET /price without payment -> 402 + PAYMENT-REQUIRED', async () => {
  const { app } = testApp();
  const res = await app.request('/price?symbol=ETH');
  assert.equal(res.status, 402);
  assert.ok(res.headers.get('PAYMENT-REQUIRED'));
});

await check('GET /price?symbol=FAKE -> 400 (allowlist)', async () => {
  const { app } = testApp();
  const res = await app.request('/price?symbol=FAKE');
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'unsupported_symbol');
});

await check('GET /price?symbol=ETH with valid signature -> 200 + logged', async () => {
  const { app, served } = testApp();
  const reqs = await oracleReqs(app);
  const res = await app.request('/price?symbol=ETH', {
    headers: { 'PAYMENT-SIGNATURE': await signedSigHeader(reqs) },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    symbol: string;
    price_usd: string;
    stale: boolean;
  };
  assert.equal(body.symbol, 'ETH');
  assert.equal(body.price_usd, '2999.00');
  assert.equal(body.stale, false);
  assert.ok(res.headers.get('PAYMENT-RESPONSE'), 'missing PAYMENT-RESPONSE');
  assert.equal(served.length, 1);
  assert.equal(served[0].endpoint, 'price');
  assert.equal(served[0].symbol, 'ETH');
  assert.equal(getAddress(served[0].payer), getAddress(payer.address));
});

await check('GET /gas with valid signature -> 200 + logged', async () => {
  const { app, served } = testApp();
  const reqs = await oracleReqs(app);
  const res = await app.request('/gas', {
    headers: { 'PAYMENT-SIGNATURE': await signedSigHeader(reqs) },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    chain_id: number;
    gas_price_wei: string;
  };
  assert.equal(body.chain_id, 57073);
  assert.equal(body.gas_price_wei, '2000000000');
  assert.equal(served.length, 1);
  assert.equal(served[0].endpoint, 'gas');
});

await check('tampered signature -> 402', async () => {
  const { app, served } = testApp();
  const reqs = await oracleReqs(app);
  const good = await signedSigHeader(reqs);
  const bad = good.slice(0, -4) + 'AAAA';
  const res = await app.request('/price?symbol=ETH', {
    headers: { 'PAYMENT-SIGNATURE': bad },
  });
  assert.equal(res.status, 402);
  assert.equal(served.length, 0);
});

await check('upstream down + cold cache -> 503, nothing logged', async () => {
  const served: OracleQuery[] = [];
  const app = createOracleApp(loadConfig(), {
    store: new NonceStore(),
    fetchFn: failingFetch as typeof fetch,
    onQueryServed: (q) => served.push(q),
  });
  const noPay = (await app.request(
    '/price?symbol=ETH',
  )) as Response;
  const h = noPay.headers.get('PAYMENT-REQUIRED') as string;
  const reqs = (
    JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as {
      accepts: PaymentRequirements[];
    }
  ).accepts[0];
  const res = await app.request('/price?symbol=ETH', {
    headers: { 'PAYMENT-SIGNATURE': await signedSigHeader(reqs) },
  });
  assert.equal(res.status, 503);
  assert.equal(served.length, 0);
});

await check('missing FOUR02_ORACLE_PAYTO -> 500 oracle_not_configured', async () => {
  delete process.env.FOUR02_ORACLE_PAYTO;
  const app = createOracleApp(loadConfig(), { store: new NonceStore() });
  const res = await app.request('/price?symbol=ETH');
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'oracle_not_configured');
  process.env.FOUR02_ORACLE_PAYTO = oraclePayTo;
});

console.log(`\n${passed} oracle tests passed${process.exitCode ? ' (with failures)' : ''}`);
