/**
 * Argus strategy framework — pluggable signals, filters, and regime logic.
 *
 * V1 scope (locked): 4h/1d MA-cross signal + funding-rate filter. The engine is
 * deliberately modular so v2 upgrades slot in WITHOUT touching the executor or
 * the risk runtime:
 *
 *   signals/  — each Signal votes long/short/flat with a strength and a
 *               human-readable detail line. v2 candidates: multi-timeframe
 *               confirmation, breakout, funding-momentum.
 *   filters/  — each Filter can veto a vote (never creates one). v2 candidates:
 *               volatility-regime filter, liquidity/spread filter, max-drawdown
 *               throttle.
 *   regime.ts — market-regime detection. v1 is a neutral passthrough; v2 plugs
 *               real volatility-regime detection here and the engine will use it
 *               for sizing/engagement before any signal runs.
 *
 * THE SEAM: everything in here produces a TradeProposal (see ../types.ts) or a
 * documented non-signal outcome. The executor and risk modules only ever see
 * TradeProposal — strategy internals can be rewritten freely as long as that
 * contract holds.
 */
export * from './signals.js';
export * from './filters.js';
export * from './regime.js';
export * from './engine.js';
