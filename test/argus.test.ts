/**
 * Argus paper-trader tests.
 *
 *   npx tsx test/argus.test.ts
 *
 * Covers: venue x18 parsing, strategy signal logic (MA cross up/down/flat,
 * insufficient history), funding filter (block/pass/fail-closed), the strategy
 * engine pipeline (signal/filtered/no-signal + proposal shape), paper executor
 * fill math (long + short, exact fees), stop-loss and liquidation guards, and
 * ADVERSARIAL risk-limit tests (oversized, over-leverage, kill switch, daily
 * halt, max positions, duplicate product — plus proof the executor sanity-checks
 * insane inputs), ArgusDb roundtrips, the /argus HTTP contract (including the
 * kill route's fail-closed behavior), and trade-post formatting.
 *
 * No network, no keys, nothing broadcast. The engine tick loop is NOT started.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { fromX18 } from '../src/argus/venue.js';
import {
  ARGUS_UNIVERSE,
  DAILY_LOSS_CAP_USD,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS,
  MAX_POSITION_NOTIONAL_USD,
  START_BANKROLL_USD,
  TRADE_LEVERAGE,
  TRADE_NOTIONAL_USD,
  type Candle,
  type Side,
  type TradeProposal,
} from '../src/argus/types.js';
import {
  MaCrossSignal,
  combineVotes,
  defaultSignals,
  sma,
  type SignalInput,
} from '../src/argus/strategy/signals.js';
import {
  FundingFilter,
  FilterRegistry,
  defaultFilters,
} from '../src/argus/strategy/filters.js';
import { NeutralRegime } from '../src/argus/strategy/regime.js';
import { StrategyEngine } from '../src/argus/strategy/engine.js';
import { ArgusRisk, nextUtcDayStart, utcDayStart } from '../src/argus/risk.js';
import { PaperExecutor } from '../src/argus/executor.js';
import { ArgusDb } from '../src/argus/db.js';
import { createArgusApp } from '../src/argus/server.js';
import { ARGUS_AUTHOR, formatTradePost } from '../src/argus/feed.js';
import type { ArgusEngine } from '../src/argus/engine.js';

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

function approx(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

/** Build oldest-first candles with given closes. */
function mkCandles(closes: number[], stepSec: number, startTs = 1_700_000_000): Candle[] {
  return closes.map((close, i) => ({
    time: startTs + i * stepSec,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 1000,
  }));
}

// 19 x 4h candles: 12 x 90 then 6 x 120, plus forming candle at 120.
// -> fast crosses above slow (100): BULLISH.
const BULL_4H = mkCandles(
  [...Array(12).fill(90), ...Array(6).fill(120), 120],
  14400,
);
// 19 x 4h candles: 12 x 110 then 6 x 80, plus forming. -> BEARISH.
const BEAR_4H = mkCandles(
  [...Array(12).fill(110), ...Array(6).fill(80), 80],
  14400,
);
// Flat: everything 100. -> no cross.
const FLAT_4H = mkCandles(Array(19).fill(100), 14400);
// 12 x 1d candles flat at 100, plus forming.
const FLAT_1D = mkCandles(Array(12).fill(100), 86400);

function signalInput(over: Partial<SignalInput> = {}): SignalInput {
  return {
    productId: 2,
    ticker: 'BTC-PERP',
    candles4h: BULL_4H,
    candles1d: FLAT_1D,
    markPrice: 100,
    fundingRate: 0.0001,
    now: 1_800_000_000,
    ...over,
  };
}

function mkProposal(over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    productId: 2,
    ticker: 'BTC-PERP',
    side: 'long',
    notionalUsd: TRADE_NOTIONAL_USD,
    leverage: TRADE_LEVERAGE,
    refPrice: 100,
    stopPrice: 98,
    fundingRate: 0.0001,
    maFast: 105,
    maSlow: 100,
    maFastPrev: 90,
    maSlowPrev: 100,
    reasoning: ['test'],
    createdAt: 1_800_000_000,
    ...over,
  };
}

