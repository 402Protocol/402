/**
 * Market-regime detection — the v2 slot.
 *
 * v1: NeutralRegime, a deliberate passthrough. Trend-following lives or dies on
 * regime: it prints in trends and bleeds in chop. v2 plugs real detection here
 * (e.g. ADX-style trend strength, realized-volatility bands, MA-slope
 * persistence) and the engine will consult it BEFORE signals run — e.g. stand
 * aside in chop, size up in confirmed trend. The interface is stable so the
 * engine, executor, and risk runtime never change when v2 lands.
 */
import type { SignalInput } from './signals.js';

export type Regime = 'trend' | 'chop' | 'unknown';

export interface RegimeReading {
  regime: Regime;
  /** Human-readable note for the reasoning feed. */
  note: string;
}

export interface RegimeDetector {
  readonly name: string;
  detect(input: SignalInput): RegimeReading;
}

/** v1: no opinion. Signals run unimpeded; filters and risk still apply. */
export class NeutralRegime implements RegimeDetector {
  readonly name = 'neutral-v1';
  detect(_input: SignalInput): RegimeReading {
    return { regime: 'unknown', note: 'regime detection not yet enabled (v1)' };
  }
}
