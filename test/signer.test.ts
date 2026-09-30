/**
 * Turnkey signer unit tests — Phase 2.
 *
 * All network is mocked. No real Turnkey calls, no real keys: the keypair is
 * generated fresh per run.
 *
 * Run: npx tsx test/signer.test.ts   (or: npm run test:signer)
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  TurnkeySigner,
  encodeUnsignedEip1559,
  assertSignableTx,
  SIGNABLE_CHAIN_IDS,
  type UnsignedEip1559Tx,
} from '../src/taap/signer.js';

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

// ---- fresh P-256 keypair per run (never leaves this process) ----

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privJwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
const xHex = Buffer.from(privJwk.x, 'base64url').toString('hex');
const yHex = Buffer.from(privJwk.y, 'base64url').toString('hex');
const privHex = Buffer.from(privJwk.d, 'base64url').toString('hex');
// Compressed pubkey: 0x02/0x03 prefix by y parity.
const pubCompressed = (parseInt(yHex.slice(-1), 16) % 2 === 0 ? '02' : '03') + xHex;
// NB: verify with the KeyObject directly — a raw DER buffer needs explicit format opts.

function makeSigner(fetchImpl?: any) {
  return new TurnkeySigner(
    { orgId: 'org-test', apiPublicKey: pubCompressed, apiPrivateKeyHex: privHex },
    fetchImpl ? { fetchImpl } : {},
  );
}

const GOOD_TX: UnsignedEip1559Tx = {
  chainId: 57073,
  nonce: '0x0',
  maxFeePerGas: '0x3b9aca00',
  maxPriorityFeePerGas: '0x3b9aca00',
  gas: '0x5208',
  to: '0x2222222222222222222222222222222222222222',
  value: '0x0',
  data: '0x',
};

// Minimal RLP reader for the round-trip test.
function rlpDecode(buf: Uint8Array<ArrayBufferLike>): { value: Uint8Array<ArrayBufferLike> | unknown[]; rest: Uint8Array<ArrayBufferLike> } {
  const b0 = buf[0];
  if (b0 < 0x80) return { value: buf.slice(0, 1), rest: buf.slice(1) };
  if (b0 <= 0xb7) {
    const len = b0 - 0x80;
    return { value: buf.slice(1, 1 + len), rest: buf.slice(1 + len) };
  }
  if (b0 <= 0xbf) {
    const ll = b0 - 0xb7;
    const len = parseInt(Buffer.from(buf.slice(1, 1 + ll)).toString('hex'), 16);
    return { value: buf.slice(1 + ll, 1 + ll + len), rest: buf.slice(1 + ll + len) };
  }
  if (b0 <= 0xf7) {
    const len = b0 - 0xc0;
    let items: unknown[] = [];
    let rest: Uint8Array<ArrayBufferLike> = buf.slice(1, 1 + len);
    while (rest.length > 0) {
      const r = rlpDecode(rest);
      items.push(r.value);
      rest = r.rest;
    }
    return { value: items, rest: buf.slice(1 + len) };
  }
  const ll = b0 - 0xf7;
  const len = parseInt(Buffer.from(buf.slice(1, 1 + ll)).toString('hex'), 16);
  let items: unknown[] = [];
  let rest: Uint8Array<ArrayBufferLike> = buf.slice(1 + ll, 1 + ll + len);
  while (rest.length > 0) {
    const r = rlpDecode(rest);
    items.push(r.value);
    rest = r.rest;
  }
  return { value: items, rest: buf.slice(1 + ll + len) };
}
const hex = (b: Uint8Array<ArrayBufferLike>) => '0x' + Buffer.from(b).toString('hex');

// ---------- tests ----------

await check('constructor rejects malformed keys', () => {
  assert.throws(() => new TurnkeySigner({ orgId: 'o', apiPublicKey: 'zz', apiPrivateKeyHex: privHex }), /apiPublicKey/);
  assert.throws(() => new TurnkeySigner({ orgId: 'o', apiPublicKey: pubCompressed, apiPrivateKeyHex: 'zz' }), /apiPrivateKeyHex/);
  assert.throws(() => new TurnkeySigner({ orgId: '', apiPublicKey: pubCompressed, apiPrivateKeyHex: privHex }), /orgId/);
});

await check('stamp builds a verifiable Turnkey P-256 stamp', () => {
  const signer = makeSigner();
  const body = JSON.stringify({ hello: 'world' });
  const stamp = signer.stamp(body);
  const decoded = JSON.parse(Buffer.from(stamp, 'base64url').toString('utf8'));
  assert.equal(decoded.publicKey, pubCompressed);
  assert.equal(decoded.scheme, 'SIGNATURE_SCHEME_TK_API_P256');
  assert.match(decoded.signature, /^[0-9a-f]+$/);
  // The signature actually verifies against the public key.
  const v = createVerify('sha256');
  v.update(body);
  v.end();
  assert.equal(v.verify(publicKey, Buffer.from(decoded.signature, 'hex')), true);
});

await check('encodeUnsignedEip1559 round-trips through RLP', () => {
  const enc = encodeUnsignedEip1559(GOOD_TX);
  assert.equal(enc[0], 0x02);
  const { value, rest } = rlpDecode(enc.slice(1));
  assert.equal(rest.length, 0);
  const fields = value as Uint8Array[];
  assert.equal(fields.length, 9);
  assert.equal(parseInt(hex(fields[0]).slice(2) || '0', 16), 57073);
  assert.equal(hex(fields[1]), '0x00'); // "0x0" zero-pads to a single 0x00 byte
  assert.equal(hex(fields[5]), GOOD_TX.to.toLowerCase());
  assert.equal(hex(fields[6]), '0x00'); // value "0x0" -> 0x00
  assert.equal(hex(fields[7]), '0x');
});

await check('assertSignableTx rejects non-allowlisted chains', () => {
  assert.throws(() => assertSignableTx({ ...GOOD_TX, chainId: 8453 }), /CHAIN_NOT_ALLOWLISTED/);
  for (const id of SIGNABLE_CHAIN_IDS) assertSignableTx({ ...GOOD_TX, chainId: id });
});

await check('assertSignableTx rejects malformed fields', () => {
  assert.throws(() => assertSignableTx({ ...GOOD_TX, to: '0x123' }), /tx\.to/);
  assert.throws(() => assertSignableTx({ ...GOOD_TX, nonce: '0xzz' }), /tx\.nonce/);
  assert.throws(() => assertSignableTx({ ...GOOD_TX, data: 'notahex' }), /tx\.data/);
  // Odd-length hex is fine — it gets zero-padded ("0x0" -> 0x00).
  assertSignableTx({ ...GOOD_TX, nonce: '0x0', value: '0x123' });
});

await check('signTransaction posts SIGN_TRANSACTION_V2 with the RLP-encoded tx', async () => {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const stubFetch = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ activity: { result: { signTransactionResult: { signedTransaction: '0x02f86a...' } } } }),
      text: async () => '',
    };
  };
  const signer = makeSigner(stubFetch);
  const signed = await signer.signTransaction('0x1111111111111111111111111111111111111111', GOOD_TX);
  assert.equal(signed, '0x02f86a...');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith('/public/v1/submit/sign_transaction'));
  assert.equal(seen[0].body.type, 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2');
  assert.equal(seen[0].body.parameters.signWith, '0x1111111111111111111111111111111111111111');
  assert.equal(seen[0].body.parameters.type, 'TRANSACTION_TYPE_ETHEREUM');
  const expectedUnsigned = Buffer.from(encodeUnsignedEip1559(GOOD_TX)).toString('hex');
  assert.equal(seen[0].body.parameters.unsignedTransaction, expectedUnsigned);
  assert.ok(seen[0].headers['X-Stamp'], 'X-Stamp header present');
  // The stamp verifies for this exact body.
  const stamp = JSON.parse(Buffer.from(seen[0].headers['X-Stamp'], 'base64url').toString('utf8'));
  const v = createVerify('sha256');
  v.update(JSON.stringify(seen[0].body));
  v.end();
  assert.equal(v.verify(publicKey, Buffer.from(stamp.signature, 'hex')), true);
});

await check('signTransaction throws when Turnkey omits the signed tx', async () => {
  const stubFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ activity: { result: {} } }),
    text: async () => '',
  });
  const signer = makeSigner(stubFetch);
  await assert.rejects(
    () => signer.signTransaction('0x1111111111111111111111111111111111111111', GOOD_TX),
    /signedTransaction missing/,
  );
});

await check('signTransaction surfaces Turnkey HTTP errors', async () => {
  const stubFetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'policy denied' });
  const signer = makeSigner(stubFetch);
  await assert.rejects(
    () => signer.signTransaction('0x1111111111111111111111111111111111111111', GOOD_TX),
    /HTTP 403/,
  );
});

await check('signAndBroadcast refuses non-allowlisted chain before any network', async () => {
  let calls = 0;
  const stubFetch = async () => { calls++; throw new Error('must not be called'); };
  const signer = makeSigner(stubFetch);
  await assert.rejects(
    () => signer.signAndBroadcast('0x1111111111111111111111111111111111111111', 'https://rpc.example', { ...GOOD_TX, chainId: 8453 }),
    /CHAIN_NOT_ALLOWLISTED/,
  );
  assert.equal(calls, 0);
});

await check('broadcast posts eth_sendRawTransaction and returns the hash', async () => {
  const seen: any[] = [];
  const stubFetch = async (_url: string, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}'));
    return {
      ok: true, status: 200,
      json: async () => ({ result: '0xdeadbeef' }),
      text: async () => '',
    };
  };
  const signer = makeSigner(stubFetch);
  const hash = await signer.broadcast('https://rpc.example', '0x02f86a');
  assert.equal(hash, '0xdeadbeef');
  assert.equal(seen[0].method, 'eth_sendRawTransaction');
  assert.deepEqual(seen[0].params, ['0x02f86a']);
});

await check('broadcast surfaces RPC errors', async () => {
  const stubFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ error: { message: 'insufficient funds' } }),
    text: async () => '',
  });
  const signer = makeSigner(stubFetch);
  await assert.rejects(() => signer.broadcast('https://rpc.example', '0x02f86a'), /insufficient funds/);
});

await check('getNonce posts eth_getTransactionCount', async () => {
  const seen: any[] = [];
  const stubFetch = async (_url: string, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}'));
    return { ok: true, status: 200, json: async () => ({ result: '0x5' }), text: async () => '' };
  };
  const signer = makeSigner(stubFetch);
  const nonce = await signer.getNonce('https://rpc.example', '0x1111111111111111111111111111111111111111');
  assert.equal(nonce, '0x5');
  assert.equal(seen[0].method, 'eth_getTransactionCount');
});

await check('no raw-payload signing path exists on the signer', () => {
  const signer = makeSigner();
  const proto = Object.getPrototypeOf(signer);
  const names = Object.getOwnPropertyNames(proto);
  assert.ok(!names.some((n) => /raw/i.test(n)), `found raw-related method: ${names.join(',')}`);
  assert.equal((signer as any).signRawPayload, undefined);
});

await check('keyFingerprint never contains key material', () => {
  const signer = makeSigner();
  assert.ok(!signer.keyFingerprint.includes(privHex.slice(0, 8)), 'fingerprint must not leak the private key');
  assert.ok(signer.keyFingerprint.length < pubCompressed.length, 'fingerprint is truncated');
});

console.log(`\n${passed} checks passed`);
