/**
 * Argus engine — the tick loop.
 *
 * Orchestration only: venue -> strategy -> risk -> executor -> db -> feed.
 * The engine is the ONLY module that calls the executor, and it only does so
 * with proposals that passed risk.evaluate(). The data flow is one-directional;
 * no module reaches backward.
 *
 * Fail-soft by design (same philosophy as rekt.ts): every tick is wrapped, all
 * errors are caught and logged, and the loop never dies.
 *
 * The engine does NOT decide whether it should run: the caller (the
 * facilitator server) only constructs it when ARGUS_ENABLED=1. As a standalone
 * component it also honors ARGUS_ENABLED=0 as an explicit kill.
 *
 * PAPER ONLY. No keys, no signing, no broadcasts. The engine's network reads
 * are public Nado market data; its writes are local SQLite + Lounge feed posts.
 */
import {
  ARGUS_UNIVERSE,
  DAILY_LOSS_CAP_USD,
  START_BANKROLL_USD,
  type MarketSnapshot,
  type PortfolioStatus,
  type Trade,
  type TradeProposal,
} from './types.js';
import {
  ARGUS_INDEXER_URL_DEFAULT,
  ARGUS_PAIRS_URL_DEFAULT,
  fetchCandles,
  fetchMarketSnapshot,
  fetchProductMap,
} from './venue.js';
import { ArgusDb } from './db.js';
import { PaperExecutor } from './executor.js';
import { ArgusRisk, nextUtcDayStart, utcDayStart } from './risk.js';
import { StrategyEngine } from './strategy/index.js';
import type { SignalInput } from './strategy/signals.js';
import { newId, postTradeToFeed } from './feed.js';
import type { LoungeDb } from '../lounge/db.js';

