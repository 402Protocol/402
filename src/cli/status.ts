/**
 * invoice_status — verify a 402 invoice and check whether it looks paid.
 *
 * Read-only: no approval needed. Payment detection is heuristic (USDC
 * Transfer events to the issuer >= amount) — report "likely paid", never
 * certain, unless the founder confirms out of band.
 *
 *   npx tsx src/cli/status.ts --invoice invoice.json [--from-block N] [--rpc URL]
 */
import { readFileSync } from 'node:fs';
import { formatUnits, getAddress } from 'viem';
import {
  INK_RPC_URL,
  USDC_DECIMALS,
  ZERO_ADDRESS,
} from '../constants.js';
import { parseSignedInvoice, verifyInvoice } from '../invoice.js';
import { findUsdcTransfers, latestBlock } from '../settle.js';
import { optional, parseArgs, required } from './args.js';

const args = parseArgs();
const invoicePath = required(args, 'invoice');
const rpcUrl = optional(args, 'rpc', INK_RPC_URL);

const parsed = parseSignedInvoice(readFileSync(invoicePath, 'utf8'));
if (!parsed.ok) {
  console.log(JSON.stringify({ valid: false, errors: [`could not parse invoice: ${parsed.error}`] }, null, 2));
  process.exit(1);
}
const signed = parsed.signed;
const { valid, signer, errors } = await verifyInvoice(signed);
const inv = signed.invoice;

const nowSec = Math.floor(Date.now() / 1000);
const report: Record<string, unknown> = {
  id: signed.id,
  valid,
  signer,
  errors,
  issuer: inv.issuer,
  payer: inv.payer,
  amountUsdc: formatUnits(inv.amount, USDC_DECIMALS),
  expiresAt: new Date(Number(inv.expiresAt) * 1000).toISOString(),
  expired: inv.expiresAt <= BigInt(nowSec),
  description: inv.description,
};

if (valid) {
  const head = await latestBlock(rpcUrl);
  const fromBlockArg = args['from-block'];
  const fromBlock =
    typeof fromBlockArg === 'string' && fromBlockArg
      ? BigInt(fromBlockArg)
      : head - 50_000n > 0n
        ? head - 50_000n
        : 0n;
  const hits = await findUsdcTransfers({
    to: inv.issuer,
    from:
      getAddress(inv.payer) === getAddress(ZERO_ADDRESS)
        ? undefined
        : inv.payer,
    minAmount: inv.amount,
    fromBlock,
    rpcUrl,
  });
  report.payment = {
    scannedFromBlock: fromBlock.toString(),
    scannedToBlock: head.toString(),
    matchingTransfers: hits.map((h) => ({
      txHash: h.txHash,
      blockNumber: h.blockNumber.toString(),
      from: h.from,
      valueUsdc: formatUnits(h.value, USDC_DECIMALS),
    })),
    verdict:
      hits.length > 0
        ? 'likely paid (matching USDC transfer found)'
        : 'no matching USDC transfer found in scanned range',
  };
}

console.log(JSON.stringify(report, null, 2));