// ---------- venue ----------

await check('fromX18 converts x18 fixed-point strings', () => {
  assert.equal(fromX18('84563000000000000000000'), 84563);
  assert.equal(fromX18('1000000000000000000'), 1);
  assert.equal(fromX18('-61059947957042')! < 0, true);
  assert.equal(fromX18('garbage'), null);
  assert.equal(fromX18(null), null);
});

// ---------- strategy: sma + cross ----------

await check('sma math + insufficient history', () => {
  assert.equal(sma([1, 2, 3, 4], 4), 2.5);
  assert.equal(sma([1, 2, 3], 4), null);
  assert.equal(sma([], 4), null);
});

await check('MA-cross detects bullish transition', () => {
  const v = new MaCrossSignal().vote(signalInput());
  assert.equal(v.direction, 'long');
  assert.equal(v.strength, 1);
  assert.ok(v.snapshot.maFast! > v.snapshot.maSlow!);
});

await check('MA-cross detects bearish transition', () => {
  const v = new MaCrossSignal().vote(signalInput({ candles4h: BEAR_4H }));
  assert.equal(v.direction, 'short');
  assert.ok(v.snapshot.maFast! < v.snapshot.maSlow!);
});

await check('MA-cross stays flat with no fresh cross', () => {
  const v = new MaCrossSignal().vote(signalInput({ candles4h: FLAT_4H }));
  assert.equal(v.direction, 'flat');
});

await check('MA-cross flat on insufficient history', () => {
  const v = new MaCrossSignal().vote(
    signalInput({ candles4h: mkCandles([100, 101], 14400) }),
  );
  assert.equal(v.direction, 'flat');
  assert.ok(v.detail.includes('insufficient'));
});

await check('combineVotes: disagreement stands aside', () => {
  const v = combineVotes([
    { name: 'a', direction: 'long', strength: 1, detail: '', snapshot: {} },
    { name: 'b', direction: 'short', strength: 1, detail: '', snapshot: {} },
  ]);
  assert.equal(v.direction, 'flat');
  assert.ok(v.detail.includes('disagreement'));
});

await check('combineVotes: all flat stays flat', () => {
  const v = combineVotes([
    { name: 'a', direction: 'flat', strength: 0, detail: 'quiet', snapshot: {} },
  ]);
  assert.equal(v.direction, 'flat');
});

// ---------- strategy: filters ----------

await check('funding filter blocks crowded long', () => {
  const v = new FundingFilter().check(
    signalInput({ fundingRate: 0.002 }),
    { name: 's', direction: 'long', strength: 1, detail: '', snapshot: {} },
  );
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes('crowded'));
});

await check('funding filter blocks crowded short', () => {
  const v = new FundingFilter().check(
    signalInput({ fundingRate: -0.002 }),
    { name: 's', direction: 'short', strength: 1, detail: '', snapshot: {} },
  );
  assert.equal(v.pass, false);
});

await check('funding filter passes sane funding', () => {
  const v = new FundingFilter().check(
    signalInput({ fundingRate: 0.0001 }),
    { name: 's', direction: 'long', strength: 1, detail: '', snapshot: {} },
  );
  assert.equal(v.pass, true);
});

await check('filter registry fails CLOSED on filter error', () => {
  const r = new FilterRegistry();
  r.register({
    name: 'boom',
    check: () => {
      throw new Error('kaput');
    },
  });
  const out = r.checkAll(
    signalInput(),
    { name: 's', direction: 'long', strength: 1, detail: '', snapshot: {} },
  );
  assert.equal(out.pass, false);
  assert.equal(out.blocker, 'boom');
});

// ---------- strategy engine pipeline ----------

