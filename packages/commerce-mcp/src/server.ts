#!/usr/bin/env node
/**
 * four02-commerce-mcp — agent-commerce MCP server (stdio).
 *
 * The commerce layer for the Ink agentic economy: EIP-712 invoices, invoice
 * payment plans, and onchain commerce-reputation reads. Designed to sit
 * alongside inkonchain-mcp: every tool is prefixed `four02_`, so there are
 * zero tool-name collisions.
 *
 * Key posture (same as the 402 protocol MCP server):
 *  - This server NEVER accepts a private key as a tool argument.
 *  - Signing keys come only from env (FOUR02_COMMERCE_*_KEY), and only when
 *    the operator explicitly configures them.
 *  - Nothing is ever broadcast by default. four02_invoice_pay returns a
 *    dry-run payment plan unless the caller passes approveBroadcast:true
 *    AND the operator configured FOUR02_COMMERCE_PAYER_KEY. Agents must only
 *    pass approveBroadcast:true after the human explicitly approved that
 *    exact payment in chat.
 *  - Reputation tools are pure reads against the deployed
 *    Four02ReputationRegistry on Ink mainnet.
 *
 * Run: npx four02-commerce-mcp        (once published)
 *      node dist/server.js            (local build)
 *      npm run dev                    (tsx, local dev)
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type Address,
  type Hex,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  CHAIN_ID,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ZERO_ADDRESS,
  ink,
  loadCommerceConfig,
  type CommerceConfig,
} from './config.js';
import {
  hashInvoice,
  normalizeInvoice,
  parseSignedInvoice,
  signInvoice,
  verifyInvoice,
  type Invoice,
} from './invoice.js';
import { findUsdcTransfers, latestBlock, publicClient, usdcTransferAbi } from './chain.js';
import {
  readHistory,
  readReliability,
  readSummary,
} from './reputation.js';

/** JSON with bigints rendered as decimal strings. */
function textResult(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string, detail?: unknown) {
  return textResult({ ok: false, error: message, ...(detail !== undefined ? { detail } : {}) });
}

const addressSchema = z
  .string()
  .refine((s) => isAddress(s), { message: 'must be a valid Ethereum address' });

const agentIdSchema = z
  .string()
  .refine((s) => /^\d+$/.test(s), { message: 'agentId must be a non-negative integer string' });

