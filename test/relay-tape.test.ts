/**
 * 402 relay + tape tests.
 *
 *   npx tsx test/relay-tape.test.ts
 *
 * The settlement relay (POST /relay/quote, POST /relay/execute) lets an
 * agent pay for pay-per-call resources with its own wallet and signature —
 * the operator API key never crosses the wire. The Tape (GET /settlements)
 * is the public visual log of every real onchain settlement.
 *
 * Keys: throwaway keys generated in-process for tests only. Dry-run mode:
 * the execute path is exercised end-to-end but NEVER broadcasts.
 */
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { INK_CONFIG } from '../src/facilitator/chains.js';
import { loadConfig } from '../src/facilitator/config.js';
import {
  randomNonce,
  signAuthorization,
  type AuthorizationParams,
} from '../src/facilitator/eip3009.js';
import { NonceStore } from '../src/facilitator/nonces.js';
import { createApp } from '../src/facilitator/server.js';
import { clearPriceCache, oracleRequirements } from '../src/facilitator/oracle.js';
import {
  fetchRelayData,
  isRelayResource,
  relayQuoteTypedData,
  verifyRelayAuth,
} from '../src/facilitator/relay.js';
import { settlementRow } from '../src/facilitator/tape.js';
import { LoungeDb } from '../src/lounge/db.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { PaymentPayload, PaymentRequirements } from '../src/facilitator/types.js';
import { INK_RPC_URL } from '../src/constants.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const otherKey = generatePrivateKey();
const other = privateKeyToAccount(otherKey);
const settlerKey = generatePrivateKey();
const oraclePayTo = privateKeyToAccount(generatePrivateKey()).address;
const demoPayTo = privateKeyToAccount(generatePrivateKey()).address;

process.env.FOUR02_SETTLER_KEY = settlerKey;
process.env.FOUR02_DRY_RUN = 'true';
process.env.FOUR02_DEMO_PAYTO = demoPayTo;
process.env.FOUR02_ORACLE_PAYTO = oraclePayTo;
process.env.FOUR02_SETTLE_API_KEYS = 'test-settle-key';

const nowSec = () => Math.floor(Date.now() / 1000);

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

function makeApp(fetchFn: typeof fetch = mockFetch) {
  return createApp(loadConfig(), new NonceStore(), {
    lounge: {
      treasury: getAddress(demoPayTo),
      postFeeUsdc: '0.01',
      postFeeUnits: 10000n,
      rpcUrl: INK_RPC_URL,
      dbPath: ':memory:',
    },
    relayFetchFn: fetchFn,
  });
}

