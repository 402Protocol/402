/**
 * 402 MCP server smoke tests.
 *
 *   npx tsx test/mcp.test.ts
 *
 * Spins a real facilitator (+ Lounge with :memory: SQLite) on an ephemeral
 * port, then drives the MCP server in-process via InMemoryTransport.
 * Keys: throwaway keys generated in-process for tests only.
 */
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, isAddress, parseUnits } from 'viem';
import { createApp } from '../src/facilitator/server.js';
import { loadConfig } from '../src/facilitator/config.js';
import { NonceStore } from '../src/facilitator/nonces.js';
import { INK_CONFIG } from '../src/facilitator/chains.js';
import { createMcpServer, loadMcpConfig } from '../src/mcp/server.js';
import { USDC_DECIMALS } from '../src/constants.js';

const issuerKey = generatePrivateKey();
const issuer = privateKeyToAccount(issuerKey);
const treasury = privateKeyToAccount(generatePrivateKey()).address;

// Facilitator env for the in-process server (throwaway values only).
process.env.FOUR02_SETTLER_KEY = generatePrivateKey();
process.env.FOUR02_DRY_RUN = 'true';
process.env.FOUR02_DEMO_PAYTO = privateKeyToAccount(generatePrivateKey()).address;
process.env.FOUR02_SETTLE_API_KEYS = 'test-settle-key';
process.env.LOUNGE_TREASURY = treasury;
process.env.LOUNGE_DB_PATH = ':memory:';

const app = createApp(loadConfig(), new NonceStore(), {
  lounge: (await import('../src/lounge/config.js')).loadLoungeConfig(),
});
const listener = serve({ fetch: app.fetch, port: 0 });
await new Promise<void>((resolve) => listener.addListener('listening', resolve));
const addr = listener.address();
if (!addr || typeof addr === 'string') throw new Error('no listener address');
const base = `http://127.0.0.1:${addr.port}`;

process.env.FOUR02_FACILITATOR_URL = base;
process.env.FOUR02_MCP_INVOICE_KEY = issuerKey;

const mcpServer = createMcpServer(loadMcpConfig());
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test-client', version: '0.0.0' });
await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function toolText(res: unknown): Record<string, unknown> {
  const r = res as { content: { type: string; text: string }[] };
  assert.equal(r.content[0].type, 'text');
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

await check('lists 7 tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'facilitator_supported',
    'facilitator_verify',
    'invoice_create',
    'invoice_status',
    'lounge_feed',
    'lounge_post',
    'wallet_create',
  ]);
});

await check('wallet_create returns a fresh unique keypair (never stored)', async () => {
  const a = toolText(await client.callTool({ name: 'wallet_create', arguments: {} }));
  const b = toolText(await client.callTool({ name: 'wallet_create', arguments: {} }));
  assert.equal(a.ok, true);
  assert.ok(isAddress(a.address as string), 'address must be a valid EVM address');
  assert.match(a.privateKey as string, /^0x[0-9a-fA-F]{64}$/, 'key must be 0x 32-byte hex');
  assert.equal(
    getAddress(privateKeyToAccount(a.privateKey as `0x${string}`).address),
    getAddress(a.address as string),
    'address must derive from the returned key',
  );
  assert.notEqual(a.privateKey, b.privateKey, 'each call must generate a fresh key');
  assert.ok((a.warning as string).includes('no recovery'), 'must warn about backup');
});

await check('facilitator_supported hits the live in-process facilitator', async () => {
  const out = toolText(await client.callTool({ name: 'facilitator_supported', arguments: {} }));
  const kinds = out.kinds as { network: string }[];
  assert.ok(kinds.some((k) => k.network === INK_CONFIG.caip2), 'missing Ink kind');
});

let signedInvoiceJson = '';
await check('invoice_create signs with FOUR02_MCP_INVOICE_KEY', async () => {
  const out = toolText(
    await client.callTool({
      name: 'invoice_create',
      arguments: {
        issuer: issuer.address,
        amountUsdc: '2.50',
        description: 'mcp test invoice',
        expiresInSeconds: 3600,
      },
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.signed, true);
  assert.ok(out.id, 'missing invoice id');
  assert.ok((out.signature as string).startsWith('0x'));
  const inv = out.invoice as { amount: string; payer: string };
  assert.equal(inv.amount, parseUnits('2.50', USDC_DECIMALS).toString());
  assert.equal(getAddress(inv.payer), getAddress('0x0000000000000000000000000000000000000000'));
  signedInvoiceJson = JSON.stringify({ invoice: out.invoice, signature: out.signature, id: out.id });
});

await check('invoice_status verifies the created invoice', async () => {
  const out = toolText(
    await client.callTool({
      name: 'invoice_status',
      arguments: { signedInvoiceJson, lookbackBlocks: 100 },
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.valid, true);
  assert.equal(getAddress(out.signer as string), getAddress(issuer.address));
});

await check('invoice_create without env key returns unsigned invoice + signing instructions', async () => {
  const cfg = loadMcpConfig({ ...process.env, FOUR02_MCP_INVOICE_KEY: undefined });
  const s2 = createMcpServer(cfg);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c2 = new Client({ name: 'test-client-2', version: '0.0.0' });
  await Promise.all([c2.connect(ct), s2.connect(st)]);
  const out = toolText(
    await c2.callTool({
      name: 'invoice_create',
      arguments: { issuer: issuer.address, amountUsdc: '0.01', description: 'unsigned' },
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.signed, false);
  assert.ok(out.id, 'missing id');
  assert.ok((out.howToSign as string).includes('402 Invoice'));
  await c2.close();
});

await check('lounge_feed returns the (empty) feed', async () => {
  const out = toolText(
    await client.callTool({ name: 'lounge_feed', arguments: { sort: 'new', limit: 5 } }),
  );
  assert.ok(Array.isArray(out.posts), 'expected posts array');
});

await check('lounge_post without key or signature explains how to sign (never throws)', async () => {
  const out = toolText(
    await client.callTool({
      name: 'lounge_post',
      arguments: {
        title: 'hello',
        body: 'test post',
        paymentTxHash: '0x' + 'ab'.repeat(32),
      },
    }),
  );
  assert.equal(out.ok, false);
  assert.ok((out.error as string).includes('FOUR02_MCP_LOUNGE_KEY'));
});

await check('facilitator_verify rejects garbage payloads cleanly', async () => {
  const out = toolText(
    await client.callTool({
      name: 'facilitator_verify',
      arguments: { paymentPayload: { nope: true }, paymentRequirements: { nope: true } },
    }),
  );
  assert.equal((out as { isValid: boolean }).isValid, false);
});

await client.close();
listener.close();

console.log(`\n${passed} mcp tests passed${process.exitCode ? ' (with failures)' : ''}`);