await check('engine: bullish + sane funding -> proposal', () => {
  const e = new StrategyEngine();
  const out = e.evaluate(signalInput());
  assert.equal(out.kind, 'signal');
  if (out.kind !== 'signal') return;
  const p = out.proposal;
  assert.equal(p.side, 'long');
  assert.equal(p.notionalUsd, TRADE_NOTIONAL_USD);
  assert.equal(p.leverage, TRADE_LEVERAGE);
  assert.ok(approx(p.stopPrice, p.refPrice * 0.98));
  assert.ok(p.reasoning.length >= 3);
  assert.ok(p.reasoning.some((r) => r.includes('Signal:')));
});

await check('engine: bearish -> short proposal with upside stop', () => {
  const e = new StrategyEngine();
  const out = e.evaluate(signalInput({ candles4h: BEAR_4H }));
  assert.equal(out.kind, 'signal');
  if (out.kind !== 'signal') return;
  assert.equal(out.proposal.side, 'short');
  assert.ok(approx(out.proposal.stopPrice, out.proposal.refPrice * 1.02));
});

await check('engine: extreme funding vetoes the trade', () => {
  const e = new StrategyEngine();
  const out = e.evaluate(signalInput({ fundingRate: 0.005 }));
  assert.equal(out.kind, 'filtered');
  if (out.kind !== 'filtered') return;
  assert.equal(out.filter, 'funding-extreme');
});

await check('engine: flat vote -> no-signal', () => {
  const e = new StrategyEngine();
  const out = e.evaluate(signalInput({ candles4h: FLAT_4H }));
  assert.equal(out.kind, 'no-signal');
});

await check('engine exposes pluggable registries (v2 seam)', () => {
  const e = new StrategyEngine();
  assert.deepEqual(e.signalNames, ['ma-cross-4h-1d']);
  assert.deepEqual(e.filterNames, ['funding-extreme']);
  assert.equal(e.regimeName, 'neutral-v1');
  // A custom v2-style signal can be registered without touching the engine.
  const signals = defaultSignals();
  signals.register({
    name: 'v2-demo',
    vote: () => ({ name: 'v2-demo', direction: 'flat', strength: 0, detail: 'demo', snapshot: {} }),
  });
  const e2 = new StrategyEngine(signals, defaultFilters(), new NeutralRegime());
  assert.deepEqual(e2.signalNames, ['ma-cross-4h-1d', 'v2-demo']);
});

// ---------- executor: fill math ----------

await check('executor: long fill math exact', () => {
  const ex = new PaperExecutor(START_BANKROLL_USD);
  const { position, trade } = ex.open(mkProposal({ refPrice: 100 }), 1_800_000_000);
  // fill = 100 * (1 + 2bps) = 100.02; size = 2500 / 100.02; fee = 2500 * 5bps = 1.25
  assert.ok(approx(trade.price, 100.02));
  assert.ok(approx(trade.sizeBase, 2500 / 100.02));
  assert.ok(approx(trade.feeUsd, 1.25));
  assert.ok(approx(ex.getCash(), 50000 - 1.25));
  assert.equal(position.side, 'long');

  // close @ 110 mark: exit = 110 * (1 - 2bps) = 109.978
  const close = ex.close(2, 110, 'test', 1_800_000_001)!;
  const exitPrice = 109.978;
  const sizeBase = 2500 / 100.02;
  const gross = (exitPrice - 100.02) * sizeBase;
  const exitFee = sizeBase * exitPrice * 0.0005;
  assert.ok(approx(close.price, exitPrice));
  assert.ok(approx(close.realizedPnlUsd!, gross - exitFee));
  assert.ok(approx(ex.getCash(), 50000 - 1.25 + (gross - exitFee)));
  assert.equal(ex.getPositions().length, 0);
});

