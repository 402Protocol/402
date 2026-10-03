/**
 * StrategyEngine — composes regime, signals, and filters into a TradeProposal.
 *
 * Pipeline (each stage is swappable; stages only communicate via the types
 * below — never by reaching into each other):
 *
 *   1. regime.detect(input)          -> note (v1: passthrough)
 *   2. signals.voteAll(input)        -> SignalVote[]
 *   3. combineVotes(votes)           -> winning vote or flat
 *   4. filters.checkAll(input, vote) -> veto or pass
 *   5. buildProposal(input, vote)    -> TradeProposal (the stable contract
 *      consumed by risk.ts and executor.ts — this is the seam)
 *
 * The engine NEVER touches positions, cash, or fills. It is a pure proposal
 * factory: market data in, TradeProposal (or a documented non-signal) out.
 */
import {
  STOP_PCT,
  TRADE_LEVERAGE,
  TRADE_NOTIONAL_USD,
  type Side,
  type TradeProposal,
} from '../types.js';
import { combineVotes, defaultSignals, type SignalInput, type SignalRegistry, type SignalVote } from './signals.js';
import { defaultFilters, type FilterRegistry } from './filters.js';
import { NeutralRegime, type RegimeDetector } from './regime.js';

export type EvalOutcome =
  | { kind: 'signal'; proposal: TradeProposal }
  | { kind: 'no-signal'; vote: SignalVote; detail: string }
  | { kind: 'filtered'; vote: SignalVote; filter: string; detail: string };

export class StrategyEngine {
  constructor(
    private signals: SignalRegistry = defaultSignals(),
    private filters: FilterRegistry = defaultFilters(),
    private regime: RegimeDetector = new NeutralRegime(),
  ) {}

  evaluate(input: SignalInput): EvalOutcome {
    const regimeReading = this.regime.detect(input);

    const votes = this.signals.voteAll(input);
    const vote = combineVotes(votes);
    if (vote.direction === 'flat') {
      return { kind: 'no-signal', vote, detail: vote.detail };
    }

    const filtered = this.filters.checkAll(input, vote);
    if (!filtered.pass) {
      return {
        kind: 'filtered',
        vote,
        filter: filtered.blocker ?? 'unknown',
        detail: filtered.reason,
      };
    }

    return { kind: 'signal', proposal: buildProposal(input, vote, regimeReading.note) };
  }

  get signalNames(): string[] {
    return this.signals.names;
  }
  get filterNames(): string[] {
    return this.filters.names;
  }
  get regimeName(): string {
    return this.regime.name;
  }
}

function buildProposal(input: SignalInput, vote: SignalVote, regimeNote: string): TradeProposal {
  const side = vote.direction as Side;
  const refPrice = input.markPrice;
  // 2% adverse stop from the reference price.
  const stopPrice = side === 'long' ? refPrice * (1 - STOP_PCT) : refPrice * (1 + STOP_PCT);
  const s = vote.snapshot;

  const reasoning = [
    `Signal: ${vote.detail}`,
    `Filter check: funding ${(input.fundingRate * 100).toFixed(4)}% — passed`,
    `Regime: ${regimeNote}`,
    `Plan: ${side.toUpperCase()} ${input.ticker} $${TRADE_NOTIONAL_USD.toLocaleString('en-US')} notional @ ${TRADE_LEVERAGE}x (margin $${(TRADE_NOTIONAL_USD / TRADE_LEVERAGE).toLocaleString('en-US')}), stop ${fmtPrice(stopPrice)} (${(STOP_PCT * 100).toFixed(0)}% adverse)`,
  ];

  return {
    productId: input.productId,
    ticker: input.ticker,
    side,
    notionalUsd: TRADE_NOTIONAL_USD,
    leverage: TRADE_LEVERAGE,
    refPrice,
    stopPrice,
    fundingRate: input.fundingRate,
    maFast: s.maFast ?? NaN,
    maSlow: s.maSlow ?? NaN,
    maFastPrev: s.maFastPrev ?? NaN,
    maSlowPrev: s.maSlowPrev ?? NaN,
    reasoning,
    createdAt: input.now,
  };
}

function fmtPrice(n: number): string {
  return n >= 1000 ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '$' + n.toFixed(2);
}
