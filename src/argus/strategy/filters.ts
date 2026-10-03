/**
 * Strategy filters — pluggable vetoes.
 *
 * A Filter NEVER creates a trade idea; it can only veto one. Filters run after
 * signal combination and before proposal construction. Register new filters via
 * FilterRegistry; v2 candidates: volatility-regime filter (stand aside in chop),
 * liquidity/spread filter, drawdown throttle. The engine never names a filter
 * directly.
 */
import { FUNDING_EXTREME } from '../types.js';
import type { SignalInput, SignalVote } from './signals.js';

export interface FilterVerdict {
  pass: boolean;
  /** Human-readable; logged when a veto fires. */
  reason: string;
}

export interface Filter {
  readonly name: string;
  check(input: SignalInput, vote: SignalVote): FilterVerdict;
}

/**
 * v1: funding-rate filter. Extremely positive funding means longs are paying
 * shorts heavily — crowded long, don't chase. Mirror for shorts.
 * Threshold: FUNDING_EXTREME per funding interval (0.1%).
 */
export class FundingFilter implements Filter {
  readonly name = 'funding-extreme';

  check(input: SignalInput, vote: SignalVote): FilterVerdict {
    const f = input.fundingRate;
    if (vote.direction === 'long' && f > FUNDING_EXTREME) {
      return {
        pass: false,
        reason:
          `funding extremely positive (${(f * 100).toFixed(3)}% > ` +
          `${(FUNDING_EXTREME * 100).toFixed(1)}%) — longs are crowded, vetoing long`,
      };
    }
    if (vote.direction === 'short' && f < -FUNDING_EXTREME) {
      return {
        pass: false,
        reason:
          `funding extremely negative (${(f * 100).toFixed(3)}% < ` +
          `-${(FUNDING_EXTREME * 100).toFixed(1)}%) — shorts are crowded, vetoing short`,
      };
    }
    return { pass: true, reason: `funding ${(f * 100).toFixed(4)}% within bounds` };
  }
}

export class FilterRegistry {
  private filters: Filter[] = [];
  register(f: Filter): void {
    this.filters.push(f);
  }
  /** First veto wins; returns the blocking filter name or null. */
  checkAll(input: SignalInput, vote: SignalVote): { pass: boolean; blocker: string | null; reason: string } {
    for (const f of this.filters) {
      let v: FilterVerdict;
      try {
        v = f.check(input, vote);
      } catch (err) {
        // A broken filter fails CLOSED (vetoes) — never fail open into a trade.
        return { pass: false, blocker: f.name, reason: `filter error: ${(err as Error).message}` };
      }
      if (!v.pass) return { pass: false, blocker: f.name, reason: v.reason };
    }
    return { pass: true, blocker: null, reason: 'all filters passed' };
  }
  get names(): string[] {
    return this.filters.map((f) => f.name);
  }
}

/** v1 default: funding filter only. */
export function defaultFilters(): FilterRegistry {
  const r = new FilterRegistry();
  r.register(new FundingFilter());
  return r;
}
