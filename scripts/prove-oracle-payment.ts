/**
 * Live pay-per-call proof for the 402 oracle on Railway (dry-run mode).
 * Signs a real EIP-3009 TransferWithAuthorization ($0.001 USDC) with the
 * 402 Manager key, sends it as PAYMENT-SIGNATURE, and prints what comes back.
 * In dry-run the facilitator verifies the signature and serves the data
 * WITHOUT broadcasting — no USDC moves. Flip FOUR02_DRY_RUN off (founder)
 * for the real settlement path.
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';
import {
  signAuthorization,
  randomNonce,
} from '../src/facilitator/eip3009.js';
import { INK_CONFIG } from '../src/facilitator/chains.js';
import type {
  PaymentPayload,
  PaymentRequirements,
} from '../src/facilitator/types.js';

const BASE = 'https://402-production.up.railway.app';
const SYMBOL = process.argv[2] ?? 'ETH';

const keyLine = readFileSync(
  new URL('../.manager.env', import.meta.url),
  'utf8',
)
  .split('\n')
  .find((l) => l.startsWith('FOUR02_MANAGER_KEY='));
if (!keyLine) throw new Error('manager key not found');
const payerKey = keyLine.split('=')[1].trim() as Hex;
const payer = privateKeyToAccount(payerKey).address;

// 1. Fetch the 402 challenge to get the exact payment requirements.
const challengeRes = await fetch(`${BASE}/oracle/price?symbol=${SYMBOL}`);
const challenge = (await challengeRes.json()) as any;
if (!challenge?.x402?.accepts?.[0]) {
  throw new Error(`no 402 challenge: ${JSON.stringify(challenge).slice(0, 200)}`);
}
const req: PaymentRequirements = challenge.x402.accepts[0];
console.log('challenge: pay', req.amount, 'base units to', req.payTo);

// 2. Sign the EIP-3009 authorization with the manager key.
const now = Math.floor(Date.now() / 1000);
const auth = await signAuthorization(INK_CONFIG, payerKey, {
  from: getAddress(payer),
  to: getAddress(req.payTo),
  value: BigInt(req.amount),
  validAfter: 0n,
  validBefore: BigInt(now + 120),
  nonce: randomNonce(),
});

const payload: PaymentPayload = {
  x402Version: 2,
  resource: { url: `/oracle/price?symbol=${SYMBOL}` },
  accepted: req,
  payload: {
    signature: auth.signature,
    authorization: {
      from: getAddress(payer),
      to: getAddress(req.payTo),
      value: req.amount,
      validAfter: '0',
      validBefore: String(now + 120),
      nonce: auth.authorization.nonce,
    },
  },
};
const header = Buffer.from(JSON.stringify(payload)).toString('base64');

// 3. Pay the oracle.
const res = await fetch(`${BASE}/oracle/price?symbol=${SYMBOL}`, {
  headers: { 'PAYMENT-SIGNATURE': header },
});
const payResponse = res.headers.get('PAYMENT-RESPONSE');
console.log('status:', res.status);
console.log('PAYMENT-RESPONSE:', payResponse);
console.log('data:', JSON.stringify(await res.json(), null, 2));
