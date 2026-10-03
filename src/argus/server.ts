/**
 * Argus HTTP routes.
 *
 *   GET  /argus/status    -> bankroll, equity, positions, kill/halt state
 *   GET  /argus/trades    -> trade history (?limit=)
 *   GET  /argus/reasoning -> "why I did it" feed (?limit=)
 *   POST /argus/kill      -> { secret } — Father-only kill switch
 *
 * The kill route is registered ONLY when a kill secret is supplied
 * (ARGUS_KILL_SECRET). Without it the route does not exist — fail closed.
 * There is no revive endpoint by design: a killed engine stays killed until
 * the process restarts.
 *
 * PAPER ONLY — these routes expose simulated state. No keys, no writes.
 */
import { Hono, type Context } from 'hono';
import type { ArgusEngine } from './engine.js';
import { ArgusDb } from './db.js';

export interface ArgusAppDeps {
  engine: ArgusEngine;
  /** Kill secret; when undefined the /kill route is NOT registered. */
  killSecret?: string;
  /** Only needed for /trades and /reasoning when the engine doesn't own the db. */
  db?: ArgusDb;
}

export function createArgusApp(deps: ArgusAppDeps): Hono {
  const app = new Hono();
  const { engine } = deps;

  app.get('/status', (c: Context) => {
    return c.json(engine.getStatus());
  });

  app.get('/trades', (c: Context) => {
    const limit = clampLimit(c.req.query('limit'), 50);
    const db = deps.db;
    if (!db) return c.json({ error: 'trades_unavailable' }, 503);
    return c.json({
      trades: db.recentTrades(limit).map((t) => ({
        id: t.id,
        ticker: t.ticker,
        side: t.side,
        action: t.action,
        size_base: t.sizeBase,
        price: t.price,
        notional_usd: t.notionalUsd,
        fee_usd: t.feeUsd,
        realized_pnl_usd: t.realizedPnlUsd,
        reason: t.reason,
        ts: t.ts,
      })),
    });
  });

  app.get('/reasoning', (c: Context) => {
    const limit = clampLimit(c.req.query('limit'), 50);
    const db = deps.db;
    if (!db) return c.json({ error: 'reasoning_unavailable' }, 503);
    return c.json({
      entries: db.recentReasoning(limit).map((e) => ({
        id: e.id,
        ts: e.ts,
        ticker: e.ticker,
        decision: e.decision,
        body: e.body,
      })),
    });
  });

  // Fail closed: no secret configured -> no kill route at all.
  if (deps.killSecret) {
    const secret = deps.killSecret;
    app.post('/kill', async (c: Context) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const provided =
        typeof (body as Record<string, unknown>)?.secret === 'string'
          ? ((body as Record<string, unknown>).secret as string)
          : '';
      if (!timingSafeEqual(provided, secret)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      engine.kill();
      return c.json({ ok: true, killed: true });
    });
  }

  return app;
}

function clampLimit(raw: string | undefined, def: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100) : def;
}

/** Constant-time string comparison to avoid leaking the secret via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