await check('executor: short fill math exact', () => {
  const ex = new PaperExecutor(START_BANKROLL_USD);
  const { trade } = ex.open(mkProposal({ side: 'short', refPrice: 100 }), 1_800_000_000);
  // short opens: fill = 100 * (1 - 2bps) = 99.98
  assert.ok(approx(trade.price, 99.98));
  const sizeBase = 2500 / 99.98;
  const close = ex.close(2, 90, 'test', 1_800_000_001)!;
  const exitPrice = 90 * 1.0002;
  const gross = (99.98 - exitPrice) * sizeBase;
  assert.ok(approx(close.realizedPnlUsd!, gross - sizeBase * exitPrice * 0.0005));
});

await check('executor: unrealized PnL signs', () => {
  const ex = new PaperExecutor(START_BANKROLL_USD);
  const { position } = ex.open(mkProposal({ refPrice: 100 }), 1_800_000_000);
  assert.ok(ex.unrealized(position, 110) > 0);
  assert.ok(ex.unrealized(position, 90) < 0);
  const ex2 = new PaperExecutor(START_BANKROLL_USD);
  const s = ex2.open(mkProposal({ side: 'short', refPrice: 100 }), 1_800_000_000);
  assert.ok(ex2.unrealized(s.position, 90) > 0);
  assert.ok(ex2.unrealized(s.position, 110) < 0);
});

await check('executor: stop-loss sweep closes losers', () => {
  const ex = new PaperExecutor(START_BANKROLL_USD);
  ex.open(mkProposal({ refPrice: 100, stopPrice: 98 }), 1_800_000_000);
  const closed = ex.checkStops(new Map([[2, 97]]), 1_800_000_001);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, 'stop-loss');
  assert.ok(closed[0].realizedPnlUsd! < 0);
  // short stop: price rips up through the stop
  const ex2 = new PaperExecutor(START_BANKROLL_USD);
  ex2.open(mkProposal({ side: 'short', refPrice: 100, stopPrice: 102 }), 1_800_000_000);
  const closed2 = ex2.checkStops(new Map([[2, 103]]), 1_800_000_001);
  assert.equal(closed2.length, 1);
});

await check('executor: liquidation guard on margin wipeout', () => {
  const ex = new PaperExecutor(START_BANKROLL_USD);
  // 2x long $2500: margin $1250. -60% move wipes it.
  ex.open(mkProposal({ refPrice: 100, leverage: 2 }), 1_800_000_000);
  const closed = ex.checkLiquidations(new Map([[2, 40]]), 1_800_000_001);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, 'liquidated');
});

await check('executor: refuses insane inputs (defense in depth)', () => {
  const ex = new PaperExecutor(START_BANKROLL_USD);
  assert.throws(() => ex.open(mkProposal({ refPrice: 0 }), 1), /invalid proposal/);
  assert.throws(() => ex.open(mkProposal({ notionalUsd: -5 }), 1), /invalid proposal/);
  ex.open(mkProposal(), 1);
  assert.throws(() => ex.open(mkProposal(), 2), /already has an open position/);
  assert.equal(ex.close(999, 100, 'x', 1), null);
});

// ---------- risk: adversarial ----------

function riskState(count: number, ids: number[] = []) {
  return { openPositionCount: count, openProductIds: new Set(ids) };
}

await check('risk: approves a sane proposal', () => {
  const r = new ArgusRisk();
  assert.deepEqual(r.evaluate(mkProposal(), riskState(0), 1_800_000_000), { ok: true });
});

await check('risk: rejects oversized notional', () => {
  const r = new ArgusRisk();
  const v = r.evaluate(mkProposal({ notionalUsd: MAX_POSITION_NOTIONAL_USD + 1 }), riskState(0), 1_800_000_000);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('exceeds max'));
});

await check('risk: rejects over-leverage', () => {
  const r = new ArgusRisk();
  const v = r.evaluate(mkProposal({ leverage: MAX_LEVERAGE + 1 }), riskState(0), 1_800_000_000);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('leverage'));
});

