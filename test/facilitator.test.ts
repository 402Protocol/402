/**
 * 402 Phase 2 — facilitator tests.
 *
 *   npx tsx test/facilitator.test.ts
 *
 * Unit tests for /verify logic (valid, tampered, expired, replay, wrong
 * token/chain/signer/recipient) plus a dry-run settle path against the live
 * Ink RPC that constructs + simulates but NEVER broadcasts.
 *
 * Keys: throwaway keys generated in-process for tests only. No production
 * keys, no funded keys, nothing broadcast.
 */
import assert from 'node:assert/strict';
import { createPublicClient, http, parseAbiItem, getAddress } from 'viem';
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
import { settleExactPayment } from '../src/facilitator/settle.js';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyRequest,
} from '../src/facilitator/types.js';
import { verifyExactPayment } from '../src/facilitator/verify.js';
import { ink, INK_RPC_URL, USDC_ADDRESS } from '../src/constants.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const otherKey = generatePrivateKey();
const other = privateKeyToAccount(otherKey);
const settlerKey = generatePrivateKey();
const demoPayTo = privateKeyToAccount(generatePrivateKey()).address;

process.env.FOUR02_SETTLER_KEY = settlerKey;
process.env.FOUR02_DRY_RUN = 'true';
process.env.FOUR02_DEMO_PAYTO = demoPayTo;
// M1: API-key allowlist for /settle (tests use this key unless noted).
process.env.FOUR02_SETTLE_API_KEYS = 'test-settle-key';

const SETTLE_HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': 'test-settle-key',
};

const now = () => Math.floor(Date.now() / 1000);

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: INK_CONFIG.caip2,
    asset: INK_CONFIG.usdc.address,
    amount: '10000', // 0.01 USDC
    payTo: demoPayTo,
    maxTimeoutSeconds: 120,
    extra: {},
    ...over,
  };
}

async function signedRequest(
  authOver: Partial<AuthorizationParams> = {},
  reqOver: Partial<PaymentRequirements> = {},
): Promise<VerifyRequest> {
  const reqs = requirements(reqOver);
  const params: AuthorizationParams = {
    from: payer.address,
    to: getAddress(reqs.payTo),
    value: BigInt(reqs.amount),
    validAfter: 0n,
    validBefore: BigInt(now() + 300),
    nonce: randomNonce(),
    ...authOver,
  };
  const exact = await signAuthorization(INK_CONFIG, payerKey, params);
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    accepted: reqs,
    payload: exact,
  };
  return { paymentPayload, paymentRequirements: reqs };
}

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

// ---------- verify unit tests ----------
await check('valid authorization verifies', async () => {
  const r = await signedRequest();
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, true, v.invalidReason);
  assert.equal(v.invalidReason, '');
  assert.equal(v.payer, getAddress(payer.address));
});

await check('tampered value -> amount_mismatch', async () => {
  // Re-sign for 9999 while requirements demand 10000: sig is valid, price isn't.
  const r = await signedRequest({ value: 9999n });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'amount_mismatch');
});

await check('expired authorization -> authorization_expired', async () => {
  const r = await signedRequest({ validBefore: BigInt(now() - 10) });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'authorization_expired');
});

await check('not-yet-valid authorization -> authorization_not_yet_valid', async () => {
  const r = await signedRequest({ validAfter: BigInt(now() + 3600) });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'authorization_not_yet_valid');
});

await check('replayed nonce -> nonce_replay', async () => {
  const store = new NonceStore();
  const r = await signedRequest();
  const first = await verifyExactPayment(r, { store });
  assert.equal(first.isValid, true, first.invalidReason);
  const second = await verifyExactPayment(r, { store });
  assert.equal(second.isValid, false);
  assert.equal(second.invalidReason, 'nonce_replay');
});

await check('wrong token -> invalid_asset', async () => {
  const fake = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // mainnet USDC, not Ink's
  const r = await signedRequest({}, { asset: fake });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'invalid_asset');
});

await check('wrong chain -> invalid_network', async () => {
  const r = await signedRequest({}, { network: 'eip155:1' });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'invalid_network');
});

await check('wrong scheme -> unsupported_scheme', async () => {
  const r = await signedRequest({}, { scheme: 'upto' });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'unsupported_scheme');
});

