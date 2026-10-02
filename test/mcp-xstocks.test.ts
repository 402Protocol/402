/**
 * xStocks MCP tools smoke tests (live Ink mainnet, read-only + tx building).
 *
 *   npx tsx test/mcp-xstocks.test.ts
 *
 * Hits the 0x v2 API (stored custom.0x credential) and Ink RPC for quotes and
 * unsigned-tx building. NOTHING IS SIGNED OR BROADCAST — the tools only build
 * calldata. Amounts are tiny ($10) and read-only.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getAddress, isAddress } from 'viem';
import { createMcpServer, loadMcpConfig } from '../src/mcp/server.js';

// A well-known wallet with no xStock activity; used only as taker/quote subject.
const PROBE_WALLET = getAddress('0xB17e7B5e6B5e1777dD62c583C9D4AfFB183f2D7E');

const mcpServer = createMcpServer(loadMcpConfig());
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'xstocks-test-client', version: '0.0.0' });
await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

function textOf(res: any): any {
  const t = res?.content?.[0]?.text;
  assert.ok(t, 'tool returned no text content');
  return JSON.parse(t);
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

await check('xstocks_list returns 9 pools + 3 baskets', async () => {
  const d = textOf(await client.callTool({ name: 'xstocks_list', arguments: {} }));
  assert.equal(d.ok, true);
  assert.equal(d.pools.length, 9);
  assert.ok(d.pools.every((p: any) => isAddress(p.wrappedToken) && p.poolId.startsWith('0x')));
  assert.deepEqual(Object.keys(d.baskets).sort(), ['all', 'bigtech', 'yolo']);
  assert.equal(d.baskets.all.tickers.length, 9);
});

await check('xstocks_quote AAPL $10 returns two legs', async () => {
  const d = textOf(
    await client.callTool({ name: 'xstocks_quote', arguments: { ticker: 'AAPL', amountUsd: '10' } }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.legs.length, 2);
  assert.equal(d.legs[0].sell, 'USDC');
  assert.equal(d.legs[0].buy, 'USDG');
  assert.equal(d.legs[1].buy, 'wAAPLx');
  assert.ok(parseFloat(d.expectedWrappedOut) > 0, 'expected output must be positive');
});

await check('xstocks_quote rejects unknown ticker', async () => {
  const res: any = await client.callTool({ name: 'xstocks_quote', arguments: { ticker: 'MSFT', amountUsd: '10' } });
  assert.equal(res.isError, true);
  assert.match(String(res.content?.[0]?.text), /Unknown ticker/);
});

await check('xstocks_buy without backupVerified returns the ritual', async () => {
  const d = textOf(
    await client.callTool({
      name: 'xstocks_buy',
      arguments: { ticker: 'AAPL', amountUsd: '10', walletAddress: PROBE_WALLET, backupVerified: false },
    }),
  );
  assert.equal(d.ok, false);
  assert.equal(d.blocked, 'backup ritual incomplete');
  assert.ok(Array.isArray(d.do_this_first) && d.do_this_first.length >= 4);
});

await check('xstocks_buy builds ordered unsigned txs', async () => {
  const d = textOf(
    await client.callTool({
      name: 'xstocks_buy',
      arguments: { ticker: 'NVDA', amountUsd: '10', walletAddress: PROBE_WALLET, backupVerified: true },
    }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.chainId, 57073);
  assert.ok(parseFloat(d.expectedWrappedOut) > 0);
  assert.ok(d.transactions.length >= 2, 'expect approve + swaps');
  assert.match(d.transactions[0].purpose, /approve/);
  assert.ok(d.transactions.every((t: any) => isAddress(t.to) && t.data.startsWith('0x')));
  assert.ok(d.transactions.some((t: any) => /USDG -> wNVDAx/.test(t.purpose)));
});

await check('xstocks_sell all with empty balance fails cleanly', async () => {
  const res: any = await client.callTool({
    name: 'xstocks_sell',
    arguments: { ticker: 'AAPL', amountWrapped: 'all', walletAddress: PROBE_WALLET, backupVerified: true },
  });
  assert.equal(res.isError, true);
  assert.match(String(res.content?.[0]?.text), /holds no wAAPLx/);
});

await check('xstocks_basket_buy bigtech $30 quotes 5 legs', async () => {
  const d = textOf(
    await client.callTool({
      name: 'xstocks_basket_buy',
      arguments: { basket: 'bigtech', amountUsd: '30', walletAddress: PROBE_WALLET, backupVerified: true },
    }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.breakdown.length, 5);
  assert.deepEqual(d.breakdown.map((b: any) => b.ticker).sort(), ['AAPL', 'AMZN', 'GOOGL', 'NVDA', 'TSLA']);
  // 1 funding swap + 5 ticker swaps (+ up to 2 approvals)
  assert.ok(d.transactions.length >= 6, `got ${d.transactions.length} txs`);
  assert.match(d.transactions[0].purpose, /approve|swap .* USDC -> USDG/);
});

await check('xstocks_basket_sell with no holdings reports empty', async () => {
  const d = textOf(
    await client.callTool({
      name: 'xstocks_basket_sell',
      arguments: { basket: 'yolo', walletAddress: PROBE_WALLET, backupVerified: true },
    }),
  );
  assert.equal(d.ok, true);
  assert.deepEqual(d.sold, []);
});

await check('xstocks_balance reads wallet', async () => {
  const d = textOf(
    await client.callTool({ name: 'xstocks_balance', arguments: { walletAddress: PROBE_WALLET } }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.wallet, PROBE_WALLET);
  assert.ok(typeof d.usdc === 'string' && typeof d.eth === 'string');
});

console.log(`\n${passed} xstocks checks passed${process.exitCode ? ' (with failures)' : ''}`);
