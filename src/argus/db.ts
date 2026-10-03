/**
 * ArgusDb — SQLite state for the paper trader (node:sqlite, DatabaseSync).
 *
 * Tables: portfolio (single-row cash ledger), positions, trades, reasoning,
 * equity_snapshots. Synchronous API, single process. The DB is the source of
 * truth across restarts: the engine loads positions into the executor at boot.
 *
 * PAPER ONLY — this database holds simulated fills. No keys, no real balances.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Position, ReasoningEntry, Trade } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cash_usd REAL NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  product_id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  size_base REAL NOT NULL,
  notional_usd REAL NOT NULL,
  entry_price REAL NOT NULL,
  leverage REAL NOT NULL,
  stop_price REAL NOT NULL,
  opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  action TEXT NOT NULL,
  size_base REAL NOT NULL,
  price REAL NOT NULL,
  notional_usd REAL NOT NULL,
  fee_usd REAL NOT NULL,
  realized_pnl_usd REAL,
  reason TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
CREATE TABLE IF NOT EXISTS reasoning (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  product_id INTEGER,
  ticker TEXT,
  decision TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reasoning_ts ON reasoning(ts);
CREATE TABLE IF NOT EXISTS equity_snapshots (
  ts INTEGER PRIMARY KEY,
  equity_usd REAL NOT NULL,
  cash_usd REAL NOT NULL,
  unrealized_usd REAL NOT NULL
);
`;

function rowToPosition(row: Record<string, unknown>): Position {
  return {
    productId: row.product_id as number,
    ticker: row.ticker as string,
    side: row.side as 'long' | 'short',
    sizeBase: row.size_base as number,
    notionalUsd: row.notional_usd as number,
    entryPrice: row.entry_price as number,
    leverage: row.leverage as number,
    stopPrice: row.stop_price as number,
    openedAt: row.opened_at as number,
  };
}

function rowToTrade(row: Record<string, unknown>): Trade {
  return {
    id: row.id as string,
    productId: row.product_id as number,
    ticker: row.ticker as string,
    side: row.side as 'long' | 'short',
    action: row.action as 'open' | 'close',
    sizeBase: row.size_base as number,
    price: row.price as number,
    notionalUsd: row.notional_usd as number,
    feeUsd: row.fee_usd as number,
    realizedPnlUsd: row.realized_pnl_usd as number | null,
    reason: row.reason as string,
    ts: row.ts as number,
  };
}

function rowToReasoning(row: Record<string, unknown>): ReasoningEntry {
  return {
    id: row.id as string,
    ts: row.ts as number,
    productId: row.product_id as number | null,
    ticker: row.ticker as string | null,
    decision: row.decision as string,
    body: row.body as string,
  };
}

export class ArgusDb {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** node:sqlite has no transaction() helper — BEGIN/COMMIT manually. */
  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  // ---- portfolio ----

  /** Initialize the paper bankroll on first boot; no-op afterwards. */
  initPortfolio(startingCash: number, now: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO portfolio (id, cash_usd, started_at) VALUES (1, ?, ?)',
      )
      .run(startingCash, now);
  }

  getCash(): number | null {
    const row = this.db
      .prepare('SELECT cash_usd FROM portfolio WHERE id = 1')
      .get() as Record<string, unknown> | undefined;
    return row ? (row.cash_usd as number) : null;
  }

  setCash(cash: number): void {
    this.db.prepare('UPDATE portfolio SET cash_usd = ? WHERE id = 1').run(cash);
  }

  // ---- positions ----

  upsertPosition(p: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions
           (product_id, ticker, side, size_base, notional_usd, entry_price, leverage, stop_price, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           ticker=excluded.ticker, side=excluded.side, size_base=excluded.size_base,
           notional_usd=excluded.notional_usd, entry_price=excluded.entry_price,
           leverage=excluded.leverage, stop_price=excluded.stop_price, opened_at=excluded.opened_at`,
      )
      .run(
        p.productId, p.ticker, p.side, p.sizeBase, p.notionalUsd,
        p.entryPrice, p.leverage, p.stopPrice, p.openedAt,
      );
  }

  removePosition(productId: number): void {
    this.db.prepare('DELETE FROM positions WHERE product_id = ?').run(productId);
  }

  allPositions(): Position[] {
    const rows = this.db.prepare('SELECT * FROM positions').all() as Record<string, unknown>[];
    return rows.map(rowToPosition);
  }

  // ---- trades ----

  insertTrade(t: Trade): void {
    this.db
      .prepare(
        `INSERT INTO trades
           (id, product_id, ticker, side, action, size_base, price, notional_usd, fee_usd, realized_pnl_usd, reason, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.productId, t.ticker, t.side, t.action, t.sizeBase, t.price,
        t.notionalUsd, t.feeUsd, t.realizedPnlUsd, t.reason, t.ts,
      );
  }

  recentTrades(limit: number): Trade[] {
    const rows = this.db
      .prepare('SELECT * FROM trades ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToTrade);
  }

  /** Sum of realized PnL (net of exit fees) for closes since ts (UTC day). */
  realizedSince(ts: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl_usd), 0) AS s FROM trades
         WHERE action = 'close' AND ts >= ?`,
      )
      .get(ts) as Record<string, unknown> | undefined;
    return (row?.s as number) ?? 0;
  }

  /** Sum of fees paid since ts (both open and close fills). */
  feesSince(ts: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(fee_usd), 0) AS s FROM trades WHERE ts >= ?')
      .get(ts) as Record<string, unknown> | undefined;
    return (row?.s as number) ?? 0;
  }

  // ---- reasoning ----

  insertReasoning(e: ReasoningEntry): void {
    this.db
      .prepare(
        'INSERT INTO reasoning (id, ts, product_id, ticker, decision, body) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(e.id, e.ts, e.productId, e.ticker, e.decision, e.body);
  }

  recentReasoning(limit: number): ReasoningEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM reasoning ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToReasoning);
  }

  // ---- equity ----

  snapshotEquity(ts: number, equityUsd: number, cashUsd: number, unrealizedUsd: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO equity_snapshots (ts, equity_usd, cash_usd, unrealized_usd) VALUES (?, ?, ?, ?)',
      )
      .run(ts, equityUsd, cashUsd, unrealizedUsd);
  }

  equityCurve(limit: number): { ts: number; equityUsd: number }[] {
    const rows = this.db
      .prepare('SELECT ts, equity_usd FROM equity_snapshots ORDER BY ts DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ts: r.ts as number, equityUsd: r.equity_usd as number })).reverse();
  }

  /** Persist a fill (open or close) atomically with the cash + position update. */
  recordFill(trade: Trade, cashAfter: number, position: Position | null): void {
    this.txn(() => {
      this.insertTrade(trade);
      this.setCash(cashAfter);
      if (position) this.upsertPosition(position);
      else this.removePosition(trade.productId);
    });
  }
}
