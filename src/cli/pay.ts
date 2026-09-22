/**
 * pay_invoice — verify a 402 invoice, then pay it in native USDC on Ink.
 *
 * EXPLICIT APPROVAL REQUIRED. Default is a dry run that only prints the
 * transfer plan. Add --broadcast to actually submit — the agent must only do
 * this after the user approves that exact payment in chat.
 *
 * The invoice is ALWAYS verified first (signature, token, chain, amount,
 * expiry). Verification failure aborts before anything is built.
 *
 *   npx tsx src/cli/pay.ts --invoice invoice.json [--broadcast] [--rpc URL]
 */
import { readFileSync } from 'node:fs';
import { createWalletClient, formatUnits, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  INK_RPC_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ZERO_ADDRESS,
  ink,
} from '../constants.js';
import {
  parseSignedInvoice,
  verifyInvoice,
} from '../invoice.js';
import { usdcTransferAbi } from '../settle.js';
import { flag, keyFromEnv, optional, parseArgs, required } from './args.js';

const args = parseArgs();
const invoicePath = required(args, 'invoice');
const broadcast = flag(args, 'broadcast');
const rpcUrl = optional(args, 'rpc', INK_RPC_URL);

const parsed = parseSignedInvoice(readFileSync(invoicePath, 'utf8'));
if (!parsed.ok) {
  console.error(`could not parse invoice: ${parsed.error}`);
  process.exit(1);
}
const signed = parsed.signed;
const { valid, signer, errors } = await verifyInvoice(signed);

console.error(`invoice ${signed.id}`);
if (!valid) {
  console.error('VERIFICATION FAILED — refusing to pay:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.error(`signature OK (recovered signer ${signer})`);

const inv = signed.invoice;
const payerKey = keyFromEnv('FOUR02_PAYER_KEY');
const payer = privateKeyToAccount(payerKey).address;

if (
  getAddress(inv.payer) !== getAddress(ZERO_ADDRESS) &&
  getAddress(inv.payer) !== getAddress(payer)
) {
  console.error(
    `invoice is addressed to ${inv.payer}, not to payer ${payer} — refusing to pay`,
  );
  process.exit(1);
}

console.error('--- payment plan ---');
console.error(`  pay:      ${formatUnits(inv.amount, USDC_DECIMALS)} USDC`);
console.error(`  to:       ${inv.issuer} (issuer)`);
console.error(`  from:     ${payer} (payer)`);
console.error(`  token:    ${USDC_ADDRESS}`);
console.error(`  chain:    Ink (57073)`);
console.error(`  expires:  ${new Date(Number(inv.expiresAt) * 1000).toISOString()}`);

if (!broadcast) {
  console.error('---');
  console.error('DRY RUN — nothing broadcast. Re-run with --broadcast after explicit user approval.');
  process.exit(0);
}

const wallet = createWalletClient({
  account: privateKeyToAccount(payerKey),
  chain: ink,
  transport: http(rpcUrl),
});
const hash = await wallet.writeContract({
  address: USDC_ADDRESS,
  abi: usdcTransferAbi,
  functionName: 'transfer',
  args: [inv.issuer, inv.amount],
});
console.error('---');
console.error(`broadcast OK: ${hash}`);
console.log(hash);
