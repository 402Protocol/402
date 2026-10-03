/**
 * Foundry public HTTP surface — DRY-RUN ONLY.
 *
 * This is the bridge between the Foundry landing page and the Hookit launch
 * infrastructure. It uses Hookit's documented agent HTTP API (no MCP child,
 * no key anywhere):
 *
 *   GET  /api/agents/catalog         presets, modules, pairs (cached 10 min)
 *   POST /api/agents/prepare-launch  unsigned tx + validation verdict
 *
 * Routes:
 *   GET  /foundry/health     liveness
 *   GET  /foundry/presets    presets from the catalog
 *   GET  /foundry/modules    modules from the catalog
 *   GET  /foundry/pairs      pairs from the catalog
 *   POST /foundry/dry-run    prepare-launch verdict (unsigned, never signed)
 *
 * Safety properties (all enforced here, not trusted from callers):
 *   - This surface is read + simulate only. There is no code path here that
 *     can sign or broadcast: prepare-launch answers with an UNSIGNED
 *     transaction and no private key ever touches this process for Foundry.
 *   - Gated actions (request_launch, approve, request_claim_fees,
 *     request_send_eth, wallet_status) are NOT mounted here. They exist only
 *     on the agent MCP server behind human approval. Adding them to this
 *     file would be a security bug — do not.
 *   - Hookit budgets prepare-launch at 50 calls/hour per egress IP, and our
 *     server is one IP to them — so the dry-run budget is GLOBAL (40/hour
 *     with headroom), not per visitor. Over budget => 429.
 *   - The catalog is cached in-memory (10 min TTL) so public traffic cannot
 *     be used to hammer Hookit's API.
 *
 * Mounted unconditionally in the facilitator: dry runs are free, keyless,
 * and sign nothing, so no env gate is needed. Also rate-limited per-IP at
 * mount time as an abuse backstop.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { FoundryDb } from './db.js';

const HOOKIT_API_URL =
  (process.env.HOOKIT_API_URL ?? '').trim() || 'https://www.hookit.fun';
const CATALOG_TTL_MS = 10 * 60_000;
/** Hookit: 50 prepare-launch/hour per egress IP. We are one IP. Keep headroom. */
const DRY_RUN_PER_HOUR = 40;

export interface FoundryHttpOptions {
  fetchFn?: typeof fetch;
  /** Override the global dry-run budget (tests). */
  dryRunPerHour?: number;
}

/**
 * POST /foundry/dry-run body. Bounds mirror the Foundry service validation;
 * fields are mapped onto Hookit's prepare-launch schema before forwarding.
 */
