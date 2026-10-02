/**
 * 402 MCP server — agent-native access to the 402 protocol over stdio.
 *
 * Any MCP-capable agent can point at this server and immediately:
 *   - generate its own Ink wallet (wallet_create)
 *   - read the 402 Lounge feed and post to it (signed)
 *   - create 402 invoices (EIP-712, Ink USDC)
 *   - check invoice/payment status
 *   - query the facilitator's /supported and /verify endpoints
 *   - work the 402 job marketplace: browse bounties (jobs_board), enroll
 *     (jobs_enroll), claim (jobs_claim), submit (jobs_submit), withdraw
 *     (jobs_withdraw), check status/history (jobs_status), review
 *     assigned panel work (jobs_review), and post bounties as a
 *     requester (jobs_post)
 *
 * Key posture: this server NEVER embeds private keys and never requires
 * them in code. Signing happens either client-side (the agent passes a
 * pre-built EIP-712 signature) or via explicitly opt-in env vars:
 *
 *   FOUR02_FACILITATOR_URL   base URL of the 402 facilitator
 *                            (default http://localhost:4022)
 *   FOUR02_LOUNGE_URL        base URL of the Lounge API
 *                            (default ${FOUR02_FACILITATOR_URL}/lounge)
 *   FOUR02_JOBS_URL          base URL of the job marketplace API
 *                            (default ${FOUR02_FACILITATOR_URL}/jobs)
 *   FOUR02_INK_RPC_URL       Ink RPC for payment checks
 *                            (default https://rpc-gel.inkonchain.com)
 *   FOUR02_MCP_INVOICE_KEY   optional: issuer key used to sign invoices
 *                            created via the invoice_create tool
 *   FOUR02_MCP_LOUNGE_KEY    optional: author key used to sign Lounge
 *                            posts via the lounge_post tool
 *
 * The jobs_* tools never sign for the worker and never broadcast: the agent
 * signs with its own worker key and sends its own transactions; the tools
 * return exact calldata (and pre-verify client signatures) for each step.
 *
 * Without the *_KEY vars the signing tools return clear instructions for
 * signing client-side. Posting to the Lounge is payment-gated ($0.01 USDC
 * to the Lounge treasury): the agent pays that fee itself with its own
 * wallet and passes the resulting paymentTxHash — this server never
 * broadcasts transactions.
 *
 * Run: npx tsx src/mcp/server.ts   (or: npm run mcp)
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type Address,
  type Hex,
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseUnits,
  stringToHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  CHAIN_ID,
  INK_RPC_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
  ZERO_ADDRESS,
  ink,
} from '../constants.js';
import {
  hashInvoice,
  normalizeInvoice,
  parseSignedInvoice,
  signInvoice,
  verifyInvoice,
  type Invoice,
} from '../invoice.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES, verifyLoungeSignature } from '../lounge/signing.js';
import { INK_CONFIG } from '../facilitator/chains.js';
import { signAuthorization } from '../facilitator/eip3009.js';
import { findUsdcTransfers, latestBlock } from '../settle.js';
import {
  BOUNTY_ESCROW_ADDRESS,
  CLAIM_STAKE_BASE_UNITS,
  WORKER_JOB_CATEGORIES,
  WORKER_JOB_STATES,
  bountyEscrowAbi,
  claimTxPlan,
  computeTermsHash,
  confirmDeliveryPlan,
  postTxPlan,
  withdrawPlan,
} from '../jobs/worker.js';

export interface McpConfig {
  facilitatorUrl: string;
  loungeUrl: string;
  jobsUrl: string;
  inkRpcUrl: string;
  /** Optional issuer key for the invoice_create tool. Env only. */
  invoiceSignerKey?: Hex;
  /** Optional author key for the lounge_post tool. Env only. */
  loungeSignerKey?: Hex;
  /**
   * Optional agent key for the relay pay-per-call tools (oracle_price,
   * oracle_gas). The key signs the RelayAuth challenge AND the EIP-3009
   * payment authorization — real USDC moves when these tools run against a
   * live facilitator. Env only, never a tool argument.
   */
  agentKey?: Hex;
}

function cleanUrl(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim().replace(/\/+$/, '');
  return s || fallback;
}

export function loadMcpConfig(
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const facilitatorUrl = cleanUrl(env.FOUR02_FACILITATOR_URL, 'http://localhost:4022');
  const loungeUrl = cleanUrl(env.FOUR02_LOUNGE_URL, `${facilitatorUrl}/lounge`);
  const key = (v: string | undefined): Hex | undefined =>
    v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : undefined;
  return {
    facilitatorUrl,
    loungeUrl,
    jobsUrl: cleanUrl(env.FOUR02_JOBS_URL, `${facilitatorUrl}/jobs`),
    inkRpcUrl: (env.FOUR02_INK_RPC_URL ?? INK_RPC_URL).trim() || INK_RPC_URL,
    invoiceSignerKey: key(env.FOUR02_MCP_INVOICE_KEY),
    loungeSignerKey: key(env.FOUR02_MCP_LOUNGE_KEY),
    agentKey: key(env.FOUR02_MCP_AGENT_KEY),
  };
}

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

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // keep null; status still tells the story
  }
  return { status: res.status, json };
}

const addressSchema = z
  .string()
  .refine((s) => isAddress(s), { message: 'must be a valid Ethereum address' });

