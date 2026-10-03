/**
 * Argus — public paper-trading perps agent (Phase 1).
 *
 * PAPER ONLY. No private keys, no signing, no broadcasts, no real money, no
 * Nado write endpoints. The only network traffic this module ever produces is
 * public market-data reads (pairs, candles, funding, prices). Real-mode wiring
 * is Phase 2 and is explicitly NOT part of this build.
 *
 * Module layout:
 *   types.ts    — shared types + locked constants
 *   venue.ts    — Nado read-only adapter (public REST only)
 *   strategy.ts — deterministic 4h/1d MA-cross + funding filter (pure)
 *   risk.ts     — hard risk limits; proposes nothing, only rejects (the bulkhead)
 *   executor.ts — paper fills, positions, PnL math
 *   db.ts       — ArgusDb (node:sqlite): portfolio, positions, trades, reasoning, equity
 *   feed.ts     — auto-post every trade to the Lounge feed
 *   engine.ts   — tick loop: venue -> strategy -> risk -> executor -> db -> feed
 *   server.ts   — Hono routes: /argus/status, /argus/trades, /argus/reasoning, /argus/kill
 */

/** Nado perp universe, verified live 2026-10-02 (quoted in USDT0). */
export interface PerpDef {
  productId: number;
  ticker: string;
}

export const ARGUS_UNIVERSE: PerpDef[] = [
  { productId: 2, ticker: 'BTC-PERP' },
  { productId: 4, ticker: 'ETH-PERP' },
  { productId: 8, ticker: 'SOL-PERP' },
  { productId: 16, ticker: 'HYPE-PERP' },
];

/** Locked Phase-1 parameters (Father, 2026-10-02). */
export const START_BANKROLL_USD = 50_000;
export const TRADE_NOTIONAL_USD = 2_500; // 5% of bankroll per trade
export const TRADE_LEVERAGE = 2;
export const MAX_LEVERAGE = 3;
export const MAX_POSITION_NOTIONAL_USD = 5_000; // 10% of bankroll
export const DAILY_LOSS_CAP_USD = 1_000; // 2% of bankroll
export const MAX_OPEN_POSITIONS = 4; // one per perp, max

/** Modeled fill costs (see BUILD_NOTES.md). */
export const TAKER_FEE_BPS = 5;
export const SLIPPAGE_BPS = 2;

/** Funding-rate extremes per interval (1 = 100%). No longs above +, no shorts below -. */
export const FUNDING_EXTREME = 0.001; // 0.1%

/** Stop-loss: 2% adverse move from fill. */
export const STOP_PCT = 0.02;

/** Strategy: fast MA over 4h candles (~2d of trend), slow MA over 1d candles (~10d). */
export const MA_FAST_PERIOD = 12; // 12 x 4h candles
export const MA_SLOW_PERIOD = 10; // 10 x 1d candles

export type Side = 'long' | 'short';

export interface Candle {
  /** Unix seconds, candle open time. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  productId: number;
  ticker: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
}

/** A deterministic trade proposal from the strategy engine. */
export interface TradeProposal {
  productId: number;
  ticker: string;
  side: Side;
  notionalUsd: number;
  leverage: number;
  /** Mark price the proposal was built on (fill may differ by slippage). */
  refPrice: number;
  stopPrice: number;
  fundingRate: number;
  maFast: number;
  maSlow: number;
  maFastPrev: number;
  maSlowPrev: number;
  /** Human-readable reasoning lines — the "why I did it" feed. */
  reasoning: string[];
  createdAt: number;
}

export interface Position {
  productId: number;
  ticker: string;
  side: Side;
  /** Base-asset size (always positive; side carries direction). */
  sizeBase: number;
  notionalUsd: number;
  entryPrice: number;
  leverage: number;
  stopPrice: number;
  openedAt: number;
}

export interface Trade {
  id: string;
  productId: number;
  ticker: string;
  side: Side;
  action: 'open' | 'close';
  sizeBase: number;
  price: number;
  notionalUsd: number;
  feeUsd: number;
  /** Set on close. */
  realizedPnlUsd: number | null;
  reason: string;
  ts: number;
}

export interface ReasoningEntry {
  id: string;
  ts: number;
  productId: number | null;
  ticker: string | null;
  decision: string;
  body: string;
}

export interface PortfolioStatus {
  bankrollUsd: number;
  cashUsd: number;
  equityUsd: number;
  unrealizedPnlUsd: number;
  realizedTodayUsd: number;
  openPositions: (Position & { unrealizedPnlUsd: number; markPrice: number })[];
  killed: boolean;
  haltedUntil: number | null;
  asOf: number;
}
