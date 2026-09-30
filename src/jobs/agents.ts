import { Hono } from 'hono';
import type { JobsDb } from './db.js';
import type { ResolveAgentSeat } from './escrow.js';

export interface AgentsAppDeps {
  /**
   * Live seat-token resolution for an agent's ERC-8004 id. Null when the
   * TRACES seat registry is not configured (same env-gating as the seat
   * gate) — every agent then reports seatTokenId: null and the frontend
   * falls back to the deterministic-by-wallet placeholder thumbnail.
   * Injectable for tests.
   */
  resolveSeat?: ResolveAgentSeat | null;
}

/**
 * The Agents tab: a public directory of every enrolled worker with live
 * status. Mounted at /agents on the facilitator (the data lives in the
 * jobs DB). Public read, no auth — the same convention as the other public
 * GETs (rate limits apply to writes).
 */
export function createAgentsApp(db: JobsDb, deps: AgentsAppDeps = {}): Hono {
  const app = new Hono();
  const resolveSeat = deps.resolveSeat ?? null;

  app.get('/', async (c) => {
    const agents = db.listAgents();
    // Seat token ids resolve live per agent from the onchain registry —
    // never from the DB. Fail-soft: an unresolvable agent reads null.
    // avatarUrl points at the snapshotted seat artwork (the agent's
    // canonical face) when one exists; null otherwise, and the frontend
    // keeps its deterministic-by-wallet placeholder fallback.
    const rows = await Promise.all(
      agents.map(async (a) => ({
        ...a,
        seatTokenId:
          a.agentId && resolveSeat ? await resolveSeat(a.agentId) : null,
        avatarUrl: db.hasAvatar(a.wallet)
          ? `/agents/${a.wallet}/avatar`
          : null,
      })),
    );
    return c.json({ agents: rows, total: rows.length });
  });

  // Serve a snapshotted avatar. Public read like the rest of the
  // directory; 404 JSON when no snapshot exists for the wallet.
  app.get('/:wallet/avatar', (c) => {
    const avatar = db.getAvatar(c.req.param('wallet'));
    if (!avatar) return c.json({ error: 'avatar_not_found' }, 404);
    // The URL is stable per wallet but the bytes can change on re-pairing
    // (latest face wins), so cache briefly, not immutably.
    return c.body(new Uint8Array(avatar.imageBytes), 200, {
      'Content-Type': avatar.contentType,
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    });
  });

  return app;
}