await check('signer != from -> invalid_exact_evm_payload_signature', async () => {
  // Sign with otherKey but claim from=payer.address.
  const reqs = requirements();
  const exact = await signAuthorization(INK_CONFIG, otherKey, {
    from: other.address,
    to: getAddress(reqs.payTo),
    value: BigInt(reqs.amount),
    validAfter: 0n,
    validBefore: BigInt(now() + 300),
    nonce: randomNonce(),
  });
  // Tamper the claimed sender to payer (signature stays other's).
  exact.authorization.from = getAddress(payer.address);
  const v = await verifyExactPayment(
    {
      paymentPayload: { x402Version: 2, accepted: reqs, payload: exact },
      paymentRequirements: reqs,
    },
    { store: new NonceStore() },
  );
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'invalid_exact_evm_payload_signature');
});

await check('recipient mismatch -> recipient_mismatch', async () => {
  const r = await signedRequest({ to: other.address });
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'recipient_mismatch');
});

await check('corrupt signature -> invalid signature', async () => {
  const r = await signedRequest();
  const sig = r.paymentPayload.payload.signature;
  // Flip a nibble inside `r` (not the v byte: viem normalizes v 27<->0, 28<->1).
  const bad = (sig.slice(0, 10) + (sig[10] === '0' ? '1' : '0') + sig.slice(11)) as `0x${string}`;
  assert.notEqual(bad.toLowerCase(), sig.toLowerCase());
  r.paymentPayload.payload.signature = bad;
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.ok(
    ['invalid_exact_evm_payload_signature', 'invalid_exact_evm_payload'].includes(
      v.invalidReason,
    ),
  );
});

await check('payload/requirements mismatch -> requirements_mismatch', async () => {
  const r = await signedRequest();
  r.paymentPayload.accepted = { ...r.paymentPayload.accepted, amount: '99999' };
  const v = await verifyExactPayment(r, { store: new NonceStore() });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'requirements_mismatch');
});

// ---------- onchain checks (read-only) ----------
await check('chain config matches live Ink USDC domain', async () => {
  const c = createPublicClient({ chain: ink, transport: http(INK_RPC_URL) });
  const name = await c.readContract({
    address: USDC_ADDRESS,
    abi: [parseAbiItem('function name() view returns (string)')],
    functionName: 'name',
  });
  const version = await c.readContract({
    address: USDC_ADDRESS,
    abi: [parseAbiItem('function version() view returns (string)')],
    functionName: 'version',
  });
  assert.equal(name, INK_CONFIG.usdc.eip712Name);
  assert.equal(version, INK_CONFIG.usdc.eip712Version);
});

// ---------- settle: dry-run (never broadcasts) ----------
await check('dry-run settle constructs + simulates, never broadcasts', async () => {
  const r = await signedRequest();
  const res = await settleExactPayment(r, {
    store: new NonceStore(),
    settlerKey,
    dryRun: true,
  });
  assert.equal(res.success, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.errorReason, 'dry_run_mode');
  assert.equal(res.transaction, undefined, 'dry-run must not produce a tx hash');
  assert.equal(res.network, INK_CONFIG.caip2);
});

await check('settle without settler key is refused', async () => {
  const r = await signedRequest();
  const res = await settleExactPayment(r, {
    store: new NonceStore(),
    settlerKey: undefined,
    dryRun: true,
  });
  assert.equal(res.success, false);
  assert.equal(res.errorReason, 'missing_settler_key');
});

// ---------- HTTP surface (in-process, no listen) ----------
await check('GET /supported lists Ink exact', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const res = await app.request('/supported');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    kinds: { x402Version: number; scheme: string; network: string }[];
    signers?: Record<string, string[]>;
  };
  assert.ok(
    body.kinds.some(
      (k) =>
        k.x402Version === 2 && k.scheme === 'exact' && k.network === 'eip155:57073',
    ),
  );
  assert.ok(body.signers?.['eip155:57073']?.length === 1);
});

await check('POST /verify over HTTP', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { isValid: boolean; payer?: string };
  assert.equal(body.isValid, true);
  assert.equal(body.payer, getAddress(payer.address));
});

