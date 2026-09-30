/**
 * four02-commerce-mcp tests.
 *
 *   npx tsx test/commerce-mcp.test.ts
 *
 * MCP-level tests drive the server in-process via InMemoryTransport.
 * Reputation reads are unit-tested against a mocked viem transport —
 * nothing here touches mainnet, broadcasts, or spends.
 * Keys: throwaway keys generated in-process for tests only.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  getAddress,
  parseAbiParameters,
  toFunctionSelector,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_REGISTRY_ADDRESS,
  ink,
  loadCommerceConfig,
} from '../src/config.js';
import { createCommerceServer } from '../src/server.js';
import { readHistory, readReliability, readSummary } from '../src/reputation.js';

const issuerKey = generatePrivateKey();
const issuer = privateKeyToAccount(issuerKey).address;
const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey).address;

// Point the RPC at a dead localhost port so chain-scan failures are fast
// and deterministic (no real network in tests).
process.env.FOUR02_COMMERCE_INK_RPC_URL = 'http://127.0.0.1:1';
process.env.FOUR02_COMMERCE_INVOICE_KEY = issuerKey;

const mcpServer = createCommerceServer(loadCommerceConfig());
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

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return JSON.parse(text);
}

// ---- config ----

await check('config defaults point at production', () => {
  const cfg = loadCommerceConfig({} as Record<string, string | undefined>);
  assert.equal(cfg.facilitatorUrl, 'https://402-production.up.railway.app');
  assert.equal(cfg.registryAddress, DEFAULT_REGISTRY_ADDRESS);
  assert.equal(cfg.invoiceSignerKey, undefined);
  assert.equal(cfg.payerKey, undefined);
});

// ---- tool catalog ----

await check('all six tools registered with four02_ prefix', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'four02_invoice_create',
    'four02_invoice_pay',
    'four02_invoice_status',
    'four02_reputation_history',
    'four02_reputation_reliability',
    'four02_reputation_summary',
  ]);
});

// ---- invoices ----

let signedInvoiceJson = '';

await check('invoice_create signs when env key matches issuer', async () => {
  const out = await callTool('four02_invoice_create', {
    issuer,
    payer,
    amountUsdc: '2.50',
    description: 'test line item',
  });
  assert.equal(out.ok, true);
  assert.equal(out.signed, true);
  assert.match(out.id, /^0x[0-9a-fA-F]{64}$/);
  assert.match(out.signature, /^0x[0-9a-fA-F]{130}$/);
  assert.equal(out.invoice.amount, '2500000');
  signedInvoiceJson = JSON.stringify(out, (_k, v) =>
    typeof v === 'bigint' ? `bigint:${v.toString()}` : v,
  );
});

await check('invoice_create returns unsigned when key does not match issuer', async () => {
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const out = await callTool('four02_invoice_create', {
    issuer: other,
    amountUsdc: '1.00',
    description: 'unsigned please',
  });
  assert.equal(out.ok, true);
  assert.equal(out.signed, false);
  assert.ok(out.howToSign.includes('402 Invoice'));
});

await check('invoice_create rejects bad amount', async () => {
  const out = await callTool('four02_invoice_create', {
    issuer,
    amountUsdc: '1.2345678',
    description: 'bad amount',
  });
  assert.equal(out.ok, false);
});

await check('invoice_status verifies signature (payment scan fails closed)', async () => {
  const out = await callTool('four02_invoice_status', { signedInvoiceJson });
  assert.equal(out.ok, true);
  assert.equal(out.valid, true);
  assert.equal(getAddress(out.signer), getAddress(issuer));
  assert.equal(out.amountUsdc, '2.5');
  // RPC is dead in tests: heuristic must fail closed, not throw.
  assert.equal(out.payment.likelyPaid, null);
  assert.ok(out.payment.note.includes('chain scan failed'));
});

await check('invoice_pay dry-run returns plan, broadcasts nothing', async () => {
  const out = await callTool('four02_invoice_pay', { signedInvoiceJson });
  assert.equal(out.ok, true);
  assert.equal(out.broadcast, false);
  assert.equal(out.plan.pay, '2.5 USDC');
  assert.equal(getAddress(out.plan.to), getAddress(issuer));
  assert.ok(!('txHash' in out));
});

await check('invoice_pay refuses broadcast without payer key', async () => {
  const out = await callTool('four02_invoice_pay', {
    signedInvoiceJson,
    approveBroadcast: true,
  });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('FOUR02_COMMERCE_PAYER_KEY'));
});

await check('invoice_pay refuses to pay a tampered invoice', async () => {
  const tampered = JSON.parse(signedInvoiceJson);
  tampered.invoice.amount = 'bigint:999999999';
  const out = await callTool('four02_invoice_pay', {
    signedInvoiceJson: JSON.stringify(tampered),
  });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('verification failed'));
});

// ---- reputation reads (mocked transport) ----

const SEL = {
  summary: toFunctionSelector('summary(uint256)'),
  reliability: toFunctionSelector('reliability(uint256)'),
  disputeRate: toFunctionSelector('disputeRate(uint256)'),
  readAllFeedback: toFunctionSelector(
    'readAllFeedback(uint256,address[],string,string,bool)',
  ),
};

function mockClient() {
  return createPublicClient({
    chain: ink,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_chainId') return '0xded9';
        if (method === 'eth_call') {
          const data = (params as [{ data: string }])[0].data;
          const sel = data.slice(0, 10);
          if (sel === SEL.summary) {
            // reliability=85, disputeRateBps=120, wins=3, losses=1,
            // totalEvents=12, lastEventTimestamp=1700000000
            return encodeAbiParameters(
              parseAbiParameters('uint256, uint256, uint256, uint256, uint256, uint64'),
              [85n, 120n, 3n, 1n, 12n, 1700000000n],
            );
          }
          if (sel === SEL.reliability) {
            return encodeAbiParameters(parseAbiParameters('uint256'), [85n]);
          }
          if (sel === SEL.disputeRate) {
            return encodeAbiParameters(parseAbiParameters('uint256'), [120n]);
          }
          if (sel === SEL.readAllFeedback) {
            const writer = '0x1111111111111111111111111111111111111111';
            return encodeAbiParameters(
              parseAbiParameters(
                'address[], uint64[], int128[], uint8[], string[], string[], bool[]',
              ),
              [
                [writer, writer],
                [1n, 2n],
                [1500000n, 2500000n],
                [6, 6],
                ['invoice_paid_on_time', 'escrow_completed'],
                ['402:commerce', '402:commerce'],
                [false, false],
              ],
            );
          }
          throw new Error(`unexpected selector ${sel}`);
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
}

const registry = getAddress(DEFAULT_REGISTRY_ADDRESS);

await check('readSummary decodes the registry snapshot', async () => {
  const s = await readSummary(mockClient(), registry, 42n);
  assert.equal(s.agentId, '42');
  assert.equal(s.reliability, 85);
  assert.equal(s.disputeRateBps, 120);
  assert.equal(s.arbitrationWins, 3);
  assert.equal(s.arbitrationLosses, 1);
  assert.equal(s.totalEvents, 12);
  assert.equal(s.lastEventTimestamp, 1700000000);
});

await check('readReliability decodes score + dispute rate', async () => {
  const r = await readReliability(mockClient(), registry, 42n);
  assert.equal(r.reliability, 85);
  assert.equal(r.disputeRateBps, 120);
});

await check('readHistory decodes feedback entries with USDC values', async () => {
  const h = await readHistory(mockClient(), registry, 42n, 50);
  assert.equal(h.count, 2);
  assert.equal(h.returned, 2);
  assert.equal(h.entries[0].eventType, 'invoice_paid_on_time');
  assert.equal(h.entries[0].valueUsdc, '1.5');
  assert.equal(h.entries[1].eventType, 'escrow_completed');
  assert.equal(h.entries[1].valueUsdc, '2.5');
  assert.equal(h.entries[0].namespace, '402:commerce');
});

await check('readHistory honors limit from the newest end', async () => {
  const h = await readHistory(mockClient(), registry, 42n, 1);
  assert.equal(h.count, 2);
  assert.equal(h.returned, 1);
  assert.equal(h.entries[0].eventType, 'escrow_completed');
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.log('SOME CHECKS FAILED');
