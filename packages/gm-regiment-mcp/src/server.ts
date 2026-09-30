#!/usr/bin/env node
/**
 * gm-regiment-mcp — the GM Regiment toolkit for the Ink agentic economy (stdio).
 *
 * Any MCP-capable agent (Claude Code, Cursor, Claude Desktop, …) can point
 * at this server and immediately:
 *   - create its own Ink wallet (gm_create_wallet) with the backup ritual
 *   - register its ERC-8004 agent identity (gm_register_agent)
 *   - say GM on sergio-inkfnd's gm.ink contracts (gm_agent_gm / gm_agent_gm_to)
 *   - check its agent-GM cooldown status (gm_agent_status / gm_agent_last_gm)
 *
 * Designed to sit alongside gmink-mcp / inkonchain-mcp: every tool is
 * prefixed `gm_`, so there are zero tool-name collisions.
 *
 * Key posture:
 *  - This server NEVER stores a private key. Write tools take the agent's
 *    key per-call; it is used to sign locally and is never logged,
 *    persisted, or transmitted anywhere except inside the broadcast
 *    transaction the caller explicitly confirmed.
 *  - Writes NEVER broadcast by default. Every write tool is a DRY RUN that
 *    returns the fully-prepared transaction (to, data, value, estimated
 *    gas) for review, and broadcasts only when the caller passes an
 *    explicit `confirm: true`.
 *  - Gas gate: write tools check the wallet's ETH balance on Ink BEFORE
 *    preparing anything. A wallet that cannot cover gas gets a "needs gas"
 *    response with the address and a funding instruction instead of a
 *    transaction. This makes "create wallet → ask human for gas →
 *    register → GM" the natural guided flow.
 *  - Reads are free and need no key.
 *
 * Run: npx gm-regiment-mcp            (once published)
 *      node dist/server.js            (local build)
 *      npm run dev                    (tsx, local dev)
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type Address,
  type Hex,
  encodeFunctionData,
  getAddress,
  isAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import {
  CHAIN_ID,
  DAILY_AGENT_GM_ADDRESS,
  GM_COOLDOWN_SECONDS,
  IDENTITY_REGISTRY_ADDRESS,
  ink,
  type GmRegimentConfig,
  loadGmRegimentConfig,
} from './config.js';
import { publicClient, walletClientFor } from './chain.js';
import {
  checkGas,
  dailyAgentGmAbi,
  identityRegistryAbi,
  readIsAgent,
  readLastGM,
} from './contracts.js';

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

const privateKeySchema = z
  .string()
  .refine((s) => /^0x[0-9a-fA-F]{64}$/.test(s), {
    message: 'must be a 0x-prefixed 32-byte hex private key',
  });

const confirmSchema = z
  .boolean()
  .default(false)
  .describe(
    'Set true ONLY after the human explicitly approved this exact onchain action. Broadcasts a real transaction on Ink mainnet.',
  );

interface WriteSpec {
  account: Address;
  privateKey: Hex;
  to: Address;
  data: Hex;
  confirm: boolean;
  actionLabel: string;
}

function needsGasResult(gate: { address: Address; balanceWei: bigint; instruction: string }) {
  return textResult({
    ok: false,
    needsGas: true,
    address: gate.address,
    balanceWei: gate.balanceWei.toString(),
    instruction: gate.instruction,
  });
}

/**
 * Shared write path: dry-run prepare → (optional) broadcast.
 * The gas gate runs BEFORE this is ever called (see each tool handler),
 * so an unfunded wallet never gets a transaction it cannot send.
 */
async function runWrite(config: GmRegimentConfig, spec: WriteSpec) {
  if (!spec.confirm) {
    const client = publicClient(config);
    const estimatedGas = await client.estimateGas({
      account: spec.account,
      to: spec.to,
      data: spec.data,
      value: 0n,
    });
    return textResult({
      ok: true,
      broadcast: false,
      prepared: {
        from: spec.account,
        to: spec.to,
        data: spec.data,
        value: '0',
        estimatedGas: estimatedGas.toString(),
        chainId: CHAIN_ID,
        chain: 'Ink',
      },
      howToConfirm:
        `DRY RUN — nothing broadcast. Re-call with confirm:true to broadcast and ${spec.actionLabel}. ` +
        'Only pass confirm:true after the human explicitly approved this exact onchain action.',
    });
  }

  const wallet = walletClientFor(spec.privateKey, config);
  const hash = await wallet.sendTransaction({
    account: privateKeyToAccount(spec.privateKey),
    chain: ink,
    to: spec.to,
    data: spec.data,
    value: 0n,
  });
  return textResult({
    ok: true,
    broadcast: true,
    from: spec.account,
    to: spec.to,
    txHash: hash,
    chainId: CHAIN_ID,
  });
}

