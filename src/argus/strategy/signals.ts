/**
 * Strategy signals — pluggable vote producers.
 *
 * A Signal looks at market data and votes a direction. It NEVER sizes, filters,
 * or executes — it only votes. The engine combines votes and the filters below
 * can veto. Register new signals via SignalRegistry; v2 signals (e.g.
 * multi-timeframe confirmation) slot in here with no changes elsewhere.
 */
import {
  MA_FAST_PERIOD,
  MA_SLOW_PERIOD,
  type Candle,
} from '../types.js';

export interface SignalInput {
  productId: number;
  ticker: string;
  /** Oldest-first, must include the still-forming candle at the end. */
  candles4h: Candle[];
  candles1d: Candle[];
  markPrice: number;
  fundingRate: number;
  now: number;
}

export interface SignalVote {
  /** Stable machine name, e.g. 'ma-cross-4h-1d'. */
  name: string;
  direction: 'long' | 'short' | 'flat';
  /** 0..1 conviction. v1 MA-cross is binary (0 or 1); v2 signals may grade. */
  strength: number;
  /** One human-readable line for the reasoning feed. */
  detail: string;
  /** Numeric snapshot for the reasoning log. */
  snapshot: Record<string, number>;
}

export interface Signal {
  readonly name: string;
  vote(input: SignalInput): SignalVote;
}

/** Simple moving average over closes; null when there isn't enough data. */
export function sma(closes: number[], period: number): number | null {
  if (closes.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/**
 * v1 signal: 4h/1d moving-average cross, evaluated on daily cadence.
 *
 * fast = SMA(MA_FAST_PERIOD) over CLOSED 4h closes  (~2d of trend)
 * slow = SMA(MA_SLOW_PERIOD) over CLOSED 1d closes  (~10d of trend)
 * A cross is a TRANSITION, not a level: fast crosses above slow between the
 * "previous" window (24h earlier) and now. This fires once per regime change,
 * so a persistent trend does not re-trigger every tick.
 */
export class MaCrossSignal implements Signal {
  readonly name = 'ma-cross-4h-1d';

  vote(input: SignalInput): SignalVote {
    const c4 = dropForming(input.candles4h);
    const c1 = dropForming(input.candles1d);
    const fast = closes(c4);
    const slow = closes(c1);

    const fastNow = sma(fast, MA_FAST_PERIOD);
    const slowNow = sma(slow, MA_SLOW_PERIOD);
    // "Previous" window: 6 x 4h candles (24h) earlier for fast, 1 day earlier for slow.
    const fastPrev = sma(fast.slice(0, Math.max(0, fast.length - 6)), MA_FAST_PERIOD);
    const slowPrev = sma(slow.slice(0, Math.max(0, slow.length - 1)), MA_SLOW_PERIOD);

    const snapshot: Record<string, number> = {
      fundingRate: input.fundingRate,
      ...(fastNow !== null ? { maFast: fastNow } : {}),
      ...(slowNow !== null ? { maSlow: slowNow } : {}),
      ...(fastPrev !== null ? { maFastPrev: fastPrev } : {}),
      ...(slowPrev !== null ? { maSlowPrev: slowPrev } : {}),
    };

    if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
      return {
        name: this.name,
        direction: 'flat',
        strength: 0,
        detail: `insufficient candle history (need ${MA_FAST_PERIOD} 4h + ${MA_SLOW_PERIOD} 1d closes)`,
        snapshot,
      };
    }

    const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
    const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;

    if (crossedUp) {
      return {
        name: this.name,
        direction: 'long',
        strength: 1,
        detail:
          `4h MA(${MA_FAST_PERIOD}) crossed ABOVE 1d MA(${MA_SLOW_PERIOD}): ` +
          `${fmt(fastPrev)}→${fmt(fastNow)} vs ${fmt(slowPrev)}→${fmt(slowNow)} — uptrend emerging`,
        snapshot,
      };
    }
    if (crossedDown) {
      return {
        name: this.name,
        direction: 'short',
        strength: 1,
        detail:
          `4h MA(${MA_FAST_PERIOD}) crossed BELOW 1d MA(${MA_SLOW_PERIOD}): ` +
          `${fmt(fastPrev)}→${fmt(fastNow)} vs ${fmt(slowPrev)}→${fmt(slowNow)} — downtrend emerging`,
        snapshot,
      };
    }
    return {
      name: this.name,
      direction: 'flat',
      strength: 0,
      detail: `no fresh cross (fast ${fmt(fastNow)} vs slow ${fmt(slowNow)})`,
      snapshot,
    };
  }
}

/** Drop the still-forming (latest) candle — signals only read closed candles. */
function dropForming(candles: Candle[]): Candle[] {
  return candles.length > 1 ? candles.slice(0, -1) : candles;
}

function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : n.toFixed(2);
}

/**
 * Vote combiner. v1: a single registered signal, so its vote stands.
 * v2: replace with weighted/majority voting across signals — the combiner is
 * the ONLY place multi-signal logic lives; signals stay independent.
 */
export function combineVotes(votes: SignalVote[]): SignalVote {
  const active = votes.filter((v) => v.direction !== 'flat');
  if (active.length === 0) return votes[0] ?? { name: 'none', direction: 'flat', strength: 0, detail: 'no signals registered', snapshot: {} };
  // v1: first non-flat vote wins. v2: weight by strength / require agreement here.
  const winner = active[0];
  if (active.length > 1) {
    const agreeing = active.filter((v) => v.direction === winner.direction);
    if (agreeing.length !== active.length) {
      return {
        name: 'combiner',
        direction: 'flat',
        strength: 0,
        detail: `signal disagreement (${active.map((v) => `${v.name}:${v.direction}`).join(', ')}) — standing aside`,
        snapshot: {},
      };
    }
  }
  return winner;
}

/** Registry — v2 signals register here; the engine never names a signal directly. */
export class SignalRegistry {
  private signals: Signal[] = [];
  register(s: Signal): void {
    this.signals.push(s);
  }
  voteAll(input: SignalInput): SignalVote[] {
    return this.signals.map((s) => {
      try {
        return s.vote(input);
      } catch (err) {
        return {
          name: s.name,
          direction: 'flat' as const,
          strength: 0,
          detail: `signal error: ${(err as Error).message}`,
          snapshot: {},
        };
      }
    });
  }
  get names(): string[] {
    return this.signals.map((s) => s.name);
  }
}

/** v1 default: MA-cross only. */
export function defaultSignals(): SignalRegistry {
  const r = new SignalRegistry();
  r.register(new MaCrossSignal());
  return r;
}
