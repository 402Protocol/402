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
 *   GET  /foundry/skill.md   the one-line agent onboarding: install the
 *                            Foundry MCP and run the launch sequence. This is
 *                            the handoff: give this URL to an agent, boom done.
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
const DryRunBody = z
  .object({
    name: z.string().min(1).max(32),
    symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional(),
    /** Plain-words alias: fresh agents say "ticker", the schema says "symbol". */
    ticker: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional(),
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
})
  .refine((d) => d.symbol ?? d.ticker, {
    message: 'symbol is required ("ticker" is accepted as an alias)',
  });

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The one-line agent onboarding, served at GET /foundry/skill.md.
 * Written for the agent reading it: install, wallet ritual, identity,
 * the gated sequence, the rules. Kept tight on purpose.
 */
const FOUNDRY_SKILL = `# Foundry skill

You are running the Foundry launch sequence for your human: forge a memecoin on Ink. Your human approves before anything real happens. Agents propose, humans approve.

## Step 0: install your tools (one command)

\`\`\`bash
npx -y foundry-mcp
\`\`\`

Add it to your MCP config:

\`\`\`json
{
  "mcpServers": {
    "foundry": {
      "command": "npx",
      "args": ["-y", "foundry-mcp"],
      "env": { "HOOKIT_PRIVATE_KEY": "<launch-wallet-private-key>" }
    }
  }
}
\`\`\`

No-install fallback (reads and dry runs only, signs nothing):

- GET https://402-production.up.railway.app/foundry/presets
- GET https://402-production.up.railway.app/foundry/modules
- GET https://402-production.up.railway.app/foundry/pairs
- POST https://402-production.up.railway.app/foundry/dry-run

## Step 1: wallet (first run only)

1. Generate a fresh launch wallet. Never reuse a wallet between agents.
2. Show the human the address and the seed phrase. The human backs it up offline and confirms.
3. Fund it: 0.0005 ETH plus gas, on Ink. (Kraken withdraws ETH directly to Ink.)
4. HOOKIT_PRIVATE_KEY goes in the MCP env. Never print it, never paste it into chat, never commit it.

## Step 2: identity

Check if you have an ERC-8004 identity. If not, register one. You will need an Ink wallet with gas for that, so ask the human for it. Pass your id as erc8004Id on every request_ tool. No ID, no launch.

## Step 3: forge

foundry_list_presets, foundry_list_modules, foundry_list_pairs. YOU choose the name, ticker, preset, and pair.

## Step 4: dry run

foundry_prepare_launch. Always a dry run, enforced. Show the human the verdict in plain words, including the opening anti-snipe tax if the preset carries one. Most presets open with a 90 percent anti-snipe tax for about 30 seconds. Say so.

## Step 5: approval

foundry_request_launch writes a pending approval. Tell the human what approving would do, then wait. Nothing is signed, funded, or launched without the human's word.

## Step 6: launch

On approval the launch executes and the record lands in foundry_launches under your ERC-8004 id. That is your track record.

## Rules (never break)

- Dry run before every launch.
- Human approval before every launch, fee claim, and ETH send.
- One ERC-8004 identity per agent. No ID, no launch.
- Disclose the anti-snipe tax plainly.
- Keys live in the environment only.
- Never skip a step.
`;

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

  // The one-line agent onboarding. Give this URL to an agent: it installs
  // the Foundry MCP and runs the launch sequence end to end. Docs only,
  // no signing, no keys, nothing gated.
  app.get('/skill.md', (c) =>
    c.text(FOUNDRY_SKILL, 200, {
      'content-type': 'text/markdown; charset=utf-8',
    }),
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
    // lowercase pair ids like "eth"). `ticker` is the plain-words alias
    // fresh agents reach for; the schema calls it `symbol`.
    const symbol = (p.symbol ?? p.ticker) as string;
    const upstream: Record<string, unknown> = {
      name: p.name,
      symbol,
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
      // Surface the opening anti-snipe tax as a first-class warning. Every
      // Hookit preset (including "clean") opens with ~90% anti-snipe for
      // about 30 seconds, and the upstream verdict does not say so — a
      // normie launching their first coin should read it here, not discover
      // it as a surprise. Skip only if the verdict already discloses it.
      const warnings: string[] = [];
      if (!/snipe/i.test(JSON.stringify(verdict ?? {}))) {
        warnings.push(
          'Opening anti-snipe tax: this launch opens with a 90% anti-snipe tax for about 30 seconds. The coin will look like a honeypot until it lifts. This is standard on Hookit launches, not a defect in the coin.',
        );
      }
      return c.json({ ok: true, dryRun: true, warnings, result: verdict });
    } catch (e) {
      return c.json({ ok: false, error: errMessage(e) }, 502);
    }
  });

  return app;
}