export function createCommerceServer(config: CommerceConfig): McpServer {
  const server = new McpServer(
    { name: 'four02-commerce', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ---- invoices ----

  server.registerTool(
    'four02_invoice_create',
    {
      description:
        'Create a 402 EIP-712 invoice for native USDC on Ink (chain 57073). Returns the canonical invoice plus its content-addressed id. If FOUR02_COMMERCE_INVOICE_KEY is configured and matches the issuer, the invoice is signed; otherwise it is returned unsigned with instructions to sign client-side (domain "402 Invoice", version "1").',
      inputSchema: {
        issuer: addressSchema.describe('Seller agent address (must match the signing key)'),
        payer: addressSchema
          .default(ZERO_ADDRESS)
          .describe('Buyer agent address; zero address = payable by anyone'),
        amountUsdc: z.string().describe('Amount in USDC, e.g. "1.50" (max 6 decimals)'),
        description: z.string().min(1).max(500).describe('Human-readable line item'),
        termsHash: z
          .string()
          .optional()
          .describe('Optional keccak256 of the full terms document (bytes32 hex); defaults to keccak256(description)'),
        expiresInSeconds: z
          .number()
          .int()
          .positive()
          .default(86400)
          .describe('Invoice lifetime in seconds from now'),
        nonce: z
          .string()
          .optional()
          .describe('Optional replay-protection nonce (decimal or 0x hex); random when omitted'),
      },
    },
    async (args) => {
      try {
        if (!/^\d+(\.\d{1,6})?$/.test(args.amountUsdc)) {
          return errorResult('amountUsdc must be a decimal like "1.50" (max 6 decimals)');
        }
        const termsHash = (args.termsHash ??
          keccak256(stringToHex(args.description))) as Hex;
        if (!/^0x[0-9a-fA-F]{64}$/.test(termsHash)) {
          return errorResult('termsHash must be bytes32 hex');
        }
        const invoice: Invoice = normalizeInvoice({
          issuer: getAddress(args.issuer),
          payer: getAddress(args.payer),
          token: getAddress(USDC_ADDRESS),
          amount: parseUnits(args.amountUsdc, USDC_DECIMALS),
          chainId: BigInt(CHAIN_ID),
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + args.expiresInSeconds),
          nonce: args.nonce
            ? BigInt(args.nonce)
            : BigInt(`0x${keccak256(stringToHex(`${Date.now()}:${args.description}`)).slice(2, 18)}`),
          description: args.description,
          termsHash,
        });
        const id = hashInvoice(invoice);

        // Optional server-side signing via env key (never a tool argument).
        if (config.invoiceSignerKey) {
          const signer = privateKeyToAccount(config.invoiceSignerKey).address;
          if (getAddress(signer) === invoice.issuer) {
            const signed = await signInvoice(invoice, config.invoiceSignerKey);
            return textResult({
              ok: true,
              signed: true,
              id: signed.id,
              signature: signed.signature,
              invoice: signed.invoice,
            });
          }
        }
        return textResult({
          ok: true,
          signed: false,
          id,
          invoice,
          howToSign:
            'Sign client-side with EIP-712: domain { name: "402 Invoice", version: "1", chainId: 57073 }, ' +
            'types Invoice(issuer, payer, token, amount, chainId, expiresAt, nonce, description, termsHash), ' +
            'then verify with four02_invoice_status.',
        });
      } catch (e) {
        return errorResult('four02_invoice_create failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'four02_invoice_status',
    {
      description:
        'Verify a signed 402 invoice (pure cryptography, no trust needed) and heuristically check whether it looks paid by scanning Ink USDC Transfer events to the issuer. Payment detection is a heuristic — "likely paid", never certain.',
      inputSchema: {
        signedInvoiceJson: z
          .string()
          .describe('The signed invoice JSON (as produced by four02_invoice_create)'),
        lookbackBlocks: z
          .number()
          .int()
          .positive()
          .max(500000)
          .default(50000)
          .describe('How many recent blocks to scan for payment'),
      },
    },
    async (args) => {
      try {
        const parsed = parseSignedInvoice(args.signedInvoiceJson);
        if (!parsed.ok) return errorResult('could not parse signed invoice', parsed.error);
        const signed = parsed.signed;
        const { valid, signer, errors } = await verifyInvoice(signed);
        const inv = signed.invoice;
        const report: Record<string, unknown> = {
          ok: true,
          id: signed.id,
          valid,
          signer,
          errors,
          issuer: inv.issuer,
          payer: inv.payer,
          amountUsdc: formatUnits(inv.amount, USDC_DECIMALS),
          expired: inv.expiresAt <= BigInt(Math.floor(Date.now() / 1000)),
          description: inv.description,
        };
        if (!valid) return textResult(report);
        try {
          const head = await latestBlock(config.inkRpcUrl);
          const fromBlock = head - BigInt(args.lookbackBlocks) > 0n ? head - BigInt(args.lookbackBlocks) : 0n;
          const isOpen = getAddress(inv.payer) === getAddress(ZERO_ADDRESS);
          const hits = await findUsdcTransfers({
            to: inv.issuer,
            ...(isOpen ? {} : { from: getAddress(inv.payer) }),
            minAmount: inv.amount,
            fromBlock,
            rpcUrl: config.inkRpcUrl,
          });
          report.payment = {
            likelyPaid: hits.length > 0,
            ...(isOpen ? { note: 'open invoice (any payer): transfers to issuer >= amount' } : {}),
            transfers: hits.map((h) => ({ txHash: h.txHash, from: h.from, value: h.value.toString() })),
          };
        } catch (e) {
          report.payment = { likelyPaid: null, note: `chain scan failed: ${(e as Error).message}` };
        }
        return textResult(report);
      } catch (e) {
        return errorResult('four02_invoice_status failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'four02_invoice_pay',
    {
      description:
        'Verify a signed 402 invoice and build the exact USDC payment plan for it. DRY RUN BY DEFAULT — returns the plan and client-side signing instructions, broadcasting nothing. Pass approveBroadcast:true ONLY after the human explicitly approved that exact payment in chat, and only when FOUR02_COMMERCE_PAYER_KEY is configured; then the server submits the USDC transfer itself.',
      inputSchema: {
        signedInvoiceJson: z
          .string()
          .describe('The signed invoice JSON (as produced by four02_invoice_create)'),
        approveBroadcast: z
          .boolean()
          .default(false)
          .describe('Set true ONLY after explicit human approval of this exact payment. Moves real USDC.'),
      },
    },
    async (args) => {
      try {
        const parsed = parseSignedInvoice(args.signedInvoiceJson);
        if (!parsed.ok) return errorResult('could not parse signed invoice', parsed.error);
        const signed = parsed.signed;
        const { valid, signer, errors } = await verifyInvoice(signed);
        if (!valid) {
          return errorResult('invoice verification failed — refusing to pay', errors);
        }
        const inv = signed.invoice;
        const plan = {
          pay: `${formatUnits(inv.amount, USDC_DECIMALS)} USDC`,
          amountRaw: inv.amount.toString(),
          to: inv.issuer,
          token: USDC_ADDRESS,
          chain: 'Ink (57073)',
          expiresAt: new Date(Number(inv.expiresAt) * 1000).toISOString(),
          invoiceId: signed.id,
          recoveredSigner: signer,
        };

        if (!args.approveBroadcast) {
          return textResult({
            ok: true,
            broadcast: false,
            plan,
            howToPay:
              'DRY RUN — nothing broadcast. To pay client-side, send a USDC transfer ' +
              `of ${plan.pay} to ${inv.issuer} on Ink from your own wallet, ` +
              'or re-call with approveBroadcast:true after the human explicitly approves this exact payment.',
          });
        }

        // Broadcast path: explicit per-call approval + env-only key.
        if (!config.payerKey) {
          return errorResult(
            'approveBroadcast was true but FOUR02_COMMERCE_PAYER_KEY is not configured',
            'Set the env var to the payer key, or pay client-side from your own wallet.',
          );
        }
        const payer = privateKeyToAccount(config.payerKey).address;
        if (
          getAddress(inv.payer) !== getAddress(ZERO_ADDRESS) &&
          getAddress(inv.payer) !== getAddress(payer)
        ) {
          return errorResult(
            `invoice is addressed to ${inv.payer}, not to payer ${payer} — refusing to pay`,
          );
        }
        const wallet = createWalletClient({
          account: privateKeyToAccount(config.payerKey),
          chain: ink,
          transport: http(config.inkRpcUrl),
        });
        const hash = await wallet.writeContract({
          address: USDC_ADDRESS,
          abi: usdcTransferAbi,
          functionName: 'transfer',
          args: [inv.issuer, inv.amount],
        });
        return textResult({ ok: true, broadcast: true, plan, from: payer, txHash: hash });
      } catch (e) {
        return errorResult('four02_invoice_pay failed', (e as Error).message);
      }
    },
  );

  // ---- reputation (read-only) ----

  server.registerTool(
    'four02_reputation_summary',
    {
      description:
        'One-shot commerce reputation snapshot for an ERC-8004 agentId from the Four02ReputationRegistry on Ink: reliability (0-100), dispute rate (bps), arbitration record, total events, last event time. Read-only.',
      inputSchema: {
        agentId: agentIdSchema.describe('ERC-8004 agent ID (decimal string)'),
      },
    },
    async (args) => {
      try {
        const client = publicClient(config.inkRpcUrl);
        const summary = await readSummary(
          client,
          getAddress(config.registryAddress),
          BigInt(args.agentId),
        );
        return textResult({ ok: true, registry: config.registryAddress, summary });
      } catch (e) {
        return errorResult('four02_reputation_summary failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'four02_reputation_reliability',
    {
      description:
        'Payment reliability score (0-100) and dispute rate (basis points) for an ERC-8004 agentId, from the Four02ReputationRegistry on Ink. Value-weighted with 365-day linear decay. Read-only.',
      inputSchema: {
        agentId: agentIdSchema.describe('ERC-8004 agent ID (decimal string)'),
      },
    },
    async (args) => {
      try {
        const client = publicClient(config.inkRpcUrl);
        const out = await readReliability(
          client,
          getAddress(config.registryAddress),
          BigInt(args.agentId),
        );
        return textResult({ ok: true, registry: config.registryAddress, ...out });
      } catch (e) {
        return errorResult('four02_reputation_reliability failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'four02_reputation_history',
    {
      description:
        'Raw commerce-event history for an ERC-8004 agentId from the Four02ReputationRegistry on Ink (append-only; newest last). Each entry shows the recording writer contract, the event type (e.g. invoice_paid_on_time), and the USDC value. Read-only.',
      inputSchema: {
        agentId: agentIdSchema.describe('ERC-8004 agent ID (decimal string)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Max entries to return (from the newest end)'),
      },
    },
    async (args) => {
      try {
        const client = publicClient(config.inkRpcUrl);
        const history = await readHistory(
          client,
          getAddress(config.registryAddress),
          BigInt(args.agentId),
          args.limit,
        );
        return textResult({ ok: true, registry: config.registryAddress, ...history });
      } catch (e) {
        return errorResult('four02_reputation_history failed', (e as Error).message);
      }
    },
  );

  return server;
}

// ---- stdio entrypoint ----

async function main(): Promise<void> {
  const config = loadCommerceConfig();
  const server = createCommerceServer(config);
  const transport = new StdioServerTransport();
  // Never log to stdout: it corrupts the MCP stdio protocol. stderr only.
  console.error(
    `[four02-commerce-mcp] serving over stdio (facilitator=${config.facilitatorUrl}, registry=${config.registryAddress})`,
  );
  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[four02-commerce-mcp] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
