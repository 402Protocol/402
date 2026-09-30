/**
 * First live 402 settlement — a $0.001 USDC oracle query on Ink.
 *
 * RUN THIS ON YOUR OWN MACHINE. Your keys never leave it.
 *
 *   PAYER_KEY=0x... FOUR02_API_KEY=... npx tsx scripts/first-live-settlement.ts
 *
 * PAYER_KEY: private key of a wallet holding a little USDC on Ink (even $0.01
 *   covers this hundreds of times over). This wallet SIGNS the payment.
 * FOUR02_API_KEY: the settle API key (server-side allowlist, stays in headers).
 *
 * What happens:
 *   1. Asks /oracle/price for ETH -> gets a 402 payment challenge.
 *   2. Signs an EIP-3009 TransferWithAuthorization for $0.001 USDC.
 *   3. Resubmits with PAYMENT-SIGNATURE -> the server broadcasts the REAL
 *      settlement onchain (dry-run is OFF). $0.001 USDC moves payer -> 402.
 *   4. Prints the tx hash + explorer link.
 */
import { createPublicClient, formatUnits, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const API = 'https://402-production.up.railway.app';
const INK_RPC = 'https://rpc-gel.inkonchain.com';
const USDC = '0x2D270e6886d130D724215A266106e6832161EAEd';
const CHAIN_ID = 57073;

const payerKey = process.env.PAYER_KEY as `0x${string}` | undefined;
const apiKey = process.env.FOUR02_API_KEY;
if (!payerKey || !/^0x[0-9a-fA-F]{64}$/.test(payerKey)) {
  console.error('Set PAYER_KEY=0x... (64 hex chars) — a USDC-funded wallet on Ink.');
  process.exit(1);
}
if (!apiKey) {
  console.error('Set FOUR02_API_KEY=... (the settle API key).');
  process.exit(1);
}

const account = privateKeyToAccount(payerKey);
const client = createPublicClient({ transport: http(INK_RPC) });

// --- 0. sanity: payer holds enough USDC -------------------------------------
const balance = (await client.readContract({
  address: USDC,
  abi: [
    {
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'a', type: 'address' }],
      outputs: [{ type: 'uint256' }],
    },
  ],
  functionName: 'balanceOf',
  args: [account.address],
})) as bigint;
console.log(`payer: ${account.address}`);
console.log(`USDC balance: ${formatUnits(balance, 6)}`);

// --- 1. get the 402 challenge ----------------------------------------------
const challengeRes = await fetch(`${API}/oracle/price?symbol=ETH`, {
  headers: { 'x-api-key': apiKey },
});
if (challengeRes.status !== 402) {
  console.error(`expected 402 challenge, got ${challengeRes.status}:`, await challengeRes.text());
  process.exit(1);
}
const challenge = (await challengeRes.json()) as any;
const req = challenge.x402?.accepts?.[0];
if (!req || req.scheme !== 'exact' || req.asset?.toLowerCase() !== USDC.toLowerCase()) {
  console.error('unexpected challenge shape:', JSON.stringify(challenge).slice(0, 300));
  process.exit(1);
}
const amount = BigInt(req.amount);
console.log(`challenge: pay ${formatUnits(amount, 6)} USDC to ${req.payTo}`);
if (balance < amount) {
  console.error('payer USDC balance is lower than the required amount — fund it first.');
  process.exit(1);
}

// --- 2. sign the EIP-3009 authorization --------------------------------------
const now = Math.floor(Date.now() / 1000);
const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')}` as `0x${string}`;
const authorization = {
  from: account.address,
  to: req.payTo as `0x${string}`,
  value: amount,
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + 120),
  nonce,
};
const signature = await account.signTypedData({
  domain: {
    name: 'USDC',
    version: '2',
    chainId: CHAIN_ID,
    verifyingContract: USDC,
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: authorization,
});
console.log('authorization signed.');

// --- 3. submit with PAYMENT-SIGNATURE -> real onchain settlement --------------
const payload = {
  x402Version: 2,
  accepted: req,
  payload: {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  },
};
const paidRes = await fetch(`${API}/oracle/price?symbol=ETH`, {
  headers: {
    'x-api-key': apiKey,
    'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64'),
  },
});
const paymentResponse = paidRes.headers.get('PAYMENT-RESPONSE');
const body = await paidRes.json().catch(() => ({}));
if (paidRes.status !== 200 || !paymentResponse) {
  console.error(`settlement failed (http ${paidRes.status}):`, JSON.stringify(body).slice(0, 500));
  process.exit(1);
}
const settled = JSON.parse(Buffer.from(paymentResponse, 'base64').toString());
if (!settled.success || !settled.transaction) {
  console.error('settlement not successful:', JSON.stringify(settled).slice(0, 500));
  process.exit(1);
}

// --- 4. receipt ---------------------------------------------------------------
console.log('\nSETTLED ✅');
console.log(`tx:      ${settled.transaction}`);
console.log(`payer:   ${settled.payer}`);
console.log(`network: ${settled.network}`);
console.log(`view:    https://explorer.inkonchain.com/tx/${settled.transaction}`);
console.log(`price:   $${(body as any)?.price ?? (body as any)?.data?.price ?? 'see response above'}`);