export function createGmRegimentServer(config: GmRegimentConfig): McpServer {
  const server = new McpServer(
    { name: 'gm-regiment', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ---- wallet ----

  server.registerTool(
    'gm_create_wallet',
    {
      description:
        'Generate a fresh Ink (EVM) wallet for this agent: a random secp256k1 keypair. The private key is returned to YOU, the caller, over this local connection and is NEVER stored, logged, or transmitted anywhere by this server. Ritual: (1) back the key up to durable secret storage IMMEDIATELY, (2) reload it from that storage and prove the backup reproduces this address before funding, (3) only then ask the human for a little ETH on Ink (chain 57073) for gas. Skip the ritual and you risk losing the wallet and everything in it — there is no recovery. The wallet starts empty. No arguments.',
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
          '2. Reload the key FROM that storage and re-derive the address yourself; confirm it matches this address. It proves your backup actually reproduces the wallet.',
          '3. Only after the backup is proven, ask the human to send a little ETH on Ink (chain 57073) to this address for gas — then run gm_register_agent.',
        ],
        warning:
          'This private key was generated just now and exists ONLY in this response. ' +
          'The server did not store it: there is no recovery. If the key is lost before step 1, ' +
          'the wallet and everything in it is gone forever. Do NOT fund the wallet until ' +
          'your backup is proven.',
      });
    },
  );

  // ---- registration ----

  server.registerTool(
    'gm_register_agent',
    {
      description:
        'Register this agent\'s ERC-8004 identity on Ink by calling register(name) on the live Identity Registry. After this, the wallet is a registered agent and can say agent-GM on gm.ink. DRY RUN BY DEFAULT — returns the prepared transaction; pass confirm:true only after the human explicitly approved this exact registration. The wallet must hold a little ETH on Ink for gas (gas gate), or you get a "needs gas" response with funding instructions.',
      inputSchema: {
        privateKey: privateKeySchema.describe("The agent's private key (0x hex). Never stored or logged."),
        name: z
          .string()
          .min(1)
          .max(120)
          .describe("The agent's chosen name/URI for its ERC-8004 identity"),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      try {
        const privateKey = args.privateKey as Hex;
        const account = privateKeyToAccount(privateKey).address;
        // Gas gate first: an unfunded wallet gets funding guidance before
        // any registration check, so "fund → register" is the guided order.
        const gate = await checkGas(config, account);
        if (!gate.ok) return needsGasResult(gate);
        const client = publicClient(config);
        if (await readIsAgent(client, account)) {
          return textResult({
            ok: true,
            alreadyRegistered: true,
            address: account,
            note: 'This wallet already holds an ERC-8004 identity — no need to register again. Use gm_agent_gm to say GM.',
          });
        }
        return runWrite(config, {
          account,
          privateKey,
          to: getAddress(IDENTITY_REGISTRY_ADDRESS),
          data: encodeFunctionData({
            abi: identityRegistryAbi,
            functionName: 'register',
            args: [args.name],
          }),
          confirm: args.confirm,
          actionLabel: 'register the ERC-8004 identity',
        });
      } catch (e) {
        return errorResult('gm_register_agent failed', (e as Error).message);
      }
    },
  );

  // ---- GM writes ----

  server.registerTool(
    'gm_agent_gm',
    {
      description:
        'Say GM as a registered agent on gm.ink: calls gm() on DailyAgentGM (free except gas, 24h cooldown). The caller must already be a registered agent — run gm_register_agent first. DRY RUN BY DEFAULT — returns the prepared transaction; pass confirm:true only after the human explicitly approved this exact GM. The wallet must hold a little ETH on Ink for gas (gas gate).',
      inputSchema: {
        privateKey: privateKeySchema.describe("The agent's private key (0x hex). Never stored or logged."),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      try {
        const privateKey = args.privateKey as Hex;
        const account = privateKeyToAccount(privateKey).address;
        const gate = await checkGas(config, account);
        if (!gate.ok) return needsGasResult(gate);
        const client = publicClient(config);
        if (!(await readIsAgent(client, account))) {
          return errorResult(
            'sender is not a registered agent',
            'Run gm_register_agent first — DailyAgentGM only accepts GMs from wallets holding an ERC-8004 identity.',
          );
        }
        return runWrite(config, {
          account,
          privateKey,
          to: getAddress(DAILY_AGENT_GM_ADDRESS),
          data: encodeFunctionData({ abi: dailyAgentGmAbi, functionName: 'gm' }),
          confirm: args.confirm,
          actionLabel: 'say the daily agent GM',
        });
      } catch (e) {
        return errorResult('gm_agent_gm failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'gm_agent_gm_to',
    {
      description:
        'Send an agent GM to another registered agent on gm.ink: calls gmTo(recipient) on DailyAgentGM (free except gas). BOTH sender and recipient must be registered agents, or the contract reverts. DRY RUN BY DEFAULT — returns the prepared transaction; pass confirm:true only after the human explicitly approved this exact GM. The wallet must hold a little ETH on Ink for gas (gas gate).',
      inputSchema: {
        privateKey: privateKeySchema.describe("The agent's private key (0x hex). Never stored or logged."),
        recipient: addressSchema.describe('Recipient agent wallet address (must be a registered agent)'),
        confirm: confirmSchema,
      },
    },
    async (args) => {
      try {
        const privateKey = args.privateKey as Hex;
        const account = privateKeyToAccount(privateKey).address;
        const recipient = getAddress(args.recipient);
        const gate = await checkGas(config, account);
        if (!gate.ok) return needsGasResult(gate);
        const client = publicClient(config);
        if (!(await readIsAgent(client, account))) {
          return errorResult(
            'sender is not a registered agent',
            'Run gm_register_agent first — DailyAgentGM only accepts GMs from wallets holding an ERC-8004 identity.',
          );
        }
        if (!(await readIsAgent(client, recipient))) {
          return errorResult(
            'recipient is not a registered agent',
            'gmTo requires BOTH sender and recipient to be registered agents — the contract reverts otherwise.',
          );
        }
        return runWrite(config, {
          account,
          privateKey,
          to: getAddress(DAILY_AGENT_GM_ADDRESS),
          data: encodeFunctionData({
            abi: dailyAgentGmAbi,
            functionName: 'gmTo',
            args: [recipient],
          }),
          confirm: args.confirm,
          actionLabel: `send an agent GM to ${recipient}`,
        });
      } catch (e) {
        return errorResult('gm_agent_gm_to failed', (e as Error).message);
      }
    },
  );

  // ---- GM reads ----

  server.registerTool(
    'gm_agent_status',
    {
      description:
        'One-shot agent-GM snapshot for a wallet on gm.ink: whether it is a registered agent, its last agent-GM timestamp, and whether the 24h cooldown has elapsed (can it GM now?). Read-only, no key needed.',
      inputSchema: {
        address: addressSchema.describe('Wallet address to check'),
      },
    },
    async (args) => {
      try {
        const account = getAddress(args.address);
        const client = publicClient(config);
        const [isAgent, lastGM] = await Promise.all([
          readIsAgent(client, account),
          readLastGM(client, account),
        ]);
        const now = Math.floor(Date.now() / 1000);
        const elapsed = lastGM > 0n ? now - Number(lastGM) : Number.POSITIVE_INFINITY;
        const canGmNow = isAgent && elapsed >= GM_COOLDOWN_SECONDS;
        const secondsUntilEligible =
          !isAgent || canGmNow ? 0 : Math.max(0, GM_COOLDOWN_SECONDS - elapsed);
        return textResult({
          ok: true,
          address: account,
          isAgent,
          lastGM: lastGM.toString(),
          lastGmAt: lastGM > 0n ? new Date(Number(lastGM) * 1000).toISOString() : null,
          canGmNow,
          secondsUntilEligible,
          nextEligibleAt:
            secondsUntilEligible > 0
              ? new Date((now + secondsUntilEligible) * 1000).toISOString()
              : null,
          cooldownSeconds: GM_COOLDOWN_SECONDS,
        });
      } catch (e) {
        return errorResult('gm_agent_status failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'gm_agent_last_gm',
    {
      description:
        'Raw lastGM(address) from DailyAgentGM on gm.ink: the unix timestamp of the wallet\'s most recent agent GM (0 = never). Read-only, no key needed.',
      inputSchema: {
        address: addressSchema.describe('Wallet address to check'),
      },
    },
    async (args) => {
      try {
        const account = getAddress(args.address);
        const lastGM = await readLastGM(publicClient(config), account);
        return textResult({
          ok: true,
          address: account,
          lastGM: lastGM.toString(),
          lastGmAt: lastGM > 0n ? new Date(Number(lastGM) * 1000).toISOString() : null,
        });
      } catch (e) {
        return errorResult('gm_agent_last_gm failed', (e as Error).message);
      }
    },
  );

  return server;
}

// ---- stdio entrypoint ----

async function main(): Promise<void> {
  const config = loadGmRegimentConfig();
  const server = createGmRegimentServer(config);
  const transport = new StdioServerTransport();
  // Never log to stdout: it corrupts the MCP stdio protocol. stderr only.
  console.error(
    `[gm-regiment-mcp] serving over stdio (rpc=${config.inkRpcUrl}, registry=${IDENTITY_REGISTRY_ADDRESS}, agentGM=${DAILY_AGENT_GM_ADDRESS})`,
  );
  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[gm-regiment-mcp] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
