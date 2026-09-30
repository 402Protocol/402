/**
 * TaaP dogfood — the "wire it into our agent" step.
 *
 *   npm run taap:dogfood
 *
 * Drives the paper MCP server in-process (real network: DexScreener, GoPlus,
 * KyberSwap — all free GET endpoints) through the full user loop:
 *
 *   get_started -> faucet -> token_resolve -> swap_quote -> swap_execute
 *     -> swap_status -> balance -> set_trigger -> check_triggers
 *     -> pause -> blocked fill -> resume -> withdraw
 *
 * Quotes and inspections are REAL. Fills are PAPER (simulated) — this
 * script cannot move real money by construction.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTaapServer } from './server.js';
import { TaapDb } from './db.js';

const execFileAsync = promisify(execFile);

/**
 * Builder-environment workaround: Node's native fetch does not honor the
 * egress proxy in this VM (it hangs), while curl does. The PRODUCTION server
 * code (src/taap/*.ts) uses native fetch and needs no shim — on Railway /
 * real hosts there is direct egress. This shim lives ONLY in the dogfood
 * script so the end-to-end pass can run here. GET-only, which is all the
 * data/quote adapters use.
 */
async function curlFetch(url: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '25', String(url)];
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
globalThis.fetch = curlFetch as unknown as typeof fetch;

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
// MVP main-loop chain: ethereum (KyberSwap serves it; Ink has no quote venue yet).
const CHAIN = 'ethereum';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
// Ink data-path check (USDC on Ink — inspection works, quotes fail closed).
const USDC_INK = '0x2D270e6886d130D724215A266106e6832161EAEd';

const db = new TaapDb(':memory:');
const server = createTaapServer({ db, config: { mode: 'paper', dbPath: ':memory:' } });
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'dogfood', version: '0.1.0' });
await Promise.all([client.connect(ct), server.connect(st)]);

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const c = res as { content: { type: string; text: string }[] };
  return JSON.parse(c.content[0].text);
}

function section(title: string) {
  console.log(`\n===== ${title} =====`);
}
function show(label: string, v: unknown) {
  console.log(`-- ${label}:`, typeof v === 'string' ? v : JSON.stringify(v, null, 2).slice(0, 1200));
}

let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`  !! step failed: ${(e as Error).message}`);
  }
}

// 1. onboard
let trader_id = '';
await step('get_started', async () => {
  section('1. get_started — provision paper trader');
  const r = await tool('get_started', {});
  if (!r.ok) throw new Error(r.error);
  trader_id = r.trader_id;
  show('trader_id', trader_id);
  show('fee_bps', r.fee_bps);
});

// 2. fund with play money
await step('paper_faucet', async () => {
  section('2. paper_faucet — $1,000 play USDC (the deposit is the signup, paper edition)');
  const r = await tool('paper_faucet', {
    trader_id, chain: CHAIN, token_address: USDC, symbol: 'USDC', decimals: 6, amount: '1000',
  });
  if (!r.ok) throw new Error(r.detail ?? r.error);
  show('credited', r.credited);
});

