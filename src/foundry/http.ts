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
 *   POST /foundry/image     token-art upload: PNG (multipart), returns a
 *                            public URL for the launch `image` field. Size
 *                            cap + hourly budget; content-hashed filenames.
 *   GET  /foundry/img/:hash serves an uploaded PNG (immutable, cacheable)
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
 *   - Token-art uploads are unauthenticated by design (agents have no login),
 *     so the endpoint is deliberately small: PNG only (magic bytes checked),
 *     2 MB cap, GLOBAL 20/hour budget, content-hashed filenames (same bytes
 *     => same URL, no enumeration), served immutable. Disk abuse surface is
 *     bounded by (budget x cap) per hour. Set FOUNDRY_IMAGE_DIR to a
 *     persistent volume (e.g. /data/foundry-images) or uploads vanish on
 *     redeploy.
 *   - The catalog is cached in-memory (10 min TTL) so public traffic cannot
 *     be used to hammer Hookit's API.
 *
 * Mounted unconditionally in the facilitator: dry runs are free, keyless,
 * and sign nothing, so no env gate is needed. Also rate-limited per-IP at
 * mount time as an abuse backstop.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOKIT_API_URL =
  (process.env.HOOKIT_API_URL ?? '').trim() || 'https://www.hookit.fun';
const CATALOG_TTL_MS = 10 * 60_000;
/** Hookit: 50 prepare-launch/hour per egress IP. We are one IP. Keep headroom. */
const DRY_RUN_PER_HOUR = 40;
/** Token-art uploads: PNG only, 2 MB cap, tight hourly budget (abuse backstop). */
const IMAGE_MAX_BYTES = 2_000_000;
const IMAGE_UPLOADS_PER_HOUR = 20;
const IMAGE_DIR =
  (process.env.FOUNDRY_IMAGE_DIR ?? '').trim() ||
  join(process.cwd(), 'data', 'foundry-images');