await check('risk: kill switch halts everything', () => {
  const r = new ArgusRisk();
  r.kill();
  assert.equal(r.isKilled(), true);
  const v = r.evaluate(mkProposal(), riskState(0), 1_800_000_000);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('kill switch'));
});

await check('risk: daily halt blocks entries until next UTC day', () => {
  const r = new ArgusRisk();
  const now = 1_800_000_000;
  r.haltUntil(nextUtcDayStart(now));
  const v = r.evaluate(mkProposal(), riskState(0), now);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('daily loss cap'));
  // after the halt expires + day reset, entries flow again
  r.resetDay();
  assert.deepEqual(r.evaluate(mkProposal(), riskState(0), nextUtcDayStart(now) + 1), { ok: true });
});

await check('risk: rejects at max open positions', () => {
  const r = new ArgusRisk();
  const v = r.evaluate(mkProposal({ productId: 99 }), riskState(MAX_OPEN_POSITIONS, [2, 4, 8, 16]), 1_800_000_000);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('max 4'));
});

await check('risk: rejects duplicate product (one per perp)', () => {
  const r = new ArgusRisk();
  const v = r.evaluate(mkProposal({ productId: 4 }), riskState(1, [4]), 1_800_000_000);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('already has an open position'));
});

await check('risk: boundary values pass (exactly at limits)', () => {
  const r = new ArgusRisk();
  const v = r.evaluate(
    mkProposal({ notionalUsd: MAX_POSITION_NOTIONAL_USD, leverage: MAX_LEVERAGE }),
    riskState(MAX_OPEN_POSITIONS - 1, [4, 8, 16]),
    1_800_000_000,
  );
  assert.deepEqual(v, { ok: true });
});

await check('risk: UTC day helpers', () => {
  assert.equal(utcDayStart(86400 * 5 + 3600), 86400 * 5);
  assert.equal(nextUtcDayStart(86400 * 5 + 3600), 86400 * 6);
  assert.ok(DAILY_LOSS_CAP_USD === 1000);
});

// ---------- db roundtrip ----------

await check('db: portfolio init + fill record + realized/fees accounting', () => {
  const db = new ArgusDb(':memory:');
  db.initPortfolio(START_BANKROLL_USD, 1000);
  db.initPortfolio(999999, 1000); // second init is a no-op
  assert.equal(db.getCash(), START_BANKROLL_USD);

  const ex = new PaperExecutor(db.getCash()!);
  const { position, trade } = ex.open(mkProposal({ refPrice: 100 }), 2000);
  db.recordFill(trade, ex.getCash(), position);
  assert.equal(db.allPositions().length, 1);
  assert.equal(db.getCash(), 50000 - 1.25);

  const close = ex.close(2, 110, 'test', 3000)!;
  db.recordFill(close, ex.getCash(), null);
  assert.equal(db.allPositions().length, 0);
  const trades = db.recentTrades(10);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].action, 'close');
  // realizedSince covers the close; feesSince covers both fills
  assert.ok(db.realizedSince(0) > 200);
  assert.ok(approx(db.feesSince(0), 1.25 + close.feeUsd));
  db.close();
});

await check('db: reasoning + equity snapshots', () => {
  const db = new ArgusDb(':memory:');
  db.insertReasoning({ id: 'r1', ts: 100, productId: 2, ticker: 'BTC-PERP', decision: 'opened:long', body: 'why' });
  const rs = db.recentReasoning(10);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].decision, 'opened:long');
  db.snapshotEquity(100, 50100, 50000, 100);
  db.snapshotEquity(200, 50200, 50000, 200);
  const curve = db.equityCurve(10);
  assert.deepEqual(curve.map((c) => c.ts), [100, 200]);
  db.close();
});

// ---------- http contract ----------

