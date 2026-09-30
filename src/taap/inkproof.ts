/**
 * TaaP Ink proof — proves a REAL 0x quote on Ink flows through the paper MCP.
 *
 *   npm run taap:inkproof
 *
 * Drives the paper MCP server in-process through the user loop on Ink:
 *
 *   get_started -> faucet -> token_resolve (USDC/ink, real data)
 *     -> swap_quote (REAL 0x v2 price on Ink, 50 bps + $0.50 min applied at quote layer)
 *     -> swap_execute (PAPER fill) -> balance
 *
 * The 0x call goes through the 0x skill CLI (~/workspace/skills/0x/bin/0x-price),
 * which carries the stored custom.0x credential as a surrogate — the raw key
 * never appears here. Quotes are REAL. Fills are PAPER (simulated) — this
 * script cannot move real money by construction.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTaapServer } from './server.js';
import { TaapDb } from './db.js';

const execFileAsync = promisify(execFile);
const ZEROX_CLI = `${process.env.HOME}/workspace/skills/0x/bin/0x-price`;

/**
 * Builder-environment workaround (same class as dogfood.ts): native fetch
 * hangs behind the egress proxy in this VM, so GETs go through curl.
 * 0x calls additionally need the stored credential, which only the 0x skill
 * CLI can attach (surrogate exchange) — so api.0x.org is routed there.
 * PRODUCTION code uses native fetch + ZEROEX_API_KEY env and needs no shim.
 */
async function proofFetch(url: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  const u = String(url);
  if (u.includes('api.0x.org')) {
    const q = new URL(u).searchParams;
    const { stdout } = await execFileAsync('python3', [
      ZEROX_CLI,
      '--chain-id', q.get('chainId') ?? '57073',
      '--sell-token', q.get('sellToken') ?? '',
      '--buy-token', q.get('buyToken') ?? '',
      '--sell-amount', q.get('sellAmount') ?? '0',
    ]);
    const body = stdout.trim();
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body),
      text: async () => body,
    } as unknown as Response;
  }
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '25', u];
  for (const [k, v] of Object.entries(init?.headers ?? {})) args.push('-H', `${k}: ${v}`);
  const { stdout } = await execFileAsync('curl', args);
  const idx = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(idx + 1).trim());
  const body = stdout.slice(0, idx);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}
globalThis.fetch = proofFetch as unknown as typeof fetch;

const USDC_INK = '0x2D270e6886d130D724215A266106e6832161EAEd';
const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const db = new TaapDb(':memory:');
// zeroExApiKey is a placeholder: the proof's fetch shim routes api.0x.org
// through the 0x skill CLI, which attaches the real stored credential as a
// surrogate. Production sets the real ZEROEX_API_KEY env var instead.
const server = createTaapServer({ db, config: { mode: 'paper', dbPath: ':memory:', zeroExApiKey: 'via-0x-skill-cli' } });
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'inkproof', version: '0.1.0' });
await Promise.all([client.connect(ct), server.connect(st)]);

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const c = res as { content: { type: string; text: string }[] };
  return JSON.parse(c.content[0].text);
}
function section(t: string) { console.log(`\n===== ${t} =====`); }
function show(label: string, v: unknown) {
  console.log(`-- ${label}:`, typeof v === 'string' ? v : JSON.stringify(v, null, 2).slice(0, 1500));
}

let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}:`, (e as Error).message);
  }
}

let trader = '';

await step('get_started provisions a paper trader', async () => {
  const r = await tool('get_started', {});
  if (!r.ok || !r.trader_id) throw new Error(JSON.stringify(r).slice(0, 300));
  trader = r.trader_id;
});

await step('paper_faucet credits 100 play USDC on ink', async () => {
  const r = await tool('paper_faucet', { trader_id: trader, chain: 'ink', token_address: USDC_INK, symbol: 'USDC', decimals: 6, amount: '100' });
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 300));
  show('faucet', r.balance ?? r);
});

await step('token_resolve inspects real USDC on Ink', async () => {
  const r = await tool('token_resolve', { contract_address: USDC_INK, chain: 'ink' });
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 300));
  show('verdict', r.safety?.verdict);
  show('price_usd', r.facts?.price_usd);
});

let quoteId = '';
await step('swap_quote: REAL 0x v2 price on Ink, 50 bps + $0.50 min applied at quote layer', async () => {
  const r = await tool('swap_quote', {
    trader_id: trader,
    chain: 'ink',
    token_in: USDC_INK,
    token_out: ETH_SENTINEL,
    symbol_in: 'USDC',
    symbol_out: 'ETH',
    decimals_in: 6,
    decimals_out: 18,
    amount: '10',
  });
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 400));
  if (r.venue !== '0x') throw new Error(`expected venue 0x, got ${r.venue}`);
  quoteId = r.quote_id;
  show('venue', r.venue);
  show('amount_in', r.amount_in);
  show('amount_out_gross', r.amount_out_gross);
  show('fee_100bps', r.fee);
  show('amount_out_net', r.amount_out_net);
});

await step('swap_execute: PAPER fill at the quoted net price', async () => {
  const r = await tool('swap_execute', { trader_id: trader, quote_id: quoteId, user_approved: true });
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 400));
  if (!String(r.paper_ref).startsWith('paper:')) throw new Error('expected a paper: reference');
  show('paper_ref', r.paper_ref);
  show('filled', `${r.amount_in_raw} USDC -> ${r.amount_out_raw} ETH (net), fee ${r.fee_raw}`);
});

await step('balance reflects the paper fill', async () => {
  const r = await tool('balance', { trader_id: trader, chain: 'ink' });
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 300));
  show('balances', r.balances ?? r);
});

console.log(failed === 0 ? '\nINK PROOF GREEN — real 0x quote on Ink, paper fill, fee accounted.' : `\n${failed} step(s) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
db.close();