/** Stub upstream: DexScreener prices + eth_gasPrice at 2 gwei. */
function mockFetch(url: string | URL | Request, _init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes('dexscreener.com')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ pairs: [{ priceUsd: '4242.42', liquidity: { usd: 1_000_000 } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify({ result: '0x77359400' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function failingFetch(_url: string | URL | Request, _init?: RequestInit): Promise<Response> {
  return Promise.reject(new Error('upstream down'));
}

/** Sign a RelayAuth message with the given key. */
async function relayAuthSig(
  key: Hex,
  action: 'relay-quote' | 'relay-execute',
  resource: string,
  paramsJson: string,
  timestamp: string,
) {
  const account = privateKeyToAccount(key);
  return account.signTypedData({
    domain: LOUNGE_DOMAIN,
    types: LOUNGE_TYPES,
    primaryType: 'RelayAuth',
    message: {
      agent: account.address,
      action,
      resource,
      params: paramsJson,
      timestamp: BigInt(timestamp),
    },
  });
}

const ETH_PARAMS = '{"symbol":"ETH"}';
const ETH_PARAMS_OBJ = { symbol: 'ETH' };

// ---------- relay auth unit tests ----------

await check('verifyRelayAuth accepts a valid signature', async () => {
  const ts = String(nowSec());
  const sig = await relayAuthSig(agentKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const r = await verifyRelayAuth({
    agent: agent.address,
    action: 'relay-quote',
    resource: 'oracle-price',
    params: ETH_PARAMS,
    timestamp: ts,
    signature: sig,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.agent, getAddress(agent.address));
});

await check('verifyRelayAuth rejects a signature from another wallet', async () => {
  const ts = String(nowSec());
  const sig = await relayAuthSig(otherKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const r = await verifyRelayAuth({
    agent: agent.address,
    action: 'relay-quote',
    resource: 'oracle-price',
    params: ETH_PARAMS,
    timestamp: ts,
    signature: sig,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'signature_mismatch');
});

await check('verifyRelayAuth rejects a stale timestamp', async () => {
  const ts = String(nowSec() - 3600);
  const sig = await relayAuthSig(agentKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const r = await verifyRelayAuth({
    agent: agent.address,
    action: 'relay-quote',
    resource: 'oracle-price',
    params: ETH_PARAMS,
    timestamp: ts,
    signature: sig,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'stale_timestamp');
});

await check('verifyRelayAuth rejects tampered params', async () => {
  const ts = String(nowSec());
  const sig = await relayAuthSig(agentKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const r = await verifyRelayAuth({
    agent: agent.address,
    action: 'relay-quote',
    resource: 'oracle-price',
    params: '{"symbol":"BTC"}',
    timestamp: ts,
    signature: sig,
  });
  assert.equal(r.ok, false);
});

await check('isRelayResource allowlist', () => {
  assert.equal(isRelayResource('oracle-price'), true);
  assert.equal(isRelayResource('oracle-gas'), true);
  assert.equal(isRelayResource('demo-data'), true);
  assert.equal(isRelayResource('jobs'), false);
  assert.equal(isRelayResource('https://evil.example/x'), false);
  assert.equal(isRelayResource(undefined), false);
});

// ---------- /relay/quote ----------

await check('POST /relay/quote returns requirements + typed data', async () => {
  const app = makeApp();
  const ts = String(nowSec());
  const sig = await relayAuthSig(agentKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const res = await app.request('/relay/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource: 'oracle-price',
      params: ETH_PARAMS_OBJ,
      agent: agent.address,
      timestamp: ts,
      signature: sig,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    requirements: PaymentRequirements;
    typedData: {
      domain: { name: string; chainId: number; verifyingContract: string };
      message: { from: string; to: string; value: string; nonce: string };
    };
  };
  const expected = oracleRequirements(loadConfig());
  assert.equal(body.requirements.amount, expected.amount);
  assert.equal(body.requirements.payTo.toLowerCase(), oraclePayTo.toLowerCase());
  assert.equal(body.typedData.message.from.toLowerCase(), agent.address.toLowerCase());
  assert.equal(body.typedData.message.to.toLowerCase(), oraclePayTo.toLowerCase());
  assert.equal(body.typedData.message.value, expected.amount);
  assert.equal(body.typedData.domain.chainId, 57073);
  assert.ok(/^0x[0-9a-f]{64}$/i.test(body.typedData.message.nonce));
});

await check('POST /relay/quote rejects bad signature with 401', async () => {
  const app = makeApp();
  const ts = String(nowSec());
  const sig = await relayAuthSig(otherKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const res = await app.request('/relay/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource: 'oracle-price',
      params: ETH_PARAMS_OBJ,
      agent: agent.address,
      timestamp: ts,
      signature: sig,
    }),
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'relay_unauthorized');
});

await check('POST /relay/quote rejects bad resource and bad symbol', async () => {
  const app = makeApp();
  const ts = String(nowSec());
  const mk = (resource: string, params: unknown) =>
    app.request('/relay/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resource,
        params,
        agent: agent.address,
        timestamp: ts,
        signature: '0x' + '00'.repeat(65),
      }),
    });
  assert.equal((await mk('jobs', {})).status, 400);
  assert.equal((await mk('oracle-price', { symbol: 'DOGE' })).status, 400);
});

// ---------- /relay/execute (dry-run: full pipeline, no broadcast) ----------

async function buildExecuteBody(key: Hex, authKey: Hex, app = makeApp()) {
  const ts = String(nowSec());
  // 1. quote
  const quoteSig = await relayAuthSig(authKey, 'relay-quote', 'oracle-price', ETH_PARAMS, ts);
  const quoteRes = await app.request('/relay/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource: 'oracle-price',
      params: ETH_PARAMS_OBJ,
      agent: privateKeyToAccount(authKey).address,
      timestamp: ts,
      signature: quoteSig,
    }),
  });
  assert.equal(quoteRes.status, 200);
  const quote = (await quoteRes.json()) as {
    requirements: PaymentRequirements;
    typedData: { message: { to: string; value: string; validAfter: string; validBefore: string; nonce: string } };
  };
  // 2. sign the payment authorization with the payer key
  const authParams: AuthorizationParams = {
    from: privateKeyToAccount(key).address,
    to: getAddress(quote.typedData.message.to),
    value: BigInt(quote.typedData.message.value),
    validAfter: BigInt(quote.typedData.message.validAfter),
    validBefore: BigInt(quote.typedData.message.validBefore),
    nonce: quote.typedData.message.nonce as Hex,
  };
  const exact = await signAuthorization(INK_CONFIG, key, authParams);
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    accepted: quote.requirements,
    payload: exact,
  };
  // 3. sign the execute auth
  const execTs = String(nowSec());
  const execSig = await relayAuthSig(authKey, 'relay-execute', 'oracle-price', ETH_PARAMS, execTs);
  return {
    app,
    body: {
      paymentPayload,
      resource: 'oracle-price',
      params: ETH_PARAMS_OBJ,
      agent: privateKeyToAccount(authKey).address,
      timestamp: execTs,
      signature: execSig,
    },
  };
}

await check('POST /relay/execute runs the full pipeline in dry-run (no broadcast)', async () => {
  const { app, body } = await buildExecuteBody(agentKey, agentKey);
  const res = await app.request('/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    success: boolean;
    dryRun?: boolean;
    errorReason?: string;
    transaction?: string;
    data?: { symbol?: string; price_usd?: string };
  };
  assert.equal(res.status, 200);
  assert.equal(json.dryRun, true);
  assert.equal(json.errorReason, 'dry_run_mode');
  assert.equal(json.transaction, undefined, 'dry-run must not broadcast');
  assert.equal(json.data?.symbol, 'ETH', 'dry-run still serves the paid data');
  assert.equal(json.data?.price_usd, '4242.42');
});

await check('POST /relay/execute 503s without taking payment when the feed is down', async () => {
  clearPriceCache();
  const app = makeApp(failingFetch);
  const { body } = await buildExecuteBody(agentKey, agentKey, app);
  const res = await app.request('/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 503);
  const json = (await res.json()) as { error: string };
  assert.equal(json.error, 'relay_upstream_unavailable');
});

// ---------- fetchRelayData unit tests ----------

await check('fetchRelayData returns the paid price payload', async () => {
  const served = await fetchRelayData('oracle-price', { symbol: 'ETH' }, mockFetch);
  assert.equal(served.data.symbol, 'ETH');
  assert.equal(served.data.price_usd, '4242.42');
  assert.equal(typeof served.data.as_of, 'string');
  assert.equal(served.queryLog?.endpoint, 'price');
  assert.equal(served.queryLog?.symbol, 'ETH');
});

await check('fetchRelayData returns the gas payload', async () => {
  const served = await fetchRelayData('oracle-gas', {}, mockFetch);
  assert.equal(served.data.chain_id, 57073);
  assert.equal(served.data.gas_price_wei, '2000000000');
  assert.equal(served.queryLog?.endpoint, 'gas');
});

await check('fetchRelayData returns the demo dataset', async () => {
  const served = await fetchRelayData('demo-data', {}, mockFetch);
  assert.equal((served.data.dataset as { invoices_settled: number }).invoices_settled, 1337);
  assert.equal(served.queryLog, null);
});

await check('fetchRelayData throws when the upstream is down', async () => {
  clearPriceCache();
  await assert.rejects(fetchRelayData('oracle-price', { symbol: 'ETH' }, failingFetch));
});

await check('POST /relay/execute rejects when the agent is not the payer', async () => {
  // payment signed by other, relay auth by agent
  const { app, body } = await buildExecuteBody(otherKey, agentKey);
  const res = await app.request('/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 403);
  const json = (await res.json()) as { error: string };
  assert.equal(json.error, 'payer_mismatch');
});

await check('POST /relay/execute rejects tampered requirements', async () => {
  const { app, body } = await buildExecuteBody(agentKey, agentKey);
  body.paymentPayload.accepted = { ...body.paymentPayload.accepted, amount: '99999999' };
  const res = await app.request('/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 402);
  const json = (await res.json()) as { error: string };
  assert.equal(json.error, 'requirements_mismatch');
});

await check('POST /relay/execute rejects bad relay signature with 401', async () => {
  const { app, body } = await buildExecuteBody(agentKey, agentKey);
  body.signature = await relayAuthSig(otherKey, 'relay-execute', 'oracle-price', ETH_PARAMS, body.timestamp);
  const res = await app.request('/relay/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 401);
});

// ---------- tape ----------

await check('settlementRow builds a row from a successful settle', () => {
  const row = settlementRow(
    {
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: INK_CONFIG.caip2,
          asset: INK_CONFIG.usdc.address,
          amount: '1000',
          payTo: oraclePayTo,
          maxTimeoutSeconds: 120,
          extra: {},
        },
        payload: {
          authorization: {
            from: agent.address,
            to: oraclePayTo,
            value: '1000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: randomNonce(),
          },
          signature: '0x' + '11'.repeat(65),
        },
      } as PaymentPayload,
      paymentRequirements: {
        scheme: 'exact',
        network: INK_CONFIG.caip2,
        asset: INK_CONFIG.usdc.address,
        amount: '1000',
        payTo: oraclePayTo,
        maxTimeoutSeconds: 120,
        extra: {},
      },
    },
    { success: true, transaction: `0x${'ab'.repeat(32)}` as Hex, network: INK_CONFIG.caip2, payer: agent.address },
    'oracle-price:ETH',
  );
  assert.ok(row);
  assert.equal(row!.amountUsdc, '0.001');
  assert.equal(row!.amountRaw, '1000');
  assert.equal(row!.resource, 'oracle-price:ETH');
  assert.equal(row!.payer, getAddress(agent.address));
});

await check('settlementRow returns null for failed settlements', () => {
  assert.equal(
    settlementRow({} as any, { success: false, errorReason: 'x' }, 'demo-data'),
    null,
  );
});

await check('tape DB: genesis settlement is seeded, logging round-trips', () => {
  const db = new LoungeDb(':memory:');
  const rows = db.recentSettlements(50);
  const genesis = rows.find(
    (r) => r.txHash === '0xb3614455f918d97b3df53db67878a46476c3962cd7d7de0f700a25cfe3235a4f',
  );
  assert.ok(genesis, 'genesis settlement seeded');
  assert.equal(genesis!.amountUsdc, '0.001');
  assert.equal(genesis!.resource, 'oracle-price:ETH');
  // log a new settlement
  db.logSettlement({
    txHash: '0x' + 'cc'.repeat(32),
    payer: getAddress(agent.address),
    payTo: getAddress(demoPayTo),
    amountRaw: '10000',
    amountUsdc: '0.01',
    asset: INK_CONFIG.usdc.address,
    network: INK_CONFIG.caip2,
    resource: 'demo-data',
    createdAt: nowSec(),
  });
  const latest = db.recentSettlements(1);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.resource, 'demo-data');
  // duplicate tx hash is ignored, never double-counted
  db.logSettlement({
    txHash: '0x' + 'cc'.repeat(32),
    payer: getAddress(agent.address),
    payTo: getAddress(demoPayTo),
    amountRaw: '10000',
    amountUsdc: '0.01',
    asset: INK_CONFIG.usdc.address,
    network: INK_CONFIG.caip2,
    resource: 'demo-data',
    createdAt: nowSec(),
  });
  assert.equal(db.recentSettlements(50).length, 2);
});

await check('GET /settlements serves the tape (genesis row present)', async () => {
  const app = makeApp();
  const res = await app.request('/settlements');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { settlements: { txHash: string; amountUsdc: string }[] };
  assert.ok(Array.isArray(body.settlements));
  assert.ok(
    body.settlements.some(
      (s) => s.txHash === '0xb3614455f918d97b3df53db67878a46476c3962cd7d7de0f700a25cfe3235a4f',
    ),
    'genesis settlement on the tape',
  );
  const limited = (await (await app.request('/settlements?limit=1')).json()) as {
    settlements: unknown[];
  };
  assert.equal(limited.settlements.length, 1);
});

await check('relayQuoteTypedData rejects non-positive amounts', () => {
  const reqs = { ...oracleRequirements(loadConfig()), amount: '0' };
  assert.equal(relayQuoteTypedData(reqs, getAddress(agent.address)), null);
});

console.log(`\nrelay-tape: ${passed} checks passed`);