function stubEngine(over: Partial<Record<string, unknown>> = {}): ArgusEngine {
  return {
    getStatus: () => ({
      bankrollUsd: START_BANKROLL_USD,
      cashUsd: 49998.75,
      equityUsd: 50100,
      unrealizedPnlUsd: 101.25,
      realizedTodayUsd: 50,
      openPositions: [],
      killed: false,
      haltedUntil: null,
      asOf: 1_800_000_000,
    }),
    kill: () => {},
    ...over,
  } as unknown as ArgusEngine;
}

await check('GET /argus/status contract', async () => {
  const app = createArgusApp({ engine: stubEngine() });
  const res = await app.request('/status');
  assert.equal(res.status, 200);
  const j = (await res.json()) as Record<string, unknown>;
  assert.equal(j.bankrollUsd, START_BANKROLL_USD);
  assert.equal(j.killed, false);
  assert.ok(Array.isArray(j.openPositions));
});

await check('GET /argus/trades + /reasoning via db', async () => {
  const db = new ArgusDb(':memory:');
  db.insertReasoning({ id: 'r1', ts: 100, productId: 2, ticker: 'BTC-PERP', decision: 'd', body: 'b' });
  const app = createArgusApp({ engine: stubEngine(), db });
  const rt = await app.request('/trades?limit=5');
  assert.equal(rt.status, 200);
  assert.deepEqual(((await rt.json()) as { trades: unknown[] }).trades, []);
  const rr = await app.request('/reasoning');
  assert.equal(rr.status, 200);
  assert.equal(((await rr.json()) as { entries: unknown[] }).entries.length, 1);
  const bad = await app.request('/trades?limit=abc');
  assert.equal(bad.status, 200); // falls back to default limit
  db.close();
});

await check('POST /kill absent without secret (fail closed)', async () => {
  const app = createArgusApp({ engine: stubEngine() });
  const res = await app.request('/kill', { method: 'POST', body: JSON.stringify({ secret: 'x' }) });
  assert.equal(res.status, 404);
});

await check('POST /kill enforces the secret', async () => {
  let killed = false;
  const engine = stubEngine({ kill: () => { killed = true; } });
  const app = createArgusApp({ engine, killSecret: 'father-secret' });
  const bad = await app.request('/kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(killed, false);
  const good = await app.request('/kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'father-secret' }),
  });
  assert.equal(good.status, 200);
  assert.equal(killed, true);
  const malformed = await app.request('/kill', { method: 'POST', body: 'not-json{{' });
  assert.equal(malformed.status, 400);
});

// ---------- feed ----------

await check('feed: author address valid; trade post formats', () => {
  assert.ok(ARGUS_AUTHOR.startsWith('0x'));
  const trade = {
    id: 't1', productId: 2, ticker: 'BTC-PERP', side: 'long' as Side, action: 'open' as const,
    sizeBase: 25, price: 100.02, notionalUsd: 2500, feeUsd: 1.25,
    realizedPnlUsd: null, reason: 'signal-fill', ts: 1_800_000_000,
  };
  const status = {
    bankrollUsd: 50000, cashUsd: 49998.75, equityUsd: 49998.75, unrealizedPnlUsd: 0,
    realizedTodayUsd: 0, openPositions: [], killed: false, haltedUntil: null, asOf: 1_800_000_000,
  };
  const { title, body } = formatTradePost(trade, mkProposal(), status);
  assert.ok(title.includes('LONG BTC-PERP'));
  assert.ok(title.includes('(paper)'));
  assert.ok(body.includes('Why:'));
  assert.ok(body.includes('Paper trading only'));
  const closeTrade = { ...trade, action: 'close' as const, realizedPnlUsd: 246.33 };
  const c2 = formatTradePost(closeTrade, null, status);
  assert.ok(c2.title.includes('+'));
  assert.ok(c2.body.includes('Realized PnL'));
});

await check('universe matches spec (2/4/8/16)', () => {
  assert.deepEqual(ARGUS_UNIVERSE.map((p) => p.productId), [2, 4, 8, 16]);
});

console.log(`\n${passed} argus checks passed`);
