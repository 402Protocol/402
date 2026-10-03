/**
 * Argus paper executor — simulated fills, positions, PnL.
 *
 * PAPER ONLY. Fills are simulated at the live mark price with modeled costs;
 * nothing is signed, broadcast, or sent anywhere. The executor only fills
 * proposals handed to it by the engine AFTER risk approval — it performs no
 * risk checks itself (defense in depth: it also refuses obviously insane
 * inputs like non-positive prices).
 *
 * Fill model (documented in BUILD_NOTES.md):
 *   - taker fee: 5 bps on notional, each side
 *   - slippage: 2 bps adverse on each fill
 * Costs are deducted from cash immediately; PnL settles on close.
 *
 * Margin model: margin = notional / leverage. If unrealized loss reaches the
 * full margin, the position is auto-liquidated at mark (bankruptcy guard).
 * With 2x leverage and 2% stops this should never fire, but the guard is here
 * so a gap move can't take equity negative through this module.
 */
import { randomBytes } from 'node:crypto';
import {
  SLIPPAGE_BPS,
  TAKER_FEE_BPS,
  type Position,
  type Side,
  type Trade,
  type TradeProposal,
} from './types.js';

function feeForNotional(notionalUsd: number): number {
  return (notionalUsd * TAKER_FEE_BPS) / 10_000;
}

/** Adverse slippage: longs pay a touch more, shorts receive a touch less. */
function applySlippage(price: number, side: Side, opening: boolean): number {
  const slip = (price * SLIPPAGE_BPS) / 10_000;
  if (side === 'long') return opening ? price + slip : price - slip;
  return opening ? price - slip : price + slip;
}

export class PaperExecutor {
  private cash: number;
  private positions = new Map<number, Position>();

  constructor(startingCash: number, positions: Position[] = []) {
    this.cash = startingCash;
    for (const p of positions) this.positions.set(p.productId, { ...p });
  }

  getCash(): number {
    return this.cash;
  }

  getPositions(): Position[] {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  getPosition(productId: number): Position | null {
    const p = this.positions.get(productId);
    return p ? { ...p } : null;
  }

  /**
   * Open a position from an APPROVED proposal. Fills at mark +/- slippage,
   * pays the taker fee from cash immediately.
   */
  open(proposal: TradeProposal, now: number): { position: Position; trade: Trade } {
    if (proposal.refPrice <= 0 || proposal.notionalUsd <= 0 || proposal.leverage <= 0) {
      throw new Error('executor: invalid proposal (non-positive price/notional/leverage)');
    }
    if (this.positions.has(proposal.productId)) {
      throw new Error(`executor: ${proposal.ticker} already has an open position`);
    }
    const fillPrice = applySlippage(proposal.refPrice, proposal.side, true);
    const sizeBase = proposal.notionalUsd / fillPrice;
    const fee = feeForNotional(proposal.notionalUsd);
    this.cash -= fee;

    const position: Position = {
      productId: proposal.productId,
      ticker: proposal.ticker,
      side: proposal.side,
      sizeBase,
      notionalUsd: proposal.notionalUsd,
      entryPrice: fillPrice,
      leverage: proposal.leverage,
      stopPrice: proposal.stopPrice,
      openedAt: now,
    };
    this.positions.set(proposal.productId, position);
    const trade: Trade = {
      id: `argus-${now}-${randomBytes(4).toString('hex')}`,
      productId: proposal.productId,
      ticker: proposal.ticker,
      side: proposal.side,
      action: 'open',
      sizeBase,
      price: fillPrice,
      notionalUsd: proposal.notionalUsd,
      feeUsd: fee,
      realizedPnlUsd: null,
      reason: 'signal-fill',
      ts: now,
    };
    return { position: { ...position }, trade };
  }

  /**
   * Close at the given mark price. Exit fill gets adverse slippage; exit fee
   * is charged on exit notional. Realized PnL = gross move - exit fee.
   * (Entry fee was already deducted from cash at open.)
   */
  close(productId: number, markPrice: number, reason: string, now: number): Trade | null {
    const pos = this.positions.get(productId);
    if (!pos || markPrice <= 0) return null;
    const exitPrice = applySlippage(markPrice, pos.side, false);
    const exitNotional = pos.sizeBase * exitPrice;
    const exitFee = feeForNotional(exitNotional);
    const gross =
      pos.side === 'long'
        ? (exitPrice - pos.entryPrice) * pos.sizeBase
        : (pos.entryPrice - exitPrice) * pos.sizeBase;
    const realized = gross - exitFee;
    this.cash += realized;
    this.positions.delete(productId);
    return {
      id: `argus-${now}-${randomBytes(4).toString('hex')}`,
      productId: pos.productId,
      ticker: pos.ticker,
      side: pos.side,
      action: 'close',
      sizeBase: pos.sizeBase,
      price: exitPrice,
      notionalUsd: exitNotional,
      feeUsd: exitFee,
      realizedPnlUsd: realized,
      reason,
      ts: now,
    };
  }

  /** Unrealized PnL for one position at the given mark (fees already paid). */
  unrealized(pos: Position, markPrice: number): number {
    if (markPrice <= 0) return 0;
    return pos.side === 'long'
      ? (markPrice - pos.entryPrice) * pos.sizeBase
      : (pos.entryPrice - markPrice) * pos.sizeBase;
  }

  /** Total unrealized across open positions. */
  totalUnrealized(marks: Map<number, number>): number {
    let sum = 0;
    for (const pos of this.positions.values()) {
      const m = marks.get(pos.productId);
      if (m !== undefined) sum += this.unrealized(pos, m);
    }
    return sum;
  }

  /**
   * Stop-loss sweep: close any position whose stop is hit at the given marks.
   * Returns the close trades.
   */
  checkStops(marks: Map<number, number>, now: number): Trade[] {
    const closed: Trade[] = [];
    for (const pos of [...this.positions.values()]) {
      const m = marks.get(pos.productId);
      if (m === undefined || m <= 0) continue;
      const hit = pos.side === 'long' ? m <= pos.stopPrice : m >= pos.stopPrice;
      if (hit) {
        const t = this.close(pos.productId, m, 'stop-loss', now);
        if (t) closed.push(t);
      }
    }
    return closed;
  }

  /**
   * Bankruptcy guard: liquidate any position whose unrealized loss has eaten
   * the full margin. Returns the close trades.
   */
  checkLiquidations(marks: Map<number, number>, now: number): Trade[] {
    const closed: Trade[] = [];
    for (const pos of [...this.positions.values()]) {
      const m = marks.get(pos.productId);
      if (m === undefined || m <= 0) continue;
      const margin = pos.notionalUsd / pos.leverage;
      if (this.unrealized(pos, m) <= -margin) {
        const t = this.close(pos.productId, m, 'liquidated', now);
        if (t) closed.push(t);
      }
    }
    return closed;
  }

  equity(marks: Map<number, number>): number {
    return this.cash + this.totalUnrealized(marks);
  }
}
