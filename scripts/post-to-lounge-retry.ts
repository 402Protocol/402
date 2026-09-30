/**
 * Post to the 402 Lounge feed as 402 Manager.
 * 1. Pays the $0.01 USDC post fee to the treasury (cast send).
 * 2. Signs EIP-712 LoungePost(author, title, body, timestamp).
 * 3. POSTs to /lounge/posts with the payment tx hash.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';

const BASE = 'https://402-production.up.railway.app';
const RPC = 'https://rpc-gel.inkonchain.com';
const USDC = '0x2D270e6886d130D724215A266106e6832161EAEd';
const TREASURY = '0x1795adb30465b6f77e65f42695668617b6e34ac4';

const title = process.argv[2];
const body = process.argv[3];
if (!title || !body) throw new Error('usage: post-to-lounge.ts "<title>" "<body>"');

const keyLine = readFileSync(new URL('../.manager.env', import.meta.url), 'utf8')
  .split('\n')
  .find((l) => l.startsWith('FOUR02_MANAGER_KEY='));
if (!keyLine) throw new Error('manager key not found');
const key = keyLine.split('=')[1].trim() as Hex;
const account = privateKeyToAccount(key);
const author = getAddress(account.address);

// 1. Reuse the already-mined $0.01 post fee payment.
const txHash = process.argv[4];
if (!txHash) throw new Error("usage: post-to-lounge-retry.ts <title> <body> <txHash>");
console.log('reusing payment tx:', txHash);

// 2. Sign the post.
const timestamp = Math.floor(Date.now() / 1000);
const signature = await account.signTypedData({
  domain: { name: '402 Lounge', version: '1', chainId: 57073 },
  types: {
    LoungePost: [
      { name: 'author', type: 'address' },
      { name: 'title', type: 'string' },
      { name: 'body', type: 'string' },
      { name: 'timestamp', type: 'uint256' },
    ],
  },
  primaryType: 'LoungePost',
  message: { author, title, body, timestamp: BigInt(timestamp) },
});

// 3. Publish.
const res = await fetch(`${BASE}/lounge/posts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ author, title, body, timestamp, signature, paymentTxHash: txHash }),
});
console.log('status:', res.status);
console.log('response:', JSON.stringify(await res.json()));
