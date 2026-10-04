/**
 * Argus trade auto-poster — every paper fill becomes a Lounge feed post.
 *
 * OVERRIDE NOTE (Father, 2026-10-02): the standing rule is that Lounge posts
 * need per-post approval. Father EXPLICITLY overrode this for Argus paper
 * trades — auto-post every single trade, locked. These posts are machine
 * telemetry (entry/exit, size, price, PnL, one-line why), not human claims.
 * The approval rule RETURNS the moment real money is involved (Phase 2).
 *
 * Posts go straight into the lounge DB via insertPost with the Argus system
 * author address. No payment, no signature — this is a server-side system post,
 * the same class as other automated feed entries.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import type { LoungeDb } from '../lounge/db.js';
import type { PortfolioStatus, Trade, TradeProposal } from './types.js';

/** Argus system author — a reserved zero-prefix address, never a real wallet. */
export const ARGUS_AUTHOR: Address = getAddress(
  '0x000000000000000000000000000000000000a295',
);
export const ARGUS_AUTHOR_NAME = 'Argus';

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPrice(n: number): string {
  return n >= 1000
    ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 1 })
    : '$' + n.toFixed(2);
}

/** Build the post title + body for a fill. Pure — easy to test. */
export function formatTradePost(
  trade: Trade,
  proposal: TradeProposal | null,
  status: PortfolioStatus,
): { title: string; body: string } {
  const dir = trade.side.toUpperCase();
  const action = trade.action === 'open' ? 'entered' : 'exited';
  const title =
    trade.action === 'open'
      ? `Argus ${action} ${dir} ${trade.ticker} ${fmtUsd(trade.notionalUsd)} @ ${fmtPrice(trade.price)}`
      : `Argus ${action} ${dir} ${trade.ticker} ${trade.realizedPnlUsd !== null && trade.realizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(trade.realizedPnlUsd ?? 0)}`;

  const lines: string[] = [
    `${dir} ${trade.ticker} ${trade.action === 'open' ? 'opened' : 'closed'}: ${trade.sizeBase.toFixed(6)} @ ${fmtPrice(trade.price)}`,
    `Notional ${fmtUsd(trade.notionalUsd)} · fee ${fmtUsd(trade.feeUsd)} · reason: ${trade.reason}`,
  ];
  if (trade.action === 'close' && trade.realizedPnlUsd !== null) {
    lines.push(`Realized PnL: ${fmtUsd(trade.realizedPnlUsd)}`);
  }
  if (proposal) {
    lines.push('', 'Why:');
    for (const r of proposal.reasoning) lines.push(`- ${r}`);
  }
  lines.push(
    '',
    `Bankroll ${fmtUsd(status.bankrollUsd)} · equity ${fmtUsd(status.equityUsd)} · open positions ${status.openPositions.length}`,
    'Paper trading only — no real money.',
  );
  return { title, body: lines.join('\n') };
}

/** Insert the post into the Lounge feed. Fail-soft: logs, never throws. */
export function postTradeToFeed(
  loungeDb: LoungeDb,
  trade: Trade,
  proposal: TradeProposal | null,
  status: PortfolioStatus,
  log: (msg: string) => void = () => {},
): void {
  try {
    const { title, body } = formatTradePost(trade, proposal, status);
    loungeDb.insertPost({
      id: `argus-${trade.id}`,
      author: ARGUS_AUTHOR,
      title,
      body,
      createdAt: trade.ts,
    });
    log(`[argus] posted trade to feed: ${title}`);
  } catch (err) {
    log(`[argus] feed post failed: ${(err as Error).message}`);
  }
}

/** A short random id suffix for reasoning entries. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}
