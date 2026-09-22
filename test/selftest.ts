/**
 * Phase 1 self-test: sign -> verify -> tamper/expiry/wrong-token cases.
 * Uses a throwaway key; touches no network. Exit nonzero on any failure.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseUnits } from 'viem';
import { CHAIN_ID, USDC_ADDRESS, ZERO_ADDRESS } from '../src/constants.js';
import {
  hashTerms,
  parseSignedInvoice,
  serializeSignedInvoice,
  signInvoice,
  verifyInvoice,
  type Invoice,
} from '../src/invoice.js';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const issuerKey = generatePrivateKey();
const issuer = privateKeyToAccount(issuerKey).address;
const otherKey = generatePrivateKey();

function baseInvoice(): Invoice {
  return {
    issuer,
    payer: ZERO_ADDRESS,
    token: USDC_ADDRESS,
    amount: parseUnits('2.50', 6),
    chainId: BigInt(CHAIN_ID),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: 123456789n,
    description: 'test: 10k API calls',
    termsHash: hashTerms('test terms v1'),
  };
}

// 1. happy path
const signed = await signInvoice(baseInvoice(), issuerKey);
const v1 = await verifyInvoice(signed);
check('valid invoice verifies', v1.valid && v1.signer?.toLowerCase() === issuer.toLowerCase(), JSON.stringify(v1.errors));

// 2. id is stable and content-addressed
const v1b = await verifyInvoice({ ...signed });
check('id matches payload hash', v1b.valid, 'recomputed id check');

// 3. tampered amount breaks the signature
const tampered = { ...signed, invoice: { ...signed.invoice, amount: parseUnits('999', 6) } };
const v3 = await verifyInvoice(tampered);
check('tampered amount rejected', !v3.valid, v3.errors.join('; '));

// 4. tampered id rejected
const badId = { ...signed, id: '0x0000000000000000000000000000000000000000000000000000000000000000' as const };
const v4 = await verifyInvoice(badId);
check('tampered id rejected', !v4.valid, v4.errors.join('; '));

// 5. expired invoice rejected
const expiredInv = { ...baseInvoice(), expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10) };
const signedExpired = await signInvoice(expiredInv, issuerKey);
const v5 = await verifyInvoice(signedExpired);
check('expired invoice rejected', !v5.valid, v5.errors.join('; '));

// 6. wrong token rejected
const wrongToken = { ...baseInvoice(), token: '0x0000000000000000000000000000000000000001' as const };
const signedWrongToken = await signInvoice(wrongToken, issuerKey);
const v6 = await verifyInvoice(signedWrongToken);
check('wrong token rejected', !v6.valid, v6.errors.join('; '));

// 7. wrong chain rejected
const wrongChain = { ...baseInvoice(), chainId: 1n };
const signedWrongChain = await signInvoice(wrongChain, issuerKey);
const v7 = await verifyInvoice(signedWrongChain);
check('wrong chainId rejected', !v7.valid, v7.errors.join('; '));

// 8. key/issuer mismatch refused at signing time
let mismatchThrew = false;
try {
  await signInvoice(baseInvoice(), otherKey);
} catch {
  mismatchThrew = true;
}
check('signing with non-issuer key throws', mismatchThrew);

// 9. zero nonce rejected
const zeroNonce = { ...baseInvoice(), nonce: 0n };
const signedZeroNonce = await signInvoice(zeroNonce, issuerKey);
const v9 = await verifyInvoice(signedZeroNonce);
check('zero nonce rejected', !v9.valid, v9.errors.join('; '));

// 10. serialize/parse round trip preserves validity
const roundTripped = parseSignedInvoice(serializeSignedInvoice(signed));
check('JSON round trip parses cleanly', roundTripped.ok, !roundTripped.ok ? roundTripped.error : '');
const v10 = roundTripped.ok ? await verifyInvoice(roundTripped.signed) : { valid: false, errors: ['parse failed'] };
check('JSON round trip stays valid', v10.valid, v10.errors.join('; '));

// 11. L2: garbage input fails soft with a structured error, never throws
for (const [label, garbage] of [
  ['not JSON', 'this is not json{'],
  ['JSON array', '[1,2,3]'],
  ['missing invoice', '{"signature":"0x1234","id":"0x' + 'ab'.repeat(32) + '"}'],
  ['bad signature', '{"invoice":{},"signature":"nope","id":"0x' + 'ab'.repeat(32) + '"}'],
  ['bad bigint', '{"invoice":{"amount":"zzz"},"signature":"0x1234","id":"0x' + 'ab'.repeat(32) + '"}'],
] as const) {
  const r = parseSignedInvoice(garbage);
  check(`parse fails soft on ${label}`, !r.ok && typeof r.error === 'string' && r.error.length > 0, r.ok ? 'unexpectedly ok' : r.error);
}

console.log(failures === 0 ? '\nAll self-tests passed.' : `\n${failures} self-test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