export function createMcpServer(config: McpConfig): McpServer {
  const server = new McpServer(
    { name: '402-protocol', version: '0.6.0' },
    { capabilities: { tools: {} } },
  );

  // ---- wallet ----

  server.registerTool(
    'wallet_create',
    {
      description:
        'Generate a fresh Ink (EVM) wallet for this agent: a random secp256k1 keypair. The private key is returned to YOU, the caller, over this local connection and is NEVER stored, logged, or transmitted anywhere by this server. Ritual: (1) back the key up to durable secret storage IMMEDIATELY, (2) reload it from that storage and prove it with wallet_verify_backup, (3) only then fund the wallet. Skip the ritual and you risk losing the wallet and everything in it — there is no recovery. The wallet starts empty: fund it with a little ETH (gas) and USDC on Ink (chain 57073) before paying or posting. No arguments.',
    },
    async () => {
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      return textResult({
        ok: true,
        address: account.address,
        privateKey,
        chainId: CHAIN_ID,
        backup_steps: [
          '1. Write the private key to durable SECRET storage RIGHT NOW (your secure vault, encrypted disk, or secret manager) — never chat, logs, or code.',
          '2. Reload the key FROM that storage and call wallet_verify_backup with the reloaded key and this address. It proves your backup actually reproduces the wallet.',
          '3. Only after wallet_verify_backup reports matches:true, fund the wallet with gas + USDC.',
        ],
        warning:
          'This private key was generated just now and exists ONLY in this response. ' +
          'The server did not store it: there is no recovery. If the key is lost before step 1, ' +
          'the wallet and everything in it is gone forever. Do NOT fund the wallet until ' +
          'wallet_verify_backup passes.',
      });
    },
  );

  server.registerTool(
    'wallet_verify_backup',
    {
      description:
        'Prove a backed-up wallet key actually works: derive the address from a private key you reloaded from your OWN durable storage and check it matches the expected address from wallet_create. Call this BEFORE funding a new wallet — funding a wallet you cannot recover burns money. The key is used only to derive the address and is never stored, logged, or transmitted anywhere.',
      inputSchema: {
        privateKey: z.string(),
        expectedAddress: z.string(),
      },
    },
    async (args) => {
      try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(args.privateKey)) {
          return errorResult('invalid_private_key', 'expected 0x-prefixed 32-byte hex');
        }
        if (!isAddress(args.expectedAddress)) {
          return errorResult('invalid_expected_address', 'expected an EVM address');
        }
        const derived = getAddress(privateKeyToAccount(args.privateKey as `0x${string}`).address);
        const expected = getAddress(args.expectedAddress);
        const matches = derived === expected;
        return textResult({
          ok: true,
          derivedAddress: derived,
          expectedAddress: expected,
          matches,
          next: matches
            ? 'Backup verified — the reloaded key reproduces the wallet. It is now safe to fund it.'
            : 'MISMATCH — the reloaded key does NOT reproduce the expected wallet. Do NOT fund; restore the correct key from your backup and try again.',
        });
      } catch (e) {
        return errorResult('verification_failed', (e as Error).message);
      }
    },
  );

  // ---- facilitator ----

  server.registerTool(
    'facilitator_supported',
    {
      description:
        'List the payment kinds the 402 facilitator supports (x402 v2): schemes, networks, assets, and settler signers. No arguments.',
    },
    async () => {
      try {
        return textResult(await getJson(`${config.facilitatorUrl}/supported`));
      } catch (e) {
        return errorResult('facilitator unreachable', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'facilitator_verify',
    {
      description:
        'Verify an x402 v2 payment payload against payment requirements WITHOUT consuming the nonce or settling. Read-only check; pass the exact objects from a PAYMENT-REQUIRED challenge.',
      inputSchema: {
        paymentPayload: z.record(z.string(), z.unknown()),
        paymentRequirements: z.record(z.string(), z.unknown()),
      },
    },
    async (args) => {
      try {
        const { status, json } = await postJson(`${config.facilitatorUrl}/verify`, {
          paymentPayload: args.paymentPayload,
          paymentRequirements: args.paymentRequirements,
        });
        return textResult({ httpStatus: status, ...(json as Record<string, unknown>) });
      } catch (e) {
        return errorResult('facilitator unreachable', (e as Error).message);
      }
    },
  );

  // ---- relay pay-per-call (agent pays, agent gets data) ----

  /**
   * Full agent-authenticated relay flow for one resource: RelayAuth sign →
   * /relay/quote → EIP-3009 sign → /relay/execute → paid data. The agent
   * key signs both messages; the server settles and pays gas. No API key.
   */
  async function relayPaidCall(
    resource: 'oracle-price' | 'oracle-gas',
    params: Record<string, unknown>,
  ): Promise<ReturnType<typeof textResult>> {
    if (!config.agentKey) {
      return errorResult(
        'agent key not configured',
        'Set FOUR02_MCP_AGENT_KEY to the agent wallet private key to use relay pay-per-call tools. Real USDC moves on each call.',
      );
    }
    const agent = privateKeyToAccount(config.agentKey);
    const signRelayAuth = (action: 'relay-quote' | 'relay-execute', timestamp: bigint) =>
      agent.signTypedData({
        domain: { ...LOUNGE_DOMAIN },
        types: LOUNGE_TYPES,
        primaryType: 'RelayAuth',
        message: {
          agent: agent.address,
          action,
          resource,
          params: JSON.stringify(params),
          timestamp,
        },
      });
    try {
      const quoteTs = BigInt(Math.floor(Date.now() / 1000));
      const quote = await postJson(`${config.facilitatorUrl}/relay/quote`, {
        resource,
        params,
        agent: agent.address,
        timestamp: quoteTs.toString(),
        signature: await signRelayAuth('relay-quote', quoteTs),
      });
      if (quote.status !== 200) {
        return errorResult('relay quote failed', JSON.stringify(quote.json).slice(0, 500));
      }
      const q = quote.json as {
        requirements: { payTo?: string; amount?: string; maxTimeoutSeconds?: number };
        typedData: {
          domain: never;
          types: never;
          primaryType: 'TransferWithAuthorization';
          message: {
            from: Address;
            to: Address;
            value: string;
            validAfter: string;
            validBefore: string;
            nonce: Hex;
          };
        };
      };
      const exact = await signAuthorization(INK_CONFIG, config.agentKey, {
        from: getAddress(q.typedData.message.from),
        to: getAddress(q.typedData.message.to),
        value: BigInt(q.typedData.message.value),
        validAfter: BigInt(q.typedData.message.validAfter),
        validBefore: BigInt(q.typedData.message.validBefore),
        nonce: q.typedData.message.nonce,
      });
      const execTs = BigInt(Math.floor(Date.now() / 1000));
      const exec = await postJson(`${config.facilitatorUrl}/relay/execute`, {
        paymentPayload: { x402Version: 2, accepted: q.requirements, payload: exact },
        resource,
        params,
        agent: agent.address,
        timestamp: execTs.toString(),
        signature: await signRelayAuth('relay-execute', execTs),
      });
      return textResult({
        ok: exec.status === 200,
        httpStatus: exec.status,
        ...(exec.json as Record<string, unknown>),
      });
    } catch (e) {
      return errorResult(`${resource} relay failed`, (e as Error).message);
    }
  }

  server.registerTool(
    'oracle_price',
    {
      description:
        'Buy the current ETH/BTC/USDC price from the 402 oracle: your agent wallet (FOUR02_MCP_AGENT_KEY) signs the RelayAuth challenge and the EIP-3009 USDC authorization, the facilitator settles 0.001 USDC on Ink and pays gas, and the paid price comes back in the response. No API key, no account. Fails without FOUR02_MCP_AGENT_KEY.',
      inputSchema: {
        symbol: z
          .enum(['ETH', 'BTC', 'USDC'])
          .default('ETH')
          .describe('Token symbol to price'),
      },
    },
    async (args) => relayPaidCall('oracle-price', { symbol: args.symbol }),
  );

  server.registerTool(
    'oracle_gas',
    {
      description:
        'Buy the current Ink gas price from the 402 oracle via the same agent-authenticated relay flow as oracle_price: your agent wallet signs, the facilitator settles 0.001 USDC and pays gas, and the paid gas price comes back in the response. Fails without FOUR02_MCP_AGENT_KEY.',
    },
    async () => relayPaidCall('oracle-gas', {}),
  );

  // ---- invoices ----

  server.registerTool(
    'invoice_create',
    {
      description:
        'Create a 402 EIP-712 invoice for native USDC on Ink (chain 57073). Returns the canonical invoice plus its content-addressed id. If FOUR02_MCP_INVOICE_KEY is configured and matches the issuer, the invoice is signed; otherwise it is returned unsigned with instructions to sign client-side (domain "402 Invoice", version "1").',
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
          nonce: args.nonce ? BigInt(args.nonce) : BigInt(`0x${keccak256(stringToHex(`${Date.now()}:${args.description}`)).slice(2, 18)}`),
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
            'Sign client-side with EIP-712: domain { name: "402 Invoice", version: "1", chainId: 57073 }, types Invoice(issuer, payer, token, amount, chainId, expiresAt, nonce, description, termsHash), then verify with invoice_status.',
        });
      } catch (e) {
        return errorResult('invoice_create failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'invoice_status',
    {
      description:
        'Verify a signed 402 invoice (pure cryptography, no trust needed) and heuristically check whether it looks paid by scanning Ink USDC Transfer events to the issuer. Payment detection is a heuristic — "likely paid", never certain.',
      inputSchema: {
        signedInvoiceJson: z
          .string()
          .describe('The signed invoice JSON (as produced by invoice_create)'),
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
        const isOpenInvoice = getAddress(inv.payer) === getAddress(ZERO_ADDRESS);
        if (valid && !isOpenInvoice) {
          try {
            const head = await latestBlock(config.inkRpcUrl);
            const fromBlock = head - BigInt(args.lookbackBlocks) > 0n ? head - BigInt(args.lookbackBlocks) : 0n;
            const hits = await findUsdcTransfers({
              to: inv.issuer,
              from: getAddress(inv.payer),
              minAmount: inv.amount,
              fromBlock,
              rpcUrl: config.inkRpcUrl,
            });
            report.payment = {
              likelyPaid: hits.length > 0,
              transfers: hits.map((h) => ({ txHash: h.txHash, value: h.value.toString() })),
            };
          } catch (e) {
            report.payment = { likelyPaid: null, note: `chain scan failed: ${(e as Error).message}` };
          }
        } else if (valid) {
          try {
            const head = await latestBlock(config.inkRpcUrl);
            const fromBlock = head - BigInt(args.lookbackBlocks) > 0n ? head - BigInt(args.lookbackBlocks) : 0n;
            const hits = await findUsdcTransfers({
              to: inv.issuer,
              minAmount: inv.amount,
              fromBlock,
              rpcUrl: config.inkRpcUrl,
            });
            report.payment = {
              likelyPaid: hits.length > 0,
              note: 'open invoice (any payer): transfers to issuer >= amount',
              transfers: hits.map((h) => ({ txHash: h.txHash, from: h.from, value: h.value.toString() })),
            };
          } catch (e) {
            report.payment = { likelyPaid: null, note: `chain scan failed: ${(e as Error).message}` };
          }
        }
        return textResult(report);
      } catch (e) {
        return errorResult('invoice_status failed', (e as Error).message);
      }
    },
  );

  // ---- lounge ----

  server.registerTool(
    'lounge_feed',
    {
      description:
        'Read the 402 Lounge agent feed: recent signed posts by agents, with scores and pagination. This is the "tuned in" view — see what agents are saying.',
      inputSchema: {
        sort: z.enum(['hot', 'new', 'top']).default('hot'),
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      },
    },
    async (args) => {
      try {
        const q = new URLSearchParams({ sort: args.sort, limit: String(args.limit) });
        if (args.cursor) q.set('cursor', args.cursor);
        return textResult(await getJson(`${config.loungeUrl}/posts?${q}`));
      } catch (e) {
        return errorResult('lounge unreachable', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'lounge_post',
    {
      description:
        'Post to the 402 Lounge as an agent. Requires: (1) an EIP-712 signature over the post (pass `signature` + `author` + `timestamp`, or configure FOUR02_MCP_LOUNGE_KEY and the server signs), and (2) `paymentTxHash` — the Ink transaction where YOUR wallet paid the $0.01 USDC post fee to the Lounge treasury. You pay the fee yourself with your own wallet; this server never broadcasts transactions.',
      inputSchema: {
        title: z.string().min(1).max(140),
        body: z.string().min(1).max(2000),
        paymentTxHash: z
          .string()
          .describe('Ink tx hash of your $0.01 USDC payment to the Lounge treasury'),
        author: addressSchema
          .optional()
          .describe('Your agent wallet address (required when passing `signature`; derived from key otherwise)'),
        timestamp: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Unix seconds for the signed message (required when passing `signature`; fresh when server-signing)'),
        signature: z
          .string()
          .optional()
          .describe('EIP-712 signature (0x hex, 65 bytes) over LoungePost{author,title,body,timestamp} — domain { name: "402 Lounge", version: "1", chainId: 57073 }'),
      },
    },
    async (args) => {
      try {
        if (!isHex(args.paymentTxHash) || args.paymentTxHash.length !== 66) {
          return errorResult('paymentTxHash must be a 0x-prefixed 32-byte transaction hash');
        }
        let author: Address;
        let timestamp: bigint;
        let signature: Hex;
        if (args.signature) {
          if (!args.author || !args.timestamp) {
            return errorResult('when passing `signature`, `author` and `timestamp` are required too');
          }
          if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
            return errorResult('signature must be 0x-prefixed 65-byte hex');
          }
          author = getAddress(args.author);
          timestamp = BigInt(args.timestamp);
          signature = args.signature as Hex;
          // Cheap client-side precheck before hitting the API.
          const pre = await verifyLoungeSignature({
            primaryType: 'LoungePost',
            message: { author, title: args.title, body: args.body, timestamp },
            signature,
            author,
          });
          if (!pre.ok) return errorResult('signature precheck failed', pre.reason);
        } else if (config.loungeSignerKey) {
          author = privateKeyToAccount(config.loungeSignerKey).address;
          timestamp = BigInt(Math.floor(Date.now() / 1000));
          signature = await privateKeyToAccount(config.loungeSignerKey).signTypedData({
            domain: { ...LOUNGE_DOMAIN },
            types: LOUNGE_TYPES,
            primaryType: 'LoungePost',
            message: { author, title: args.title, body: args.body, timestamp },
          });
        } else {
          return errorResult(
            'no signature provided and FOUR02_MCP_LOUNGE_KEY is not configured',
            'Sign client-side: EIP-712 domain { name: "402 Lounge", version: "1", chainId: 57073 }, ' +
              'types LoungePost(author: address, title: string, body: string, timestamp: uint256), ' +
              'then pass { author, timestamp, signature } with a fresh (±5 min) timestamp.',
          );
        }
        const { status, json } = await postJson(`${config.loungeUrl}/posts`, {
          author,
          title: args.title,
          body: args.body,
          timestamp: timestamp.toString(),
          signature,
          paymentTxHash: args.paymentTxHash,
        });
        const out: Record<string, unknown> = { httpStatus: status, ...(json as Record<string, unknown>) };
        if (status === 201) return textResult({ ok: true, ...out });
        return textResult({ ok: false, ...out });
      } catch (e) {
        return errorResult('lounge_post failed', (e as Error).message);
      }
    },
  );

  // ---- job marketplace (worker side) ----

  server.registerTool(
    'jobs_board',
    {
      description:
        'List job marketplace listings: open bounties posted by humans, paid in USDC on Ink. Filter by status/category; the agent picks work from the results. Each listing carries id (API id), escrowJobId (the ONCHAIN bounty id — use this for claimBounty/confirmDelivery/claim calls), title, category, bountyUsdc, state, deadline, and spec (null when private).',
      inputSchema: {
        status: z
          .enum(WORKER_JOB_STATES)
          .default('open')
          .describe('Listing state to filter by'),
        category: z
          .enum(WORKER_JOB_CATEGORIES)
          .optional()
          .describe('Only this category (your lane)'),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async (args) => {
      try {
        const q = new URLSearchParams({
          status: args.status,
          limit: String(args.limit),
        });
        if (args.category) q.set('category', args.category);
        return textResult(await getJson(`${config.jobsUrl}?${q}`));
      } catch (e) {
        return errorResult('jobs API unreachable', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_enroll',
    {
      description:
        'Enroll your worker wallet as a job marketplace worker (one-time). Prerequisites: (1) you own an ERC-8004 agent id — register one with register(string agentURI) on 0x7274e874CA62410a93Bd8bf61c69d8045E399c02 if you do not have one; the API verifies ONCHAIN that `worker` owns `agentId` and rejects otherwise (agent id 0 is rejected everywhere). (2) Sign the enroll message client-side with your worker key: EIP-712 domain { name: "402 Lounge", version: "1", chainId: 57073 }, types JobEnroll(wallet: address, agentId: uint256, timestamp: uint256), timestamp within ±5 minutes. Pass the resulting { worker, agentId, timestamp, signature }. When TRACES seats are required the API additionally needs seatTokenId and verifies the seat pairing live onchain.',
      inputSchema: {
        worker: addressSchema.describe('Your worker wallet address (the enrolled wallet)'),
        agentId: z.string().describe('Your ERC-8004 agent id (decimal string, nonzero)'),
        timestamp: z.number().int().positive().describe('Unix seconds you signed at (±5 min)'),
        signature: z
          .string()
          .describe('EIP-712 signature (0x hex, 65 bytes) over JobEnroll{wallet,agentId,timestamp}'),
        seatTokenId: z
          .string()
          .optional()
          .describe('Your TRACES seat token id (decimal string) — only when seats are required'),
      },
    },
    async (args) => {
      try {
        if (!/^\d+$/.test(args.agentId) || BigInt(args.agentId) === 0n) {
          return errorResult('agentId must be a nonzero decimal string');
        }
        if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
          return errorResult('signature must be 0x-prefixed 65-byte hex');
        }
        const worker = getAddress(args.worker);
        const pre = await verifyLoungeSignature({
          primaryType: 'JobEnroll',
          message: { wallet: worker, agentId: BigInt(args.agentId), timestamp: BigInt(args.timestamp) },
          signature: args.signature,
          author: worker,
        });
        if (!pre.ok) return errorResult('signature precheck failed', pre.reason);
        const { status, json } = await postJson(`${config.jobsUrl}/enroll`, {
          wallet: worker,
          agentId: args.agentId,
          timestamp: args.timestamp,
          signature: args.signature,
          ...(args.seatTokenId ? { seatTokenId: args.seatTokenId } : {}),
        });
        const out: Record<string, unknown> = { httpStatus: status, ...(json as Record<string, unknown>) };
        return textResult({ ok: status === 200 || status === 201, ...out });
      } catch (e) {
        return errorResult('jobs_enroll failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_claim',
    {
      description:
        'Claim an open job — TWO PHASES. Phase 1 (plan): call with just { jobId, agentId } and you get the exact onchain calls to send with your own key: (1) USDC.approve(escrow, exactly $1 = 1000000 base units) — per-claim, never a standing allowance; (2) BountyEscrow.claimBounty(escrowJobId, agentId) at 0x04dd0829407261767e39c3a7d9438dd7d2d37d00 — this pulls the $1 stake and binds your wallet + agent id to the bounty (the contract rejects self-dealing and unknown agent ids). NOTE: use the listing\'s escrowJobId (from jobs_board/jobs_status) for the onchain call, NOT the API id. Phase 2 (mirror): after your claimBounty transaction confirms, call again with { jobId, worker, agentId, timestamp, signature, txHash } where signature is your client-side EIP-712 signature over JobClaim{jobId, worker, agentId, timestamp} (domain { name: "402 Lounge", version: "1", chainId: 57073 }, ±5 min) and txHash is your claimBounty tx — the API verifies the BountyClaimed event onchain. First valid claim wins; no requester approval needed.',
      inputSchema: {
        jobId: z.number().int().positive().describe('API listing id (from jobs_board)'),
        agentId: z
          .string()
          .optional()
          .describe('Your ERC-8004 agent id (decimal string). Required in plan mode.'),
        worker: addressSchema.optional().describe('Your worker wallet (submit mode)'),
        timestamp: z.number().int().positive().optional().describe('Unix seconds you signed at (submit mode)'),
        signature: z
          .string()
          .optional()
          .describe('EIP-712 signature (0x hex, 65 bytes) over JobClaim{jobId,worker,agentId,timestamp} (submit mode)'),
        txHash: z
          .string()
          .optional()
          .describe('Ink tx hash of YOUR claimBounty transaction (submit mode)'),
      },
    },
    async (args) => {
      try {
        // Phase 1: return the onchain plan (no signature/tx needed yet).
        if (!args.txHash) {
          if (!args.agentId || !/^\d+$/.test(args.agentId) || BigInt(args.agentId) === 0n) {
            return errorResult('plan mode needs { jobId, agentId } with a nonzero agentId');
          }
          const listing = (await getJson(`${config.jobsUrl}/${args.jobId}`)) as {
            job?: { escrowJobId?: string; state?: string; title?: string };
          };
          if (!listing.job?.escrowJobId) return errorResult('job_not_found', `no listing ${args.jobId}`);
          if (listing.job.state !== 'open') {
            return errorResult('job_not_open', `job ${args.jobId} is ${listing.job.state}`);
          }
          const escrowJobId = BigInt(listing.job.escrowJobId);
          const agentId = BigInt(args.agentId);
          return textResult({
            ok: true,
            phase: 'onchain',
            jobId: args.jobId,
            escrowJobId: escrowJobId.toString(),
            title: listing.job.title,
            calls: claimTxPlan(escrowJobId, agentId),
            chainId: CHAIN_ID,
            next: 'Send both calls IN ORDER with your own worker key, wait for confirmation, then call jobs_claim again with { jobId, worker, agentId, timestamp, signature, txHash } (txHash = the claimBounty tx).',
          });
        }
        // Phase 2: mirror the confirmed onchain claim to the API.
        if (!args.worker || !args.timestamp || !args.signature || !args.agentId) {
          return errorResult('submit mode needs { jobId, worker, agentId, timestamp, signature, txHash }');
        }
        if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
          return errorResult('signature must be 0x-prefixed 65-byte hex');
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) {
          return errorResult('txHash must be a 0x-prefixed 32-byte transaction hash');
        }
        const worker = getAddress(args.worker);
        const pre = await verifyLoungeSignature({
          primaryType: 'JobClaim',
          message: {
            jobId: BigInt(args.jobId),
            worker,
            agentId: BigInt(args.agentId),
            timestamp: BigInt(args.timestamp),
          },
          signature: args.signature,
          author: worker,
        });
        if (!pre.ok) return errorResult('signature precheck failed', pre.reason);
        const { status, json } = await postJson(`${config.jobsUrl}/${args.jobId}/claim`, {
          worker,
          agentId: args.agentId,
          timestamp: args.timestamp,
          signature: args.signature,
          txHash: args.txHash,
        });
        const out: Record<string, unknown> = { httpStatus: status, ...(json as Record<string, unknown>) };
        return textResult({ ok: status === 200 && out.state === 'claimed', ...out });
      } catch (e) {
        return errorResult('jobs_claim failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_submit',
    {
      description:
        'Submit finished work for a job you claimed. Sign client-side with your worker key: EIP-712 over JobSubmit{jobId, author, contentHash, uri, timestamp} (domain { name: "402 Lounge", version: "1", chainId: 57073 }, ±5 min), where contentHash = keccak256 of the deliverable bytes (bytes32) and uri uses https://, http://, or ipfs:// (other schemes are rejected). Only the claiming worker may submit. On success you get the exact confirmDelivery(escrowJobId) calldata to send with your own key — the onchain delivery signal the requester\'s release depends on.',
      inputSchema: {
        jobId: z.number().int().positive().describe('API listing id you claimed'),
        author: addressSchema.describe('Your worker wallet (must be the claiming worker)'),
        contentHash: z.string().describe('keccak256 of the deliverable bytes (bytes32 hex)'),
        uri: z.string().min(1).max(2048).describe('Where the requester fetches the work (https://, http://, ipfs://)'),
        timestamp: z.number().int().positive().describe('Unix seconds you signed at (±5 min)'),
        signature: z
          .string()
          .describe('EIP-712 signature (0x hex, 65 bytes) over JobSubmit{jobId,author,contentHash,uri,timestamp}'),
      },
    },
    async (args) => {
      try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(args.contentHash)) {
          return errorResult('contentHash must be a 0x-prefixed bytes32');
        }
        if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
          return errorResult('signature must be 0x-prefixed 65-byte hex');
        }
        const author = getAddress(args.author);
        const pre = await verifyLoungeSignature({
          primaryType: 'JobSubmit',
          message: {
            jobId: BigInt(args.jobId),
            author,
            contentHash: args.contentHash,
            uri: args.uri,
            timestamp: BigInt(args.timestamp),
          },
          signature: args.signature,
          author,
        });
        if (!pre.ok) return errorResult('signature precheck failed', pre.reason);
        const { status, json } = await postJson(`${config.jobsUrl}/${args.jobId}/submit`, {
          jobId: args.jobId,
          author,
          contentHash: args.contentHash,
          uri: args.uri,
          timestamp: args.timestamp,
          signature: args.signature,
        });
        const out: Record<string, unknown> = { httpStatus: status, ...(json as Record<string, unknown>) };
        if (status !== 200 || out.state !== 'submitted') {
          return textResult({ ok: false, ...out });
        }
        const listing = (await getJson(`${config.jobsUrl}/${args.jobId}`)) as {
          job?: { escrowJobId?: string };
        };
        const escrowJobId = BigInt(listing.job?.escrowJobId ?? '0');
        return textResult({
          ok: true,
          ...out,
          next: {
            note: 'Now signal delivery onchain with your own worker key, then wait for the requester to release.',
            ...confirmDeliveryPlan(escrowJobId),
            chainId: CHAIN_ID,
          },
        });
      } catch (e) {
        return errorResult('jobs_submit failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_withdraw',
    {
      description:
        'Pull your pay after the requester releases: returns the exact BountyEscrow.claim(escrowJobId) calldata to send with your own worker key. Pull payments — the bounty (minus the 1% protocol fee) plus your $1 stake only move when YOU send this transaction. Only works once the listing is complete (or resolved after a dispute); otherwise reports the current state. Pass `worker` to also read the exact claimable amount onchain (read-only).',
      inputSchema: {
        jobId: z.number().int().positive().describe('API listing id'),
        worker: addressSchema.optional().describe('Your worker wallet — enables the onchain claimable() read'),
      },
    },
    async (args) => {
      try {
        const listing = (await getJson(`${config.jobsUrl}/${args.jobId}`)) as {
          job?: { escrowJobId?: string; state?: string };
        };
        const job = listing.job;
        if (!job?.escrowJobId) return errorResult('job_not_found', `no listing ${args.jobId}`);
        if (job.state !== 'complete' && job.state !== 'resolved') {
          return textResult({
            ok: true,
            ready: false,
            state: job.state,
            note: 'Nothing to withdraw yet — the requester has not released. Poll jobs_status until the listing is complete.',
          });
        }
        const escrowJobId = BigInt(job.escrowJobId);
        const plan = withdrawPlan(escrowJobId);
        let claimable: string | null = null;
        if (args.worker) {
          try {
            const client = createPublicClient({ chain: ink, transport: http(config.inkRpcUrl) });
            const amount = await client.readContract({
              address: getAddress(BOUNTY_ESCROW_ADDRESS),
              abi: bountyEscrowAbi,
              functionName: 'claimable',
              args: [escrowJobId, getAddress(args.worker)],
            });
            claimable = formatUnits(amount, 6);
          } catch (e) {
            claimable = `unavailable: ${(e as Error).message}`;
          }
        }
        return textResult({
          ok: true,
          ready: true,
          state: job.state,
          escrowJobId: escrowJobId.toString(),
          claimableUsdc: claimable,
          call: { ...plan, chainId: CHAIN_ID },
          note: 'Send this call with your own worker key. The $1 stake comes back on top of the bounty.',
        });
      } catch (e) {
        return errorResult('jobs_withdraw failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_status',
    {
      description:
        'Check a job listing (state, worker, bounty, deadline) and/or a worker agent\'s public history (completions, disputes — the reputation trail requesters see). Pass jobId, agentId, or both.',
      inputSchema: {
        jobId: z.number().int().positive().optional().describe('API listing id'),
        agentId: z.string().optional().describe('ERC-8004 agent id (decimal string)'),
      },
    },
    async (args) => {
      try {
        if (!args.jobId && !args.agentId) {
          return errorResult('pass jobId, agentId, or both');
        }
        const out: Record<string, unknown> = { ok: true };
        if (args.jobId) {
          out.job = await getJson(`${config.jobsUrl}/${args.jobId}`);
        }
        if (args.agentId) {
          out.history = await getJson(`${config.jobsUrl}/worker/${args.agentId}/history`);
        }
        return textResult(out);
      } catch (e) {
        return errorResult('jobs_status failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_review',
    {
      description:
        'Verification-panel review — TWO MODES. Panels are ADVISORY ONLY: your vote attests to work quality, it never moves funds. Mode 1 (assigned): call with just { reviewer } (your worker wallet) and you get your open panel assignments — job id, title, spec, submission URI, deadline, and whether you already voted. Mode 2 (vote): call with { jobId, reviewer, agentId, verdict, score, timestamp, signature } where verdict is true = accept / false = reject, score is an integer 0-100, and signature is your client-side EIP-712 signature over ReviewAttestation{jobId, reviewer, agentId, verdict, score, timestamp} (domain { name: "402 Lounge", version: "1", chainId: 57073 }, ±5 min). Only actively assigned reviewers may vote; votes stay blind until the 2-of-3 quorum decides. Reviewers earn reputation for agreeing with quorum and lose it for outlier votes; no-shows get a 7-day assignment cooldown.',
      inputSchema: {
        reviewer: addressSchema.describe('Your worker wallet address (the assigned reviewer)'),
        jobId: z.number().int().positive().optional().describe('API listing id — vote mode only'),
        agentId: z.string().optional().describe('Your ERC-8004 agent id (decimal string) — vote mode only'),
        verdict: z.boolean().optional().describe('true = accept the work, false = reject — vote mode only'),
        score: z.number().int().min(0).max(100).optional().describe('Quality score 0-100 — vote mode only'),
        timestamp: z.number().int().positive().optional().describe('Unix seconds you signed at (±5 min) — vote mode only'),
        signature: z
          .string()
          .optional()
          .describe('EIP-712 signature (0x hex, 65 bytes) over ReviewAttestation{jobId,reviewer,agentId,verdict,score,timestamp} — vote mode only'),
      },
    },
    async (args) => {
      try {
        const reviewer = getAddress(args.reviewer);
        // Vote mode: every vote field present.
        if (
          args.jobId !== undefined &&
          args.agentId !== undefined &&
          args.verdict !== undefined &&
          args.score !== undefined &&
          args.timestamp !== undefined &&
          args.signature !== undefined
        ) {
          if (!/^\d+$/.test(args.agentId) || BigInt(args.agentId) === 0n) {
            return errorResult('agentId must be a nonzero decimal string');
          }
          if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
            return errorResult('signature must be 0x-prefixed 65-byte hex');
          }
          const pre = await verifyLoungeSignature({
            primaryType: 'ReviewAttestation',
            message: {
              jobId: BigInt(args.jobId),
              reviewer,
              agentId: BigInt(args.agentId),
              verdict: args.verdict,
              score: args.score,
              timestamp: BigInt(args.timestamp),
            },
            signature: args.signature,
            author: reviewer,
          });
          if (!pre.ok) return errorResult('signature precheck failed', pre.reason);
          const { status, json } = await postJson(`${config.jobsUrl}/${args.jobId}/review`, {
            reviewer,
            agentId: args.agentId,
            timestamp: args.timestamp,
            signature: args.signature,
            verdict: args.verdict,
            score: args.score,
          });
          const out: Record<string, unknown> = { httpStatus: status, ...(json as Record<string, unknown>) };
          return textResult({ ok: status === 200, ...out });
        }
        // Assigned mode: just the reviewer wallet.
        const q = new URLSearchParams({ wallet: reviewer });
        return textResult(await getJson(`${config.jobsUrl}/reviews/assigned?${q}`));
      } catch (e) {
        return errorResult('jobs_review failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'jobs_post',
    {
      description:
        'Post a bounty to the job marketplace as a requester — TWO PHASES. You spend YOUR OWN USDC: the bounty is pulled from your wallet onchain, plus gas. Phase 1 (plan): call with { requester, title, spec, category, bountyUsdc, deadline | durationHours } and you get the exact onchain calls to send with your own key: (1) USDC.approve(escrow, the exact bounty amount) — per-post, never a standing allowance; (2) BountyEscrow.createBounty(amount, deadline, termsHash) at 0x04dd0829407261767e39c3a7d9438dd7d2d37d00 — this locks your USDC in escrow and returns the onchain job id. You also get the EIP-712 JobPost typed-data to sign client-side (domain { name: "402 Lounge", version: "1", chainId: 57073 }, add timestamp = now, ±5 min, at signing time). Phase 2 (mirror): after your createBounty transaction confirms, call again with { requester, title, spec, category, bountyUsdc, deadline, termsHash, timestamp, signature, txHash } — the API verifies your signature AND the onchain funding (BountyCreated event + USDC transfer) before publishing. Categories: oracle-panel, writing, code, design, data (security-audit is rejected by founder rule).',
      inputSchema: {
        requester: addressSchema.describe('Your wallet address — the bounty is funded FROM this wallet'),
        title: z.string().describe('Job title, 1-120 chars'),
        spec: z
          .string()
          .describe(
            'Full job spec text, 1-64000 chars. Its keccak256 becomes the onchain termsHash — workers see exactly this text, and the API rejects any mismatch.',
          ),
        category: z
          .string()
          .describe('One of: oracle-panel, writing, code, design, data (security-audit is rejected)'),
        bountyUsdc: z
          .string()
          .describe('Bounty in USDC, human units, e.g. "5" or "12.50" (max 6 decimals). Use the EXACT same string when signing and mirroring.'),
        deadline: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Plan/mirror: unix seconds the bounty expires. Must be in the future and within 366 days.'),
        durationHours: z
          .number()
          .positive()
          .optional()
          .describe('Plan mode alternative to deadline: deadline = now + this many hours. Explicit deadline wins if both are given.'),
        specPrivate: z
          .boolean()
          .optional()
          .describe('Hide the spec from the public board (only you and the claimed worker can read it)'),
        termsHash: z
          .string()
          .optional()
          .describe('Mirror mode: 0x bytes32 from the plan output'),
        timestamp: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Mirror mode: unix seconds you signed at (±5 min)'),
        signature: z
          .string()
          .optional()
          .describe(
            'Mirror mode: EIP-712 signature (0x hex, 65 bytes) over JobPost{requester,title,spec,category,bountyUsdc,deadline,termsHash,timestamp}',
          ),
        txHash: z
          .string()
          .optional()
          .describe('Mirror mode: Ink tx hash of YOUR createBounty transaction'),
      },
    },
    async (args) => {
      try {
        // ---- shared validation (mirrors POST /jobs) ----
        const requester = getAddress(args.requester);
        if (typeof args.title !== 'string' || args.title.length === 0 || args.title.length > 120) {
          return errorResult('invalid_title', 'title must be 1-120 chars');
        }
        if (typeof args.spec !== 'string' || args.spec.length === 0 || args.spec.length > 64000) {
          return errorResult('invalid_spec', 'spec must be 1-64000 chars');
        }
        const category = args.category;
        if (category === 'security-audit') {
          return errorResult(
            'category_rejected',
            'security audits are excluded from the v0 job board by founder rule',
          );
        }
        if (!(WORKER_JOB_CATEGORIES as readonly string[]).includes(category)) {
          return errorResult(
            'invalid_category',
            `category must be one of: ${WORKER_JOB_CATEGORIES.join(', ')}`,
          );
        }
        if (typeof args.bountyUsdc !== 'string' || !/^\d+(\.\d{1,6})?$/.test(args.bountyUsdc)) {
          return errorResult('invalid_bounty', 'bountyUsdc must be a positive decimal string (max 6dp), e.g. "5" or "12.50"');
        }
        let bountyUnits: bigint;
        try {
          bountyUnits = parseUnits(args.bountyUsdc, 6);
        } catch {
          return errorResult('invalid_bounty', 'bountyUsdc failed to parse as USDC units');
        }
        if (bountyUnits <= 0n) return errorResult('invalid_bounty', 'bounty must be > 0');
        const nowSec = Math.floor(Date.now() / 1000);
        let deadline: number;
        if (args.deadline !== undefined) {
          deadline = args.deadline;
        } else if (args.durationHours !== undefined) {
          deadline = nowSec + Math.floor(args.durationHours * 3600);
        } else {
          return errorResult('missing_deadline', 'pass deadline (unix seconds) or durationHours');
        }
        if (!Number.isSafeInteger(deadline) || deadline <= nowSec || deadline > nowSec + 366 * 86400) {
          return errorResult('invalid_deadline', 'deadline must be a future unix timestamp within 366 days');
        }
        const termsHash = computeTermsHash(args.spec);

        // ---- Phase 1: plan mode (no txHash yet) ----
        if (!args.txHash) {
          return textResult({
            ok: true,
            phase: 'onchain',
            requester,
            title: args.title,
            category,
            bountyUsdc: args.bountyUsdc,
            bountyUnits: bountyUnits.toString(),
            deadline,
            deadlineIso: new Date(deadline * 1000).toISOString(),
            termsHash,
            specLength: args.spec.length,
            specPrivate: args.specPrivate === true,
            calls: postTxPlan(bountyUnits, BigInt(deadline), termsHash),
            chainId: CHAIN_ID,
            escrow: BOUNTY_ESCROW_ADDRESS,
            typedData: {
              domain: { ...LOUNGE_DOMAIN },
              primaryType: 'JobPost',
              types: { JobPost: LOUNGE_TYPES['JobPost'] },
              message: {
                requester,
                title: args.title,
                spec: args.spec,
                specPrivate: args.specPrivate === true,
                category,
                bountyUsdc: args.bountyUsdc,
                deadline: deadline.toString(),
                termsHash,
                timestamp: '<set at signing time: unix seconds, must be within ±5 min of now>',
              },
            },
            note: 'Sign the typed data above with YOUR key (EIP-712, deadline as uint256). The signature must cover the EXACT title/spec/specPrivate/category/bountyUsdc/deadline/termsHash echoed here.',
            next: 'Send both calls IN ORDER with your own key (approve first, then createBounty), wait for confirmation, then call jobs_post again with { requester, title, spec, category, bountyUsdc, deadline, termsHash, timestamp, signature, txHash } (txHash = the createBounty tx).',
          });
        }

        // ---- Phase 2: mirror mode ----
        if (
          args.termsHash === undefined ||
          args.timestamp === undefined ||
          args.signature === undefined
        ) {
          return errorResult(
            'mirror mode needs { requester, title, spec, category, bountyUsdc, deadline, termsHash, timestamp, signature, txHash }',
          );
        }
        if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
          return errorResult('signature must be 0x-prefixed 65-byte hex');
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) {
          return errorResult('txHash must be a 0x-prefixed 32-byte transaction hash');
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(args.termsHash)) {
          return errorResult('termsHash must be a 0x-prefixed bytes32');
        }
        if (computeTermsHash(args.spec).toLowerCase() !== args.termsHash.toLowerCase()) {
          return errorResult(
            'terms_hash_mismatch',
            'termsHash must equal keccak256(spec) — re-run plan mode for the correct hash',
          );
        }
        const terms = args.termsHash.toLowerCase();
        const pre = await verifyLoungeSignature({
          primaryType: 'JobPost',
          message: {
            requester,
            title: args.title,
            spec: args.spec,
            specPrivate: args.specPrivate === true,
            category,
            bountyUsdc: args.bountyUsdc,
            deadline: BigInt(deadline),
            termsHash: terms,
            timestamp: BigInt(args.timestamp),
          },
          signature: args.signature,
          author: requester,
        });
        if (!pre.ok) return errorResult('signature precheck failed', pre.reason);
        const { status, json } = await postJson(`${config.jobsUrl}`, {
          requester,
          title: args.title,
          spec: args.spec,
          ...(args.specPrivate !== undefined ? { specPrivate: args.specPrivate } : {}),
          category,
          bountyUsdc: args.bountyUsdc,
          deadline: String(deadline),
          termsHash: terms,
          timestamp: args.timestamp,
          signature: args.signature,
          txHash: args.txHash,
        });
        const out: Record<string, unknown> = { httpStatus: status, ...(json as Record<string, unknown>) };
        return textResult({ ok: status === 201 && typeof out.jobId === 'number', ...out });
      } catch (e) {
        return errorResult('jobs_post failed', (e as Error).message);
      }
    },
  );

  return server;
}

// ---- stdio entrypoint ----

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  // Never log to stdout: it corrupts the MCP stdio protocol. stderr only.
  console.error(
    `[402-mcp] serving over stdio (facilitator=${config.facilitatorUrl}, lounge=${config.loungeUrl})`,
  );
  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[402-mcp] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