/** Public mount path of this sub-app in the facilitator (used for image URLs). */
const PUBLIC_BASE_PATH = '/foundry';
/** PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A. Checked, not trusted from headers. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface FoundryHttpOptions {
  fetchFn?: typeof fetch;
  /** Override the global dry-run budget (tests). */
  dryRunPerHour?: number;
  /** Override the token-art upload directory (tests). Defaults to FOUNDRY_IMAGE_DIR. */
  imageDir?: string;
  /** Override the global image-upload budget (tests). */
  imageUploadsPerHour?: number;
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
  hookTaxPct: z.number().min(0).max(9).optional(), // hookit range is 0-9
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
npx -y 402-foundry-mcp@latest
\`\`\`

Add it to your MCP config:

\`\`\`json
{
  "mcpServers": {
    "foundry": {
      "command": "npx",
      "args": ["-y", "402-foundry-mcp@latest"],
      "env": { "HOOKIT_PRIVATE_KEY": "<launch-wallet-private-key>" }
    }
  }
}
\`\`\`

No-install fallback (steps 3-4 only: reads and dry runs, signs nothing).
Steps 5-6 require the MCP install from Step 0 — there is no HTTP path for
filing approvals or launching:

- GET https://402-production.up.railway.app/foundry/presets
- GET https://402-production.up.railway.app/foundry/modules
- GET https://402-production.up.railway.app/foundry/pairs
- POST https://402-production.up.railway.app/foundry/dry-run

## Step 1: wallet (first run only)

1. Generate a fresh launch wallet. Never reuse a wallet between agents.
2. Give the human the address in chat. Write the seed phrase to a local file and tell the human the path — never print or paste it into chat, logs, or memory. The human copies it into their secret storage, deletes the file, and confirms the backup.
3. Ask the human to fund it ONCE with ~0.0025 ETH on Ink. One roundtrip covers the identity registration gas, the 0.0005 ETH launch fee, launch gas, and the 0.001 ETH Foundry fee (collected at approval, before the launch broadcasts — no volume cut). (Kraken withdraws ETH directly to Ink.)
4. HOOKIT_PRIVATE_KEY goes in the MCP env. Never print it, never paste it into chat, never commit it.

## Step 2: identity

Check if you have an ERC-8004 identity. If not, register one from your funded
launch wallet as soon as it is funded, then continue: call
register(string agentURI) on 0x7274e874CA62410a93Bd8bf61c69d8045E399c02
(the ERC-8004 identity registry on Ink, permissionless, gas-only) with your
agent card URI, and note the returned agent id. Pass your id as erc8004Id on
every foundry_ MCP tool. (The HTTP dry-run doesn't take it.) No ID, no launch.

## Step 3: forge

foundry_list_presets, foundry_list_modules, foundry_list_pairs. YOU choose the name, ticker (or symbol — both work), preset, and pair. You also invent the description and twitter/telegram/website. Generate the token art yourself, upload the PNG to POST /foundry/image (multipart field "image"), and pass the returned URL as image (it lands in the onchain metadata). If you can't generate or upload art, skip the image rather than asking the human — everything creative is your job. Funding the wallet and approving the launch stay human.

## Step 4: dry run

foundry_prepare_launch. Always a dry run, enforced. Show the human the verdict in plain words, including the opening anti-snipe tax if the preset carries one. Most presets open with a 90 percent anti-snipe tax for about 30 seconds. Say so.

## Step 5: approval (MCP only — no HTTP fallback)

foundry_request_launch writes a pending approval. Tell the human what approving would do, then wait. Nothing is signed, funded, or launched without the human's word.

## Step 6: launch (MCP only)

On approval the launch executes and the record lands in foundry_launches under your ERC-8004 id. That is your track record. The 0.001 ETH Foundry fee is collected AFTER a successful launch; a failed launch collects nothing. Anyone can see the token at https://www.hookit.fun/token/<token-address>.

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

  // Global image-upload budget: same fixed-window shape as dry runs.
  const imageBudget = opts.imageUploadsPerHour ?? IMAGE_UPLOADS_PER_HOUR;
  const imageDir = opts.imageDir ?? IMAGE_DIR;
  let imgWindowStart = 0;
  let imgWindowUsed = 0;
  function imageUploadAllowed(): boolean {
    const now = Date.now();
    if (now - imgWindowStart >= 3_600_000) {
      imgWindowStart = now;
      imgWindowUsed = 0;
    }
    if (imgWindowUsed >= imageBudget) return false;
    imgWindowUsed += 1;
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

  // No public launch feed: launches are recorded in each agent's local MCP
  // database (their reputation trail), not here. Anyone who wants to see a
  // token can look it up on Hookit: https://www.hookit.fun
  // (per Father's call 2026-10-04: link Hookit's site, don't show our own feed).

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
      // Surface the opening anti-snipe tax as a first-class warning, every
      // time. Every Hookit preset (including "clean") opens with ~90%
      // anti-snipe for about 30 seconds. The upstream verdict can mention
      // "snipe" in machine-readable form (hook ids, calldata) without
      // disclosing it in plain words — and relying on agent diligence for a
      // disclosure that matters means a lazy agent skips it and the human
      // never hears their coin looks like a honeypot for 30 seconds. Always
      // warn; a duplicate warning costs nothing, a missing one costs trust.
      const warnings: string[] = [
        'Opening anti-snipe tax: this launch opens with a 90% anti-snipe tax for about 30 seconds. The coin will look like a honeypot until it lifts. This is standard on Hookit launches, not a defect in the coin.',
      ];
      return c.json({ ok: true, dryRun: true, warnings, result: verdict });
    } catch (e) {
      return c.json({ ok: false, error: errMessage(e) }, 502);
    }
  });

  // Token-art upload. Agents generate their own PFP, POST the PNG here, and
  // pass the returned URL as the launch `image` field (it lands in the
  // onchain metadata). Unauthenticated by design (agents have no login);
  // the limits in the header comment are the abuse backstop.
  app.post('/image', async (c) => {
    if (!imageUploadAllowed()) {
      return c.json(
        { ok: false, error: 'image upload budget exhausted for this hour, try again later' },
        429,
      );
    }
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ ok: false, error: 'expected multipart form data' }, 400);
    }
    const file = body['image'] ?? body['file'];
    if (!(file instanceof File)) {
      return c.json({ ok: false, error: 'no PNG file uploaded (field: image)' }, 400);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
      return c.json(
        { ok: false, error: `PNG must be non-empty and under ${IMAGE_MAX_BYTES / 1_000_000} MB` },
        413,
      );
    }
    if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return c.json({ ok: false, error: 'not a PNG (magic bytes mismatch)' }, 400);
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      mkdirSync(imageDir, { recursive: true });
      const dest = join(imageDir, `${hash}.png`);
      if (!existsSync(dest)) writeFileSync(dest, bytes);
    } catch (e) {
      return c.json({ ok: false, error: `storage failure: ${errMessage(e)}` }, 500);
    }
    const url = `${new URL(c.req.url).origin}${PUBLIC_BASE_PATH}/img/${hash}.png`;
    return c.json({ ok: true, url });
  });

  // Serve uploaded token art. Hash-only filenames: no traversal is possible
  // (64 hex chars enforced), content is immutable => long cache.
  app.get('/img/:hash', (c) => {
    let hash = c.req.param('hash');
    // The public URL carries the .png extension; the on-disk name is bare hex.
    if (hash.endsWith('.png')) hash = hash.slice(0, -4);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return c.json({ ok: false, error: 'not found' }, 404);
    }
    const dest = join(imageDir, `${hash}.png`);
    if (!existsSync(dest)) {
      return c.json({ ok: false, error: 'not found' }, 404);
    }
    const bytes = readFileSync(dest);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  return app;
}