export interface ArgusEngineOpts {
  dbPath?: string;
  pairsUrl?: string;
  indexerUrl?: string;
  tickMs?: number;
  log?: (msg: string) => void;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export class ArgusEngine {
  private db: ArgusDb;
  private executor: PaperExecutor;
  private risk = new ArgusRisk();
  private strategy = new StrategyEngine();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private tickMs: number;
  private pairsUrl: string;
  private indexerUrl: string;
  private log: (msg: string) => void;
  private tickers = new Map<number, string>();
  private lastMarks = new Map<number, number>();
  private lastTickAt = 0;
  private lastEquitySnapshotAt = 0;

  constructor(
    private loungeDb: LoungeDb,
    opts: ArgusEngineOpts = {},
  ) {
    this.db = new ArgusDb(opts.dbPath ?? env('ARGUS_DB_PATH') ?? './argus.db');
    this.tickMs = opts.tickMs ?? Number(env('ARGUS_TICK_MS') ?? '300000');
    if (!Number.isFinite(this.tickMs) || this.tickMs < 10_000) this.tickMs = 300_000;
    this.pairsUrl = opts.pairsUrl ?? env('ARGUS_PAIRS_URL') ?? ARGUS_PAIRS_URL_DEFAULT;
    this.indexerUrl = opts.indexerUrl ?? env('ARGUS_INDEXER_URL') ?? ARGUS_INDEXER_URL_DEFAULT;
    this.log = opts.log ?? ((m) => console.log(m));

    const now = Math.floor(Date.now() / 1000);
    this.db.initPortfolio(START_BANKROLL_USD, now);
    const cash = this.db.getCash() ?? START_BANKROLL_USD;
    const positions = this.db.allPositions();
    this.executor = new PaperExecutor(cash, positions);
    this.log(`[argus] engine constructed (cash $${cash.toFixed(2)}, ${positions.length} positions restored)`);
  }

  /** Start the tick loop. Returns stop(). */
  start(): () => void {
    if ((env('ARGUS_ENABLED') ?? '1') === '0') {
      this.log('[argus] disabled via ARGUS_ENABLED=0');
      return () => {};
    }
    this.stopped = false;
    void this.refreshTickers();
    void this.tick();
    this.timer = setInterval(() => {
      if (!this.stopped) void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
    this.log(`[argus] engine started (tick ${this.tickMs}ms)`);
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log('[argus] engine stopped');
  }

  /** Father-only kill switch (guarded by ARGUS_KILL_SECRET at the HTTP layer). */
  kill(): void {
    this.risk.kill();
    this.log('[argus] KILL SWITCH ENGAGED — no new entries');
    this.db.insertReasoning({
      id: newId('reason'),
      ts: Math.floor(Date.now() / 1000),
      productId: null,
      ticker: null,
      decision: 'killed',
      body: 'Kill switch engaged by operator. No new entries until restart.',
    });
  }

  isKilled(): boolean {
    return this.risk.isKilled();
  }

  /** Expose the state DB for the HTTP layer (trades/reasoning reads). */
  getDb(): ArgusDb {
    return this.db;
  }

  getHaltedUntil(): number | null {
    return this.risk.getHaltedUntil();
  }

  getStatus(): PortfolioStatus {
    const cash = this.executor.getCash();
    const unrealized = this.executor.totalUnrealized(this.lastMarks);
    const now = Math.floor(Date.now() / 1000);
    const positions = this.executor.getPositions().map((p) => ({
      ...p,
      markPrice: this.lastMarks.get(p.productId) ?? p.entryPrice,
      unrealizedPnlUsd: this.executor.unrealized(p, this.lastMarks.get(p.productId) ?? p.entryPrice),
    }));
    return {
      bankrollUsd: START_BANKROLL_USD,
      cashUsd: cash,
      equityUsd: cash + unrealized,
      unrealizedPnlUsd: unrealized,
      realizedTodayUsd: this.db.realizedSince(utcDayStart(now)),
      openPositions: positions,
      killed: this.risk.isKilled(),
      haltedUntil: this.risk.getHaltedUntil(),
      asOf: now,
    };
  }

  private async refreshTickers(): Promise<void> {
    try {
      const m = await fetchProductMap(this.pairsUrl);
      if (m.size > 0) {
        this.tickers = m;
        this.log(`[argus] product map: ${m.size} products`);
      }
    } catch (err) {
      this.log(`[argus] product map refresh failed: ${(err as Error).message}`);
    }
  }

  private tickerFor(productId: number): string {
    const known = ARGUS_UNIVERSE.find((p) => p.productId === productId);
    return this.tickers.get(productId) ?? known?.ticker ?? `product-${productId}`;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Math.floor(Date.now() / 1000);
    try {
      // UTC day rollover: reset the daily-loss halt.
      // (Simple approach: if haltedUntil passed, clear it.)
      const halted = this.risk.getHaltedUntil();
      if (halted !== null && now >= halted) {
        this.risk.resetDay();
        this.log('[argus] new UTC day — daily halt cleared');
      }

      const ids = ARGUS_UNIVERSE.map((p) => p.productId);
      const snaps = await fetchMarketSnapshot(this.indexerUrl, ids);
      if (snaps.size === 0) {
        this.log('[argus] tick: no market data, skipping');
        return;
      }
      const marks = new Map<number, number>();
      for (const [pid, s] of snaps) {
        s.ticker = this.tickerFor(pid);
        marks.set(pid, s.markPrice);
      }
      this.lastMarks = marks;
      this.lastTickAt = now;

      // 1. Manage existing positions: stops, then bankruptcy guard.
      for (const t of this.executor.checkStops(marks, now)) this.onClose(t, null);
      for (const t of this.executor.checkLiquidations(marks, now)) this.onClose(t, null);

      // 2. Daily loss cap: realized today + unrealized now.
      const dayPnl = this.db.realizedSince(utcDayStart(now)) + this.executor.totalUnrealized(marks);
      if (dayPnl <= -DAILY_LOSS_CAP_USD && this.risk.getHaltedUntil() === null) {
        this.log(`[argus] DAILY LOSS CAP TRIPPED (day PnL $${dayPnl.toFixed(2)}) — closing all, halting entries`);
        for (const p of this.executor.getPositions()) {
          const t = this.executor.close(p.productId, marks.get(p.productId) ?? p.entryPrice, 'daily-loss-cap', now);
          if (t) this.onClose(t, null);
        }
        this.risk.haltUntil(nextUtcDayStart(now));
        this.db.insertReasoning({
          id: newId('reason'),
          ts: now,
          productId: null,
          ticker: null,
          decision: 'daily-loss-halt',
          body: `Day PnL $${dayPnl.toFixed(2)} breached the -$${DAILY_LOSS_CAP_USD} cap. All positions closed; no new entries until next UTC day.`,
        });
        return;
      }

      // 3. New signals: only for products without an open position.
      const held = new Set(this.executor.getPositions().map((p) => p.productId));
      for (const def of ARGUS_UNIVERSE) {
        if (this.stopped || held.has(def.productId)) continue;
        const snap = snaps.get(def.productId);
        if (!snap) continue;
        await this.evaluateProduct(def.productId, this.tickerFor(def.productId), snap, now);
      }

      // 4. Hourly equity snapshot.
      if (now - this.lastEquitySnapshotAt >= 3600) {
        const cash = this.executor.getCash();
        const unreal = this.executor.totalUnrealized(marks);
        this.db.snapshotEquity(now, cash + unreal, cash, unreal);
        this.lastEquitySnapshotAt = now;
      }
    } catch (err) {
      this.log(`[argus] tick failed: ${(err as Error).message}`);
    }
  }

  private async evaluateProduct(
    productId: number,
    ticker: string,
    snap: MarketSnapshot,
    now: number,
  ): Promise<void> {
    let candles4h, candles1d;
    try {
      [candles4h, candles1d] = await Promise.all([
        fetchCandles(this.indexerUrl, productId, 14400, 40),
        fetchCandles(this.indexerUrl, productId, 86400, 20),
      ]);
    } catch (err) {
      this.log(`[argus] candle fetch failed for ${ticker}: ${(err as Error).message}`);
      return;
    }

    const input: SignalInput = {
      productId,
      ticker,
      candles4h,
      candles1d,
      markPrice: snap.markPrice,
      fundingRate: snap.fundingRate,
      now,
    };
    const outcome = this.strategy.evaluate(input);

    if (outcome.kind === 'no-signal') return; // too noisy to log

    if (outcome.kind === 'filtered') {
      this.db.insertReasoning({
        id: newId('reason'),
        ts: now,
        productId,
        ticker,
        decision: `filtered:${outcome.filter}`,
        body: `Signal said ${outcome.vote.direction} (${outcome.vote.detail}). Blocked: ${outcome.detail}`,
      });
      return;
    }

    const proposal = outcome.proposal;
    const riskState = {
      openPositionCount: this.executor.getPositions().length,
      openProductIds: new Set(this.executor.getPositions().map((p) => p.productId)),
    };
    const verdict = this.risk.evaluate(proposal, riskState, now);
    if (!verdict.ok) {
      this.db.insertReasoning({
        id: newId('reason'),
        ts: now,
        productId,
        ticker,
        decision: 'risk-rejected',
        body: `Proposed ${proposal.side} ${ticker} $${proposal.notionalUsd} @ ${proposal.leverage}x. Rejected: ${verdict.reason}\n${proposal.reasoning.join('\n')}`,
      });
      this.log(`[argus] risk rejected ${ticker}: ${verdict.reason}`);
      return;
    }

    // Approved — the ONLY path to the executor.
    const { position, trade } = this.executor.open(proposal, now);
    this.db.recordFill(trade, this.executor.getCash(), position);
    this.db.insertReasoning({
      id: newId('reason'),
      ts: now,
      productId,
      ticker,
      decision: `opened:${proposal.side}`,
      body: `${proposal.side.toUpperCase()} ${ticker} $${proposal.notionalUsd} @ ${proposal.leverage}x, filled @ ${trade.price.toFixed(2)}, stop ${proposal.stopPrice.toFixed(2)}.\n${proposal.reasoning.join('\n')}`,
    });
    this.log(`[argus] OPEN ${proposal.side} ${ticker} $${proposal.notionalUsd} @ ${trade.price.toFixed(2)}`);
    postTradeToFeed(this.loungeDb, trade, proposal, this.getStatus(), this.log);
  }

  /** Shared close handler: persist + reasoning + feed post. */
  private onClose(trade: Trade, proposal: TradeProposal | null): void {
    this.db.recordFill(trade, this.executor.getCash(), null);
    this.db.insertReasoning({
      id: newId('reason'),
      ts: trade.ts,
      productId: trade.productId,
      ticker: trade.ticker,
      decision: `closed:${trade.reason}`,
      body: `Closed ${trade.side} ${trade.ticker} @ ${trade.price.toFixed(2)} (${trade.reason}). Realized ${trade.realizedPnlUsd !== null ? '$' + trade.realizedPnlUsd.toFixed(2) : 'n/a'}.`,
    });
    this.log(`[argus] CLOSE ${trade.side} ${trade.ticker} @ ${trade.price.toFixed(2)} (${trade.reason})`);
    postTradeToFeed(this.loungeDb, trade, proposal, this.getStatus(), this.log);
  }
}

/**
 * Start the Argus engine. Fail-soft — throws only on construction errors the
 * caller should know about; the tick loop itself never throws.
 */
export function startArgusEngine(loungeDb: LoungeDb, opts: ArgusEngineOpts = {}): ArgusEngine {
  const engine = new ArgusEngine(loungeDb, opts);
  engine.start();
  return engine;
}
