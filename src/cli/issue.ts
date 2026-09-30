/**
 * issue_invoice — create and EIP-712-sign a 402 invoice.
 *
 * Implicit approval: this creates a payment *request* and spends nothing.
 * Signs with FOUR02_ISSUER_KEY from env (never a CLI arg, never in chat).
 *
 *   npx tsx src/cli/issue.ts --issuer 0x... --amount 1.50 --description "..."
 *     [--payer 0x...] [--terms "full terms text" | --terms-hash 0x...]
 *     [--expires-in 86400] [--nonce 123] [--out invoice.json]
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseUnits } from 'viem';
import { CHAIN_ID, USDC_ADDRESS, USDC_DECIMALS, ZERO_ADDRESS } from '../constants.js';
import {
  hashTerms,
  serializeSignedInvoice,
  signInvoice,
  type Invoice,
} from '../invoice.js';
import { keyFromEnv, optional, parseArgs, required } from './args.js';

const args = parseArgs();
const issuer = required(args, 'issuer');
const amountHuman = required(args, 'amount');
const description = required(args, 'description');

const payer = optional(args, 'payer', ZERO_ADDRESS);
const terms = args['terms'];
const termsHashArg = args['terms-hash'];
const expiresIn = BigInt(optional(args, 'expires-in', '86400'));
const out = args['out'];

let termsHash: `0x${string}`;
if (typeof termsHashArg === 'string' && termsHashArg) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(termsHashArg)) {
    console.error('--terms-hash must be bytes32');
    process.exit(1);
  }
  termsHash = termsHashArg.toLowerCase() as `0x${string}`;
} else if (typeof terms === 'string' && terms) {
  termsHash = hashTerms(terms);
} else {
  console.error('provide --terms "..." or --terms-hash 0x... (terms must be hashed into the invoice)');
  process.exit(1);
}

let amount: bigint;
try {
  amount = parseUnits(amountHuman, USDC_DECIMALS);
} catch {
  console.error(`--amount "${amountHuman}" is not a valid decimal number`);
  process.exit(1);
}
if (amount <= 0n) {
  console.error('--amount must be positive');
  process.exit(1);
}

let nonce: bigint;
const nonceArg = args['nonce'];
if (typeof nonceArg === 'string' && nonceArg) {
  nonce = BigInt(nonceArg);
} else {
  nonce = BigInt('0x' + randomBytes(32).toString('hex')) || 1n;
}

const invoice: Invoice = {
  issuer: issuer as `0x${string}`,
  payer: payer as `0x${string}`,
  token: USDC_ADDRESS,
  amount,
  chainId: BigInt(CHAIN_ID),
  expiresAt: BigInt(Math.floor(Date.now() / 1000)) + expiresIn,
  nonce,
  description,
  termsHash,
};

const key = keyFromEnv('FOUR02_ISSUER_KEY');
const signed = await signInvoice(invoice, key);
const json = serializeSignedInvoice(signed);

if (typeof out === 'string' && out) {
  writeFileSync(out, json + '\n');
  console.error(`wrote ${out}`);
}
console.log(json);
