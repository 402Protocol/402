/**
 * Argus risk runtime — the hard-limits bulkhead.
 *
 * This module is deliberately separate from the strategy engine and the
 * executor. The strategy PROPOSES; risk DISPOSES. Risk can only REJECT — it has
 * no code path that approves, widens, or overrides a limit, and there is no
 * input by which the strategy can relax a check. The executor is only ever
 * called with proposals that passed evaluate().
 *
 * Limits (locked, Father 2026-10-02):
 *   - max 3x leverage
 *   - max $5,000 (10% of bankroll) notional per position
 *   - 2% daily loss cap ($1,000): halt new entries until next UTC day
 *   - max 4 open positions (one per perp)
 *   - Father-only kill switch: latches; halts all new entries immediately
 *
 * "Flat for the day" semantics: when the daily loss cap trips, the ENGINE
 * closes all open positions at mark and risk rejects every new proposal until
 * the next UTC day. The halt lives here so it cannot be bypassed.
 */
import {
  DAILY_LOSS_CAP_USD,
  MAX_LEVERAGE,
  MAX_OPEN_POSITIONS,
  MAX_POSITION_NOTIONAL_USD,
  type TradeProposal,
} from './types.js';

export type RiskVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export class ArgusRisk {
  private killed = false;
  private haltedUntil: number | null = null;

  /** Father-only kill switch. Latches ON; halts all new entries immediately.
   *  There is intentionally no HTTP revive — restarting the process or an
   *  explicit operator action is required to trade again. */
  kill(): void {
    this.killed = true;
  }

  isKilled(): boolean {
    return this.killed;
  }

  /** Called by the engine when the daily loss cap trips. */
  haltUntil(ts: number): void {
    this.haltedUntil = ts;
  }

  /** Called by the engine on UTC day rollover. */
  resetDay(): void {
    this.haltedUntil = null;
  }

  getHaltedUntil(): number | null {
    return this.haltedUntil;
  }

  /**
   * The single choke point. Every proposal must pass through here before the
   * executor may fill it. Returns ok:false with a human-readable reason on ANY
   * violation — the engine logs the reason and moves on.
   */
  evaluate(
    proposal: TradeProposal,
    state: { openPositionCount: number; openProductIds: Set<number> },
    now: number,
  ): RiskVerdict {
    if (this.killed) {
      return { ok: false, reason: 'kill switch engaged — no new entries' };
    }
    if (this.haltedUntil !== null && now < this.haltedUntil) {
      return {
        ok: false,
        reason: `daily loss cap tripped — halted until ${new Date(this.haltedUntil * 1000).toISOString()}`,
      };
    }
    if (proposal.leverage > MAX_LEVERAGE) {
      return {
        ok: false,
        reason: `leverage ${proposal.leverage}x exceeds max ${MAX_LEVERAGE}x`,
      };
    }
    if (proposal.notionalUsd > MAX_POSITION_NOTIONAL_USD) {
      return {
        ok: false,
        reason: `notional $${proposal.notionalUsd} exceeds max $${MAX_POSITION_NOTIONAL_USD}`,
      };
    }
    if (state.openPositionCount >= MAX_OPEN_POSITIONS) {
      return {
        ok: false,
        reason: `already at max ${MAX_OPEN_POSITIONS} open positions`,
      };
    }
    if (state.openProductIds.has(proposal.productId)) {
      return {
        ok: false,
        reason: `${proposal.ticker} already has an open position (one per perp)`,
      };
    }
    if (proposal.notionalUsd <= 0 || proposal.leverage <= 0) {
      return { ok: false, reason: 'non-positive notional or leverage' };
    }
    return { ok: true };
  }
}

/** UTC day boundaries, seconds. */
export function utcDayStart(ts: number): number {
  return Math.floor(ts / 86400) * 86400;
}

export function nextUtcDayStart(ts: number): number {
  return utcDayStart(ts) + 86400;
}