await check('POST /settle without settler key -> 503', async () => {
  const noKeyConfig = loadConfig({ ...process.env, FOUR02_SETTLER_KEY: undefined });
  const app = createApp(noKeyConfig, new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle', {
    method: 'POST',
    headers: SETTLE_HEADERS,
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { success: boolean; errorReason: string };
  assert.equal(body.success, false);
  assert.equal(body.errorReason, 'missing_settler_key');
});

await check('GET /demo/data without payment -> 402 + PAYMENT-REQUIRED', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const res = await app.request('/demo/data');
  assert.equal(res.status, 402);
  const header = res.headers.get('PAYMENT-REQUIRED');
  assert.ok(header, 'missing PAYMENT-REQUIRED header');
  const pr = JSON.parse(Buffer.from(header as string, 'base64').toString('utf8')) as {
    x402Version: number;
    accepts: { scheme: string; network: string; asset: string }[];
  };
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.accepts[0].scheme, 'exact');
  assert.equal(pr.accepts[0].network, 'eip155:57073');
  assert.equal(getAddress(pr.accepts[0].asset), getAddress(USDC_ADDRESS));
});

await check('GET /demo/data with valid PAYMENT-SIGNATURE -> 200 (dry-run)', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  // The demo builds its own requirements; sign against those exact terms.
  const demoReqs = (
    await (async () => {
      const noPay = await app.request('/demo/data');
      const h = noPay.headers.get('PAYMENT-REQUIRED') as string;
      return (
        JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as {
          accepts: PaymentRequirements[];
        }
      ).accepts[0];
    })()
  );
  const exact = await signAuthorization(INK_CONFIG, payerKey, {
    from: payer.address,
    to: getAddress(demoReqs.payTo),
    value: BigInt(demoReqs.amount),
    validAfter: 0n,
    validBefore: BigInt(now() + 300),
    nonce: randomNonce(),
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: demoReqs,
    payload: exact,
  };
  const sigB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const res = await app.request('/demo/data', {
    headers: { 'PAYMENT-SIGNATURE': sigB64 },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { dataset?: object; dryRun?: boolean };
  assert.ok(body.dataset, 'expected demo dataset');
  assert.equal(body.dryRun, true);
  assert.ok(res.headers.get('PAYMENT-RESPONSE'), 'missing PAYMENT-RESPONSE header');
});

// ---------- regression tests: 2026-09-22 audit fixes ----------

await check('H1: /verify does not consume the nonce — /settle proceeds after /verify', async () => {
  const store = new NonceStore();
  const app = createApp(loadConfig(), store);
  const r = await signedRequest();
  const nonce = r.paymentPayload.payload.authorization.nonce;

  const vres = await app.request('/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  });
  assert.equal(vres.status, 200);
  const vbody = (await vres.json()) as { isValid: boolean; invalidReason: string };
  assert.equal(vbody.isValid, true, vbody.invalidReason);

  // /verify must be read-only: the nonce is NOT consumed.
  assert.equal(store.has(INK_CONFIG.chainId, nonce, now()), false, '/verify consumed the nonce');

  // The standard x402 flow now works: /settle gets past the nonce check.
  // (dry-run returns dry_run_mode whether or not the simulation passes —
  // the regression is that it is NOT nonce_replay.)
  const sres = await app.request('/settle', {
    method: 'POST',
    headers: SETTLE_HEADERS,
    body: JSON.stringify(r),
  });
  assert.equal(sres.status, 200);
  const sbody = (await sres.json()) as { success: boolean; errorReason: string };
  assert.notEqual(sbody.errorReason, 'nonce_replay', 'H1 regression: /settle rejected after /verify');
  assert.equal(sbody.errorReason, 'dry_run_mode');
});

await check('H2: NonceStore survives past 10,000 entries (sweep uses real time)', async () => {
  const store = new NonceStore();
  const future = now() + 3600;
  const nonces: string[] = [];
  for (let i = 0; i < 10_001; i++) {
    const n = randomNonce();
    nonces.push(n);
    store.mark(INK_CONFIG.chainId, n, future);
  }
  assert.equal(store.size, 10_001, 'store wiped itself at 10k entries');
  for (const n of nonces) {
    assert.equal(store.has(INK_CONFIG.chainId, n, now()), true, 'live nonce evicted');
  }
});

await check('H2: sweep still evicts genuinely expired entries', async () => {
  const store = new NonceStore();
  const past = now() - 3600;
  for (let i = 0; i < 10_000; i++) {
    store.mark(INK_CONFIG.chainId, randomNonce(), past);
  }
  // The 10,000th mark triggers the sweep, which must clear expired entries.
  assert.equal(store.size, 0, 'expired entries were not swept');
});

async function demoSignedPayloadB64(): Promise<string> {
  const app = createApp(loadConfig(), new NonceStore());
  const noPay = await app.request('/demo/data');
  const h = noPay.headers.get('PAYMENT-REQUIRED') as string;
  const demoReqs = (
    JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as {
      accepts: PaymentRequirements[];
    }
  ).accepts[0];
  const exact = await signAuthorization(INK_CONFIG, payerKey, {
    from: payer.address,
    to: getAddress(demoReqs.payTo),
    value: BigInt(demoReqs.amount),
    validAfter: 0n,
    validBefore: BigInt(now() + 300),
    nonce: randomNonce(),
  });
  const payload: PaymentPayload = { x402Version: 2, accepted: demoReqs, payload: exact };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

await check('L1: demo dry-run consumes the nonce — same signature twice is denied', async () => {
  const store = new NonceStore();
  const app = createApp(loadConfig(), store);
  const sigB64 = await demoSignedPayloadB64();
  const first = await app.request('/demo/data', {
    headers: { 'PAYMENT-SIGNATURE': sigB64 },
  });
  assert.equal(first.status, 200);
  const second = await app.request('/demo/data', {
    headers: { 'PAYMENT-SIGNATURE': sigB64 },
  });
  assert.equal(second.status, 402, 'replayed demo signature was granted again');
  const body = (await second.json()) as { invalidReason?: string };
  assert.equal(body.invalidReason, 'nonce_replay');
});

await check('L3: /settle rate limit returns 429 when exceeded', async () => {
  const app = createApp(loadConfig(), new NonceStore(), {
    rateLimits: { settle: { windowMs: 60_000, max: 2 } },
  });
  const r = await signedRequest();
  const post = () =>
    app.request('/settle', {
      method: 'POST',
      headers: SETTLE_HEADERS,
      body: JSON.stringify(r),
    });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const limited = await post();
  assert.equal(limited.status, 429);
  const body = (await limited.json()) as { error: string };
  assert.equal(body.error, 'rate_limited');
  assert.ok(limited.headers.get('Retry-After'), 'missing Retry-After header');
});

await check('L3: oversized JSON body is rejected with 413', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const big = { ...r, padding: 'x'.repeat(100_000) };
  const res = await app.request('/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(big),
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { isValid: boolean; invalidReason: string };
  assert.equal(body.invalidReason, 'body_too_large');
});

// ---------- M1: /settle API-key allowlist ----------

await check('M1: /settle without API key -> 401', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { success: boolean; errorReason: string };
  assert.equal(body.success, false);
  assert.equal(body.errorReason, 'unauthorized');
});

await check('M1: /settle with wrong API key -> 401', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong-key' },
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { errorReason: string };
  assert.equal(body.errorReason, 'unauthorized');
});

await check('M1: /settle with valid API key proceeds (dry-run)', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle', {
    method: 'POST',
    headers: SETTLE_HEADERS,
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { success: boolean; errorReason: string };
  assert.equal(body.errorReason, 'dry_run_mode');
});

await check('M1: /settle accepts Authorization: Bearer key', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-settle-key',
    },
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 200);
});

await check('M1: /settle accepts ?api_key= query param', async () => {
  const app = createApp(loadConfig(), new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle?api_key=test-settle-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 200);
});

await check('M1: /settle fail-closed when no keys configured -> 503', async () => {
  const cfg = loadConfig({ ...process.env, FOUR02_SETTLE_API_KEYS: '' });
  const app = createApp(cfg, new NonceStore());
  const r = await signedRequest();
  const res = await app.request('/settle', {
    method: 'POST',
    headers: SETTLE_HEADERS, // even a "valid" key can't help: none configured
    body: JSON.stringify(r),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { success: boolean; errorReason: string };
  assert.equal(body.success, false);
  assert.equal(body.errorReason, 'settle_auth_not_configured');
});

console.log(`\n${passed} facilitator tests passed${process.exitCode ? ' (with failures)' : ''}`);
