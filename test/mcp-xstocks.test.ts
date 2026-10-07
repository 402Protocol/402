/**
 * xStocks MCP tools smoke tests (offline fixtures by default).
 *
 *   npx tsx test/mcp-xstocks.test.ts
 *
 * FOUR02_TEST_LIVE=1 opts into the original read-only 0x API + Ink RPC smoke
 * test and requires the local 0x credential helpers. CI uses canned quotes
 * and RPC responses. Nothing is signed or broadcast in either mode.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getAddress, isAddress, toHex } from 'viem';
import { createMcpServer, loadMcpConfig } from '../src/mcp/server.js';
import { USDG_ADDRESS, XSTOCK_POOLS } from '../src/mcp/xstocks.js';

if (process.env.FOUR02_TEST_LIVE !== '1') {
  const spender = getAddress('0x1111111111111111111111111111111111111111');
  mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[] = []) => {
    assert.ok(file.endsWith('/0x-price') || (file === 'python3' && args[0]?.endsWith('/ox-swap-quote.py')),
      `unexpected external command: ${file}`);
    const arg = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(arg('--chain-id'), '57073');
    const sellAmount = BigInt(arg('--sell-amount'));
    const buyToken = getAddress(arg('--buy-token'));
    const stockLeg = XSTOCK_POOLS.some((pool) => pool.wrapped === buyToken);
    assert.ok(stockLeg || buyToken === USDG_ADDRESS);
    // Fixed fixture: USDC/USDG at par, wrapped shares at $100 each.
    const gross = stockLeg ? sellAmount * 10n ** 12n / 100n : sellAmount;
    const bps = args.includes('--fee-bps') ? BigInt(arg('--fee-bps')) : 0n;
    const feeAmount = gross * bps / 10_000n;
    return JSON.stringify({
      sellAmount: sellAmount.toString(),
      buyAmount: (gross - feeAmount).toString(),
      liquidityAvailable: true,
      estimatedPriceImpact: '0',
      transaction: { to: spender, data: '0x1234', value: '0' },
      issues: { allowance: { spender } },
      ...(bps ? { integratorFee: { amount: feeAmount.toString(), token: buyToken } } : {}),
    });
  });
  // Update named ESM imports of the mocked built-in used by xstocks.ts.
  syncBuiltinESMExports();
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    assert.ok(['eth_call', 'eth_getBalance'].includes(request.method), `unexpected RPC: ${request.method}`);
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: request.method === 'eth_call' ? toHex(0n, { size: 32 }) : '0x0',
    }), { headers: { 'content-type': 'application/json' } });
  });
}

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

await check('xstocks_buy with fee configured discloses + takes integrator fee', async () => {
  process.env.FOUR02_XSTOCKS_FEE_BPS = '50';
  process.env.FOUR02_XSTOCKS_FEE_RECIPIENT = '0xaA4E163dA1545F6967d284C0C5CFA469C644eD23';
  const feeServer = createMcpServer(loadMcpConfig());
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  const feeClient = new Client({ name: 'xstocks-fee-test-client', version: '0.0.0' });
  await Promise.all([feeClient.connect(ct2), feeServer.connect(st2)]);
  const d = textOf(
    await feeClient.callTool({
      name: 'xstocks_buy',
      arguments: { ticker: 'AAPL', amountUsd: '10', walletAddress: PROBE_WALLET, backupVerified: true },
    }),
  );
  assert.equal(d.ok, true);
  assert.equal(d.fee.feeBps, 50);
  assert.equal(d.fee.feeRecipient, getAddress('0xaA4E163dA1545F6967d284C0C5CFA469C644eD23'));
  assert.ok(d.fee.taken, 'integrator fee should be reported');
  assert.equal(d.fee.taken.token, 'wAAPLx');
  assert.ok(parseFloat(d.fee.taken.amount) > 0, 'fee amount must be positive');
  assert.equal(d.fee.taken.recipient, getAddress('0xaA4E163dA1545F6967d284C0C5CFA469C644eD23'));
  // buyAmount is net of the 50 bps fee
  const q = textOf(
    await client.callTool({ name: 'xstocks_quote', arguments: { ticker: 'AAPL', amountUsd: '10' } }),
  );
  assert.ok(
    parseFloat(d.expectedWrappedOut) < parseFloat(q.expectedWrappedOut),
    'fee-on buy should net less than the fee-free quote',
  );
  delete process.env.FOUR02_XSTOCKS_FEE_BPS;
  delete process.env.FOUR02_XSTOCKS_FEE_RECIPIENT;
  await feeClient.close();
  await feeServer.close();
});

await client.close();
await mcpServer.close();
mock.restoreAll();
syncBuiltinESMExports();

console.log(`\n${passed} xstocks checks passed${process.exitCode ? ' (with failures)' : ''}`);
