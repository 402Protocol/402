/**
 * TaaP multi-chain venue proof — 0x as the universal venue across the MVP chains.
 *
 *   npm run taap:multichainproof
 *
 * For each MVP chain (ethereum, ink, robinhood) drives the paper MCP through:
 *
 *   get_started -> paper_faucet -> swap_quote
 *
 * swap_quote races every configured venue (KyberSwap where it serves the chain,
 * 0x on all EVM chains when a key is present) and best-net-of-fee wins. Quotes
 * are REAL; the one fill at the end is PAPER. 0x calls route through the 0x
 * skill CLI (stored credential as surrogate); everything else goes via curl.
 * Dogfood-only shims — production uses native fetch + ZEROEX_API_KEY env.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTaapServer } from './server.js';
import { TaapDb } from './db.js';

const execFileAsync = promisify(execFile);
const ZEROX_CLI = `${process.env.HOME}/workspace/skills/0x/bin/0x-price`;

async function proofFetch(url: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  const u = String(url);
  if (u.includes('api.0x.org')) {
    const q = new URL(u).searchParams;
    const { stdout } = await execFileAsync('python3', [
      ZEROX_CLI,
      '--chain-id', q.get('chainId') ?? '1',
      '--sell-token', q.get('sellToken') ?? '',
      '--buy-token', q.get('buyToken') ?? '',
      '--sell-amount', q.get('sellAmount') ?? '0',
    ]);
    const body = stdout.trim();
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as unknown as Response;
  }
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '25', u];
  for (const [k, v] of Object.entries(init?.headers ?? {})) args.push('-H', `${k}: ${v}`);
  const { stdout } = await execFileAsync('curl', args);
  const idx = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(idx + 1).trim());
  const body = stdout.slice(0, idx);
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(body), text: async () => body,
  } as unknown as Response;
}
globalThis.fetch = proofFetch as unknown as typeof fetch;

const CHAINS = [
  {
    chain: 'ethereum',
    token_in: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    token_out: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol_in: 'USDC', symbol_out: 'WETH', decimals_in: 6, decimals_out: 18,
    amount: '100',
  },
  {
    chain: 'ink',
    token_in: '0x2D270e6886d130D724215A266106e6832161EAEd',
    token_out: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    symbol_in: 'USDC', symbol_out: 'ETH', decimals_in: 6, decimals_out: 18,
    amount: '10',
  },
  {
    chain: 'robinhood',
    // Canonical per docs.robinhood.com + Uniswap/Blockscout corroboration:
    // USDG (Paxos Global Dollar, 6dp) is the native stable; USDC is not on 4663.
    token_in: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    token_out: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    symbol_in: 'USDG', symbol_out: 'WETH', decimals_in: 6, decimals_out: 18,
    amount: '10',
  },
];

const db = new TaapDb(':memory:');
// Placeholder key: the fetch shim routes api.0x.org through the 0x skill CLI,
// which attaches the real stored credential. Production uses ZEROEX_API_KEY.
const server = createTaapServer({ db, config: { mode: 'paper', dbPath: ':memory:', zeroExApiKey: 'via-0x-skill-cli' } });
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'multichainproof', version: '0.1.0' });
await Promise.all([client.connect(ct), server.connect(st)]);

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const c = res as { content: { type: string; text: string }[] };
  return JSON.parse(c.content[0].text);
}

let failed = 0;
let trader = '';
const winners: Record<string, string> = {};

const g = await tool('get_started', {});
trader = g.trader_id;
console.log(`trader: ${trader}\n`);

for (const c of CHAINS) {
  console.log(`===== ${c.chain}: ${c.amount} ${c.symbol_in} -> ${c.symbol_out} =====`);
  try {
    await tool('paper_faucet', {
      trader_id: trader, chain: c.chain, token_address: c.token_in,
      symbol: c.symbol_in, decimals: c.decimals_in, amount: c.amount,
    });
    const q = await tool('swap_quote', {
      trader_id: trader, chain: c.chain,
      token_in: c.token_in, token_out: c.token_out,
      symbol_in: c.symbol_in, symbol_out: c.symbol_out,
      decimals_in: c.decimals_in, decimals_out: c.decimals_out,
      amount: c.amount,
    });
    if (!q.ok) throw new Error(q.detail ?? 'quote failed');
    winners[c.chain] = q.venue;
    const raced = (q.all_venues ?? []).map((v: any) => v.venue).join(', ');
    console.log(`venues raced: ${raced || q.venue}`);
    console.log(`winner: ${q.venue} | gross ${q.amount_out_gross} | fee ${q.fee} | net ${q.amount_out_net}`);
    // One paper fill on ethereum to close the loop through a raced quote.
    if (c.chain === 'ethereum') {
      const f = await tool('swap_execute', { trader_id: trader, quote_id: q.quote_id, user_approved: true });
      if (!f.ok) throw new Error(f.detail ?? 'fill failed');
      console.log(`paper fill: ${f.paper_ref}`);
    }
    console.log('ok\n');
  } catch (e) {
    failed++;
    console.error(`FAIL ${(e as Error).message}\n`);
  }
}

console.log('venue winners:', JSON.stringify(winners));
console.log(failed === 0 ? 'MULTICHAIN PROOF GREEN' : `${failed} chain(s) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
db.close();