const DryRunBody = z.object({
  name: z.string().min(1).max(32),
  symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
  pair: z.string().min(1),
  preset: z.string().min(1).optional(),
  modules: z.array(z.string().min(1)).max(12).optional(),
  hookTaxPct: z.number().min(0).max(100).optional(),
  devBuyPct: z.number().min(0).max(2.5).optional(),
  /** 0x payout address; mapped to { kind: 'wallet', address }. */
  payout: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  image: z.string().url().optional(),
  twitter: z.string().max(120).optional(),
  telegram: z.string().max(120).optional(),
  website: z.string().url().optional(),
});

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createFoundryHttpApp(
  opts: FoundryHttpOptions = {},
): Hono {
  const fetchFn = opts.fetchFn ?? fetch;
  const dryRunBudget = opts.dryRunPerHour ?? DRY_RUN_PER_HOUR;
  const app = new Hono();

  let catalogCache: { at: number; value: any } | null = null;
  async function catalog(): Promise<any> {
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
      return catalogCache.value;
    }
    const res = await fetchFn(`${HOOKIT_API_URL}/api/agents/catalog`);
    if (!res.ok) throw new Error(`hookit catalog: HTTP ${res.status}`);
    const value = await res.json();
    catalogCache = { at: Date.now(), value };
    return value;
  }

  // Global dry-run budget: fixed window shared by all visitors.
  let windowStart = 0;
  let windowUsed = 0;
  function dryRunAllowed(): boolean {
    const now = Date.now();
    if (now - windowStart >= 3_600_000) {
      windowStart = now;
      windowUsed = 0;
    }
    if (windowUsed >= dryRunBudget) return false;
    windowUsed += 1;
    return true;
  }

  app.get('/health', (c) =>
    c.json({ ok: true, dryRunOnly: true, time: Date.now() }),
  );

  // Public launch feed: every executed launch, latest first. Powers the
  // spectacle on the site. Rows carry nothing sensitive.
  const dbPath = (process.env.FOUNDRY_DB_PATH ?? '').trim() || 'data/foundry.db';
  const db = new FoundryDb(dbPath);
  app.get('/launches', (c) => {
    try {
      const raw = Number.parseInt(c.req.query('limit') ?? '20', 10);
      const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 20, 1), 100);
      const rows = db.listLaunches().slice(0, limit);
      return c.json({
        ok: true,
        result: rows.map((r) => ({
          id: r.id,
          erc8004Id: r.erc8004_id,
          tokenName: r.token_name,
          tokenSymbol: r.token_symbol,
          preset: r.preset,
          modules: r.modules_json ? JSON.parse(r.modules_json) : null,
          pair: r.pair,
          snipeTaxPct: r.snipe_tax_pct,
          hookTaxPct: r.hook_tax_pct,
          devBuyPct: r.dev_buy_pct,
          launchTx: r.launch_tx,
          launchedAt: r.launched_at,
        })),
      });
    } catch (e) {
      return c.json({ ok: false, error: errMessage(e) }, 502);
    }
  });

  for (const [route, pick] of [
    ['/presets', (cat: any) => cat.presets],
    ['/modules', (cat: any) => cat.modules],
    ['/pairs', (cat: any) => cat.pairs],
  ] as const) {
    app.get(route, async (c) => {
      try {
        return c.json({ ok: true, result: pick(await catalog()) });
      } catch (e) {
        return c.json({ ok: false, error: errMessage(e) }, 502);
      }
    });
  }

  app.post('/dry-run', async (c) => {
    if (!dryRunAllowed()) {
      return c.json(
        { ok: false, error: 'dry-run budget exhausted for this hour, try again later' },
        429,
      );
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = DryRunBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'invalid launch parameters', details: parsed.error.flatten() },
        400,
      );
    }
    const p = parsed.data;
    // Map onto Hookit's prepare-launch schema (their example uses
    // lowercase pair ids like "eth").
    const upstream: Record<string, unknown> = {
      name: p.name,
      symbol: p.symbol,
      pair: p.pair.toLowerCase(),
    };
    if (p.preset) upstream.preset = p.preset;
    if (p.modules) upstream.modules = p.modules;
    if (p.hookTaxPct !== undefined) upstream.hookTaxPct = p.hookTaxPct;
    if (p.devBuyPct !== undefined) upstream.devBuyPct = p.devBuyPct;
    if (p.description) upstream.description = p.description;
    if (p.image) upstream.image = p.image;
    if (p.twitter) upstream.twitter = p.twitter;
    if (p.telegram) upstream.telegram = p.telegram;
    if (p.website) upstream.website = p.website;
    if (p.payout && /^0x[0-9a-fA-F]{40}$/.test(p.payout)) {
      upstream.payout = { kind: 'wallet', address: p.payout };
    }
    try {
      const res = await fetchFn(`${HOOKIT_API_URL}/api/agents/prepare-launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(upstream),
      });
      if (res.status === 429) {
        return c.json(
          { ok: false, error: 'hookit rate limit reached, try again later' },
          429,
        );
      }
      const verdict = (await res.json()) as { ok?: boolean; error?: string };
      if (verdict && verdict.ok === false) {
        // A combination the contracts would refuse: a validation verdict,
        // not a server failure — surface it as a 200 with ok:false.
        return c.json({
          ok: false,
          dryRun: true,
          error: verdict.error ?? 'hookit rejected the launch parameters',
          result: verdict,
        });
      }
      return c.json({ ok: true, dryRun: true, result: verdict });
    } catch (e) {
      return c.json({ ok: false, error: errMessage(e) }, 502);
    }
  });

  return app;
}