// 3. inspect the token (CA paste)
await step('token_resolve', async () => {
  section('3. token_resolve — inspect WETH on Base BEFORE any trade talk');
  const r = await tool('token_resolve', { contract_address: WETH, chain: CHAIN });
  if (!r.ok) throw new Error(r.detail ?? r.error);
  show('symbol', r.token.symbol);
  show('price_usd', r.facts.price_usd);
  show('liquidity_usd', r.facts.liquidity_usd);
  show('volume_24h_usd', r.facts.volume_24h_usd);
  show('verdict', r.safety.verdict);
  show('red_flags', r.safety.red_flags);
  show('checks', r.safety.checks.map((c: any) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`));
});

// 4. quote: buy $100 of WETH
let quote_id = '';
await step('swap_quote', async () => {
  section('4. swap_quote — buy $100 of WETH (dry, net of 50 bps + $0.50 min)');
  const r = await tool('swap_quote', {
    trader_id, chain: CHAIN,
    token_in: USDC, token_out: WETH,
    symbol_in: 'USDC', symbol_out: 'WETH',
    decimals_in: 6, decimals_out: 18, amount: '100',
  });
  if (!r.ok) throw new Error(r.detail ?? r.error);
  quote_id = r.quote_id;
  show('venue', r.venue);
  show('amount_in', `${r.amount_in} USDC`);
  show('amount_out_gross', `${r.amount_out_gross} WETH`);
  show('fee', `${r.fee} WETH`);
  show('amount_out_net', `${r.amount_out_net} WETH`);
});

// 5. execute (paper fill)
let trade_id = '';
await step('swap_execute', async () => {
  section('5. swap_execute — PAPER FILL at the quoted net price');
  const r = await tool('swap_execute', { trader_id, quote_id, user_approved: true });
  if (!r.ok) throw new Error(r.detail ?? r.error);
  trade_id = r.trade_id;
  show('status', r.status);
  show('paper_ref', r.paper_ref);
  show('filled', `${r.amount_in} USDC -> ${r.amount_out} WETH (fee ${r.fee} WETH)`);
});

// 6. status + 7. balance
await step('swap_status + balance', async () => {
  section('6-7. swap_status + balance — the portfolio view');
  const s = await tool('swap_status', { trade_id });
  show('trade status', s.status);
  const b = await tool('balance', { trader_id });
  show('balances', b.balances.map((x: any) => `${x.amount} ${x.symbol} (${x.chain})`));
  show('fees_accrued', b.fees_accrued);
});

// 8. standing strategy
let trigger_id = '';
await step('set_trigger', async () => {
  section('8. set_trigger — "sell half my WETH if it doubles"');
  const r = await tool('set_trigger', {
    trader_id, chain: CHAIN, token_address: WETH,
    sell_pct: 50, price_up_pct: 100,
    stable_token: USDC, stable_symbol: 'USDC', stable_decimals: 6,
  });
  if (!r.ok) throw new Error(r.detail ?? r.error);
  trigger_id = r.trigger_id;
  show('trigger_id', trigger_id);
  show('baseline', `$${r.baseline_price_usd}`);
  show('fires_at', `$${r.fires_when_usd}`);
  const c = await tool('check_triggers', {});
  show('watcher', c.reports);
  const l = await tool('list_triggers', { trader_id });
  show('triggers_armed', l.triggers.length);
  await tool('cancel_trigger', { trader_id, trigger_id });
  show('cancelled', 'yes (dogfood cleanup)');
});

// 9. kill switch
await step('kill switch', async () => {
  section('9. pause_trading — the kill switch, then resume');
  const p = await tool('pause_trading', { trader_id });
  show('paused', p.paused);
  // Fresh quote to try to fill while paused.
  const q = await tool('swap_quote', {
    trader_id, chain: CHAIN,
    token_in: USDC, token_out: WETH,
    symbol_in: 'USDC', symbol_out: 'WETH',
    decimals_in: 6, decimals_out: 18, amount: '10',
  });
  const blocked = await tool('swap_execute', { trader_id, quote_id: q.quote_id, user_approved: true });
  show('fill_while_paused', blocked.ok ? 'EXECUTED (!!)' : `blocked: ${blocked.detail}`);
  const r = await tool('resume_trading', { trader_id });
  show('resumed', !r.paused);
});

// 10. withdraw (paper, explicit approval)
await step('withdraw', async () => {
  section('10. withdraw — explicit read-back approval, paper-recorded');
  const no = await tool('withdraw', {
    trader_id, chain: CHAIN, token_address: USDC, symbol: 'USDC',
    amount: '50', destination: '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF', confirmed: false,
  });
  show('unconfirmed', no.ok ? 'EXECUTED (!!)' : `refused: ${no.error}`);
  const yes = await tool('withdraw', {
    trader_id, chain: CHAIN, token_address: USDC, symbol: 'USDC',
    amount: '50', destination: '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF', confirmed: true,
  });
  show('confirmed', `${yes.status} (${yes.withdrawal_id})`);
});

// 11. Ink: inspection works on our home chain; quotes fail closed (no venue yet)
await step('ink data path', async () => {
  section('11. ink — inspection live, quotes fail closed (honest, no venue wired)');
  const r = await tool('token_resolve', { contract_address: USDC_INK, chain: 'ink' });
  if (!r.ok) throw new Error(r.detail ?? r.error);
  show('ink USDC price_usd', r.facts.price_usd);
  show('ink USDC verdict', r.safety.verdict);
  const q = await tool('swap_quote', {
    trader_id, chain: 'ink',
    token_in: USDC_INK, token_out: USDC_INK,
    symbol_in: 'USDC', symbol_out: 'USDC',
    decimals_in: 6, decimals_out: 6, amount: '10',
  });
  show('ink quote', q.ok ? 'QUOTED (!!)' : `fails closed: ${q.detail ?? q.error}`);
});

section(failed === 0 ? 'DOGFOOD COMPLETE — all steps green' : `DOGFOOD DONE with ${failed} failed step(s)`);
db.close();
if (failed > 0) process.exitCode = 1;
