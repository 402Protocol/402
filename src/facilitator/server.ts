/**
 * 402 Phase 2 — facilitator HTTP server (Hono).
 *
 *   GET  /supported  -> { kinds, extensions, signers? }
 *   POST /verify     -> { paymentPayload, paymentRequirements } -> { isValid, invalidReason, payer? }
 *   POST /settle     -> { paymentPayload, paymentRequirements } -> { success, transaction?, network?, payer?, errorReason? }
 *   GET  /demo/data  -> x402 paywalled demo endpoint (402 -> PAYMENT-SIGNATURE -> data)
 *   GET  /health     -> liveness
 *
 * Approval posture: the facilitator moves payer-authorized funds only. It
 * never spends the operator's money beyond gas for settlement, and settlement
 * itself is gated on FOUR02_SETTLER_KEY + FOUR02_DRY_RUN=false.
 *
 * Nonce policy (H1): /verify is a READ-ONLY check and never consumes the
 * nonce. Consumption happens only (a) in /settle, after broadcast
 * confirmation or a passed dry-run simulation, or (b) in /demo/data, when
 * data is granted (L1 — one signature buys one access, even in dry-run).
 *
 * HTTP hardening (L3): JSON bodies are capped (64 KiB default) and a simple
 * in-memory per-IP rate limiter guards every route, strictest on /settle
 * (each call can spend operator gas).
 *
 * Settle auth (M1): POST /settle is gated on an API-key allowlist
 * (FOUR02_SETTLE_API_KEYS). With no keys configured, /settle refuses with
 * 503 — fail closed, the same posture as a missing settler key.
 *
 * Demo auth (H1, 2026-09-23 audit): GET /demo/data triggers REAL onchain
 * settlement via settleExactPayment once FOUR02_DRY_RUN=false, so in that
 * mode it is gated on the same API-key allowlist (fail closed when no keys
 * are configured). In dry-run nothing settles, so the permissionless demo
 * flow is unchanged.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { parseUnits } from 'viem';
import { CHAINS, INK_CONFIG } from './chains.js';
import type { FacilitatorConfig } from './config.js';
import { NonceStore } from './nonces.js';
import { settleExactPayment, settlerAddress } from './settle.js';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SupportedResponse,
} from './types.js';
import { acceptedMatchesRequirements, verifyExactPayment } from './verify.js';
import { createLoungeApp } from '../lounge/server.js';
import { startRektFeed } from '../lounge/rekt.js';
import { LoungeDb } from '../lounge/db.js';
import { createOracleApp, oracleRequirements, PRICE_SYMBOLS } from './oracle.js';
import {
  fetchRelayData,
  isRelayResource,
  relayQuoteTypedData,
  relayRequirements,
  verifyRelayAuth,
} from './relay.js';
import { settlementRow } from './tape.js';
import { createJobsApp } from '../jobs/server.js';
import { createAgentsApp } from '../jobs/agents.js';
import { defaultResolveAgentSeat } from '../jobs/escrow.js';
import { JobsDb } from '../jobs/db.js';
import { startPublisherLoop } from '../jobs/publisher.js';
import type { JobsConfig } from '../jobs/config.js';
import type { BlackjackConfig, LoungeConfig } from '../lounge/config.js';

const b64encode = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString('base64');

function b64decode<T>(s: string): T | null {
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Build the demo's payment requirements from config. */
export function demoRequirements(config: FacilitatorConfig): PaymentRequirements {
  return {
    scheme: 'exact',
    network: INK_CONFIG.caip2,
    asset: INK_CONFIG.usdc.address,
    amount: parseUnits(config.demoPriceUsdc, INK_CONFIG.usdc.decimals).toString(),
    payTo: config.demoPayTo as string,
    maxTimeoutSeconds: 120,
    extra: { name: 'USDC', version: '2' },
  };
}

// ---- HTTP hardening (L3) ---------------------------------------------------

/** JSON body cap: x402 payloads are a few KB; anything bigger is abuse. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface RateLimitBucket {
  /** Window length in ms. */
  windowMs: number;
  /** Max requests per window, per client IP. */
  max: number;
}

export interface ServerOptions {
  rateLimits?: {
    /** Applied to every route. Default: 600 req/min per IP. */
    global?: RateLimitBucket;
    /** Extra-strict bucket for /settle (it can spend operator gas). Default: 30 req/min per IP. */
    settle?: RateLimitBucket;
  };
  maxBodyBytes?: number;
  /**
   * Mount the 402 Lounge (agent social feed) at /lounge when provided.
   * The lounge is opt-in: the CLI enables it only when LOUNGE_TREASURY is
   * set, and loadLoungeConfig() fails closed with a clear error otherwise.
   */
  lounge?: LoungeConfig;
  /**
   * The Count (agent blackjack) config. Mounted at /lounge/blackjack when
   * set; null/undefined disables the game. Requires lounge (residency gate).
   */
  blackjack?: BlackjackConfig | null;
  /**
   * The 402 Job Marketplace (paid work for agents). Mounted at /jobs when
   * set; null/undefined disables the board. The escrow contract is
   * undeployed, so in practice this is unset until the founder deploys it.
   */
  jobs?: JobsConfig | null;
  /**
   * Override the fetch implementation used by /relay/execute to fetch the
   * paid resource data. Production uses global fetch; tests inject a stub.
   */
  relayFetchFn?: typeof fetch;
}

const DEFAULT_GLOBAL_LIMIT: RateLimitBucket = { windowMs: 60_000, max: 600 };
const DEFAULT_SETTLE_LIMIT: RateLimitBucket = { windowMs: 60_000, max: 30 };

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * Minimal in-memory fixed-window rate limiter, per client IP.
 * v0: per-process only (same caveat as NonceStore) — fine behind a single
 * instance; put a real limiter at the edge for multi-instance deploys.
 */
export function rateLimit(bucket: RateLimitBucket) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c: Context, next: Next) => {
    const nowMs = Date.now();
    const ip = clientIp(c);
    let entry = hits.get(ip);
    if (!entry || nowMs >= entry.resetAt) {
      entry = { count: 0, resetAt: nowMs + bucket.windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    // Opportunistic cleanup so the map can't grow unbounded.
    if (hits.size > 10_000 && Math.random() < 0.01) {
      for (const [k, v] of hits) if (v.resetAt <= nowMs) hits.delete(k);
    }
    if (entry.count > bucket.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
      return c.json(
        { error: 'rate_limited', detail: `slow down; retry in ~${retryAfter}s` },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    await next();
  };
}

// ---- /settle auth (M1) -----------------------------------------------------

/**
 * Extract the caller's API key: the `x-api-key` header, an
 * `Authorization: Bearer <key>` header, or the `api_key` query param.
 * Exported for the oracle routes' production gate.
 */
export function settleApiKey(
  getHeader: (name: string) => string | undefined,
  getQuery: (name: string) => string | undefined,
): string | null {
  const header = getHeader('x-api-key');
  if (header?.trim()) return header.trim();
  const auth = getHeader('authorization');
  if (auth) {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const query = getQuery('api_key');
  if (query?.trim()) return query.trim();
  return null;
}

/**
 * Constant-time allowlist check. Length mismatch short-circuits safely
 * (timingSafeEqual throws on unequal lengths). Exported for the oracle
 * routes' production gate.
 */
export function apiKeyAllowed(provided: string | null, allowlist: string[]): boolean {
  if (provided === null) return false;
  const p = Buffer.from(provided, 'utf8');
  return allowlist.some((k) => {
    const kb = Buffer.from(k, 'utf8');
    return kb.length === p.length && timingSafeEqual(kb, p);
  });
}

export function createApp(
  config: FacilitatorConfig,
  store: NonceStore = new NonceStore(),
  opts: ServerOptions = {},
): Hono {
  const app = new Hono();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // The 402 site and other browser clients call this API cross-origin.
  // Writes stay signature-gated; CORS only lets browsers read/post.
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

  // L3: rate limits — strictest on /settle, which can spend operator gas.
  app.use(rateLimit(opts.rateLimits?.global ?? DEFAULT_GLOBAL_LIMIT));
  app.use('/settle', rateLimit(opts.rateLimits?.settle ?? DEFAULT_SETTLE_LIMIT));
  // /relay/execute can spend operator gas — same strict bucket as /settle.
  app.use('/relay/execute', rateLimit(opts.rateLimits?.settle ?? DEFAULT_SETTLE_LIMIT));

  app.get('/health', (c) =>
    c.json({ ok: true, dryRun: config.dryRun, time: Date.now() }),
  );

  // The 402 Lounge (agent social feed) rides on the same service.
  // The lounge DB is opened here and shared: the oracle routes log every
  // served query into it for the command map's spectacle feed.
  let loungeDb: LoungeDb | null = null;
  if (opts.lounge) {
    loungeDb = new LoungeDb(opts.lounge.dbPath);
    app.route(
      '/lounge',
      createLoungeApp(opts.lounge, {
        blackjack: opts.blackjack ?? null,
        db: loungeDb,
      }),
    );
    // The Rekt ticker: read-only Nado liquidation spectator feed. Fail-soft —
    // it must never take the server down.
    try {
      startRektFeed(loungeDb);
    } catch (err) {
      console.error('[rekt] failed to start feed:', (err as Error).message);
    }
  }

  // 402 Oracles: pay-per-call data feeds. Mounted whenever the recipient
  // is configured; without FOUR02_ORACLE_PAYTO the routes fail closed.
  app.route(
    '/oracle',
    createOracleApp(config, {
      store,
      onQueryServed: (q) =>
        loungeDb?.logOracleQuery({
          payer: q.payer,
          endpoint: q.endpoint,
          symbol: q.symbol,
          priceUsd: q.priceUsd,
          createdAt: Math.floor(Date.now() / 1000),
        }),
      // The Tape: every real oracle settlement lands in the public log.
      onSettled: (req, res, resource) => {
        const row = settlementRow(req, res, resource);
        if (row) loungeDb?.logSettlement(row);
      },
      productionGate: (getHeader) => {
        if (config.settleApiKeys.length === 0) return 'not_configured';
        // Note: query-param keys aren't available here (GET routes read
        // them per-route); header + bearer only.
        const key = settleApiKey(getHeader, () => undefined);
        return apiKeyAllowed(key, config.settleApiKeys)
          ? 'ok'
          : 'unauthorized';
      },
    }),
  );

  // 402 Job Marketplace: paid work for agents. Mounted whenever the
  // BountyEscrow address is configured; unset = the board is disabled.
  // Board events feed the lounge's job-activity spectacle feed when the
  // lounge is enabled (same posture as the oracle routes).
  if (opts.jobs) {
    const jobsDb = new JobsDb(opts.jobs.dbPath);
    // Deliverable publisher: settled-only publication of job deliverables
    // to the per-category public repos (+ IPFS mirror). Runs only when
    // both credentials are configured; otherwise settled jobs simply wait
    // (spec §10). Tokens come from env, never code.
    const publisherToken = (process.env.PUBLISHER_GITHUB_TOKEN ?? '').trim();
    const pinataJwt = (process.env.PINATA_JWT ?? '').trim();
    if (publisherToken && pinataJwt) {
      startPublisherLoop({
        db: jobsDb,
        githubToken: publisherToken,
        pinataJwt,
        log: (m) => console.log(`[publisher] ${m}`),
      });
    } else {
      const missing = [
        !publisherToken && 'PUBLISHER_GITHUB_TOKEN',
        !pinataJwt && 'PINATA_JWT',
      ]
        .filter(Boolean)
        .join(', ');
      console.warn(
        `[publisher] disabled — missing env: ${missing} (settled jobs will not be published)`,
      );
    }
    app.route(
      '/jobs',
      createJobsApp(opts.jobs, {
        db: jobsDb,
        onActivity: (a) =>
          loungeDb?.logJobActivity({
            kind: a.kind,
            jobId: a.jobId,
            actor: a.actor,
            title: a.title,
            bountyUsdc: a.bountyUsdc,
            createdAt: Math.floor(Date.now() / 1000),
          }),
      }),
    );
    // The Agents tab: public directory of enrolled workers with live
    // status. Rides on the jobs DB; mounted only when the board is on.
    // Seat token ids resolve live from the onchain registry when
    // FOUR02_TRACES_SEAT is configured (same gating as the seat gate);
    // otherwise every agent reports seatTokenId: null.
    app.route(
      '/agents',
      createAgentsApp(jobsDb, {
        resolveSeat: opts.jobs.seatsContract
          ? defaultResolveAgentSeat(opts.jobs.rpcUrl, opts.jobs.seatsContract)
          : null,
      }),
    );
  }

  app.get('/supported', (c) => {
    const kinds = Object.values(CHAINS).map((ch) => ({
      x402Version: 2,
      scheme: 'exact',
      network: ch.caip2,
    }));
    const res: SupportedResponse = { kinds, extensions: [] };
    const signer = settlerAddress(config.settlerKey);
    if (signer) {
      res.signers = {};
      for (const ch of Object.values(CHAINS)) res.signers[ch.caip2] = [signer];
    }
    return c.json(res);
  });

  type X402Body =
    | {
        ok: true;
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      }
    | { ok: false; reason: 'invalid_request' | 'body_too_large' };

  async function readX402Body(c: Context): Promise<X402Body> {
    let text: string;
    try {
      text = await c.req.text();
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    // L3: cap body size before parsing.
    if (text.length > maxBodyBytes) {
      return { ok: false, reason: 'body_too_large' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    const body = parsed as {
      paymentPayload?: PaymentPayload;
      paymentRequirements?: PaymentRequirements;
    };
    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return { ok: false, reason: 'invalid_request' };
    }
    return {
      ok: true,
      paymentPayload: body.paymentPayload,
      paymentRequirements: body.paymentRequirements,
    };
  }

  app.post('/verify', async (c) => {
    const body = await readX402Body(c);
    if (!body.ok) {
      if (body.reason === 'body_too_large') {
        return c.json({ isValid: false, invalidReason: 'body_too_large' }, 413);
      }
      return c.json({ isValid: false, invalidReason: 'invalid_request' }, 400);
    }
    // H1: /verify is a read-only check — it must NOT consume the nonce.
    // Consuming here made the standard x402 verify -> settle flow impossible
    // (every settle failed with nonce_replay).
    const result = await verifyExactPayment(body, { store, markUsed: false });
    return c.json(result);
  });

  app.post('/settle', async (c) => {
    // M1: /settle spends operator gas — gate on the API-key allowlist.
    // Fail closed: with FOUR02_SETTLE_API_KEYS unset, settle is refused
    // outright (503), the same posture as a missing settler key. The L3
    // per-IP rate limiter remains the second layer.
    if (config.settleApiKeys.length === 0) {
      return c.json(
        { success: false, errorReason: 'settle_auth_not_configured' },
        503,
      );
    }
    if (
      !apiKeyAllowed(
        settleApiKey(
          (n) => c.req.header(n),
          (n) => c.req.query(n),
        ),
        config.settleApiKeys,
      )
    ) {
      return c.json({ success: false, errorReason: 'unauthorized' }, 401);
    }
    const body = await readX402Body(c);
    if (!body.ok) {
      if (body.reason === 'body_too_large') {
        return c.json({ success: false, errorReason: 'body_too_large' }, 413);
      }
      return c.json({ success: false, errorReason: 'invalid_request' }, 400);
    }
    const result = await settleExactPayment(body, {
      store,
      settlerKey: config.settlerKey,
      dryRun: config.dryRun,
    });
    // The Tape: log real broadcasts (dry-runs report success:false, so the
    // helper's null check keeps them out automatically).
    if (result.success) {
      const row = settlementRow(
        body,
        result,
        body.paymentPayload?.resource?.url ?? 'settle',
      );
      if (row) loungeDb?.logSettlement(row);
    }
    // H2 (2026-09-23 audit): a duplicate arriving while an identical
    // settlement is in flight is a client conflict, not a server error.
    const status =
      result.errorReason === 'missing_settler_key'
        ? 503
        : result.errorReason === 'duplicate_settlement'
          ? 409
          : 200;
    return c.json(result, status as 200);
  });

  // ---- The Tape: public visual log of every real settlement ----
  app.get('/settlements', (c) => {
    const raw = c.req.query('limit');
    const parsed = parseInt(raw ?? '50', 10);
    const limit = Math.min(200, Math.max(1, Number.isSafeInteger(parsed) ? parsed : 50));
    return c.json({ settlements: loungeDb?.recentSettlements(limit) ?? [] });
  });

  // ---- Settlement relay: agents pay without the operator API key ----
  //
  // The agent proves its wallet with EIP-712 RelayAuth (see relay.ts); the
  // server attaches its own key-equivalent internally. No API key crosses
  // the wire, and the human is never in the loop. The agent may only relay
  // payments where it is the payer.
  async function readRelayBody(c: Context): Promise<{ ok: true; json: any } | { ok: false; reason: string }> {
    let text: string;
    try {
      text = await c.req.text();
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    if (text.length > maxBodyBytes) return { ok: false, reason: 'body_too_large' };
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
  }

  /** Canonical relay params. Agents must sign this exact JSON string. */
  function canonicalRelayParams(
    resource: 'oracle-price' | 'oracle-gas' | 'demo-data',
    params: unknown,
  ): { ok: true; params: Record<string, unknown>; json: string } | { ok: false; reason: string } {
    if (resource === 'oracle-price') {
      const symbol = String((params as any)?.symbol ?? '').toUpperCase();
      if (!(PRICE_SYMBOLS as readonly string[]).includes(symbol)) {
        return { ok: false, reason: 'invalid_symbol' };
      }
      const canonical = { symbol };
      return { ok: true, params: canonical, json: JSON.stringify(canonical) };
    }
    return { ok: true, params: {}, json: '{}' };
  }

  function relayResourceAvailable(
    resource: 'oracle-price' | 'oracle-gas' | 'demo-data',
  ): { ok: true } | { ok: false; error: string; detail: string } {
    if (resource === 'demo-data') {
      if (!config.demoPayTo) {
        return { ok: false, error: 'demo_not_configured', detail: 'Set FOUR02_DEMO_PAYTO to enable the demo.' };
      }
      return { ok: true };
    }
    if (!config.oraclePayTo) {
      return { ok: false, error: 'oracle_not_configured', detail: 'Set FOUR02_ORACLE_PAYTO to enable oracles.' };
    }
    return { ok: true };
  }

  function relayLabel(resource: 'oracle-price' | 'oracle-gas' | 'demo-data', params: Record<string, unknown>): string {
    return resource === 'oracle-price' ? `oracle-price:${String(params.symbol ?? '')}` : resource;
  }

  app.post('/relay/quote', async (c) => {
    const parsed = await readRelayBody(c);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    const body = parsed.json;
    if (!isRelayResource(body?.resource)) {
      return c.json({ error: 'invalid_resource', detail: 'resource must be oracle-price, oracle-gas, or demo-data.' }, 400);
    }
    const resource = body.resource;
    const canon = canonicalRelayParams(resource, body?.params);
    if (!canon.ok) return c.json({ error: canon.reason }, 400);
    const auth = await verifyRelayAuth({
      agent: body?.agent,
      action: 'relay-quote',
      resource,
      params: canon.json,
      timestamp: body?.timestamp,
      signature: body?.signature,
    });
    if (!auth.ok) {
      return c.json({ error: 'relay_unauthorized', reason: auth.reason }, 401);
    }
    const available = relayResourceAvailable(resource);
    if (!available.ok) return c.json({ error: available.error, detail: available.detail }, 503);
    const requirements = relayRequirements(config, resource, canon.params, oracleRequirements, demoRequirements);
    const typedData = relayQuoteTypedData(requirements, auth.agent);
    if (!typedData) return c.json({ error: 'quote_failed' }, 500);
    return c.json({ requirements, typedData });
  });

  app.post('/relay/execute', async (c) => {
    const parsed = await readRelayBody(c);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    const body = parsed.json;
    const paymentPayload = body?.paymentPayload as PaymentPayload | undefined;
    if (!paymentPayload || !isRelayResource(body?.resource)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const resource = body.resource;
    const canon = canonicalRelayParams(resource, body?.params);
    if (!canon.ok) return c.json({ error: canon.reason }, 400);
    const auth = await verifyRelayAuth({
      agent: body?.agent,
      action: 'relay-execute',
      resource,
      params: canon.json,
      timestamp: body?.timestamp,
      signature: body?.signature,
    });
    if (!auth.ok) {
      return c.json({ error: 'relay_unauthorized', reason: auth.reason }, 401);
    }
    const available = relayResourceAvailable(resource);
    if (!available.ok) return c.json({ error: available.error, detail: available.detail }, 503);
    // Canonical requirements, rebuilt server-side — the client never supplies them.
    const requirements = relayRequirements(config, resource, canon.params, oracleRequirements, demoRequirements);
    if (!acceptedMatchesRequirements(paymentPayload.accepted, requirements)) {
      return c.json({ error: 'requirements_mismatch' }, 402);
    }
    // The agent may only relay its own payments.
    let payer: string;
    try {
      payer = paymentPayload.payload.authorization.from;
      if (payer.toLowerCase() !== auth.agent.toLowerCase()) {
        return c.json({ error: 'payer_mismatch', detail: 'The relay agent must be the payment payer.' }, 403);
      }
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Fetch the paid data BEFORE settlement: if the upstream feed is down we
    // 503 here and no money moves. The agent pays for data — the response
    // must return it, not just the settlement receipt.
    let served;
    try {
      served = await fetchRelayData(resource, canon.params, opts.relayFetchFn);
    } catch {
      return c.json(
        {
          error: 'relay_upstream_unavailable',
          detail: 'The data feed is down; no payment was taken.',
        },
        503,
      );
    }
    const result = await settleExactPayment(
      { paymentPayload, paymentRequirements: requirements },
      { store, settlerKey: config.settlerKey, dryRun: config.dryRun },
    );
    if (result.success) {
      const row = settlementRow(
        { paymentPayload, paymentRequirements: requirements },
        result,
        relayLabel(resource, canon.params),
      );
      if (row) loungeDb?.logSettlement(row);
      // Keep the command map's oracle-activity feed consistent with the
      // x402-gated oracle routes.
      if (served.queryLog) {
        loungeDb?.logOracleQuery({
          payer,
          endpoint: served.queryLog.endpoint,
          symbol: served.queryLog.symbol,
          priceUsd: served.queryLog.priceUsd,
          createdAt: Math.floor(Date.now() / 1000),
        });
      }
    }
    const status =
      result.errorReason === 'missing_settler_key'
        ? 503
        : result.errorReason === 'duplicate_settlement'
          ? 409
          : 200;
    return c.json({ ...result, data: served.data }, status as 200);
  });

  // ---- Demo paid endpoint: the full x402 loop in one route ----
  app.get('/demo/data', async (c) => {
    if (!config.demoPayTo) {
      return c.json(
        {
          error: 'demo_not_configured',
          detail: 'Set FOUR02_DEMO_PAYTO to the recipient address to enable the demo.',
        },
        500,
      );
    }
    // H1 (2026-09-23 audit): with dry-run OFF this route calls
    // settleExactPayment below, which broadcasts a REAL onchain transfer.
    // An unauthenticated caller must never be able to cause that, so in
    // production mode the demo requires the same API key as /settle and
    // fails closed when no keys are configured. Checked BEFORE the 402
    // challenge so nobody burns effort signing for a request we'd refuse.
    // In dry-run mode nothing settles, so the permissionless demo flow is
    // unchanged.
    if (!config.dryRun) {
      if (config.settleApiKeys.length === 0) {
        return c.json(
          {
            error: 'demo_auth_not_configured',
            detail:
              'Set FOUR02_SETTLE_API_KEYS to enable the demo with live settlement.',
          },
          503,
        );
      }
      if (
      !apiKeyAllowed(
        settleApiKey(
          (n) => c.req.header(n),
          (n) => c.req.query(n),
        ),
        config.settleApiKeys,
      )
    ) {
        return c.json(
          {
            error: 'unauthorized',
            detail: 'This demo endpoint requires an API key when dry-run is off.',
          },
          401,
        );
      }
    }
    const requirements = demoRequirements(config);
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: {
        url: '/demo/data',
        description: `402 demo dataset (${config.demoPriceUsdc} USDC)`,
        mimeType: 'application/json',
      },
      accepts: [requirements],
    };
    const challenge = (): Response =>
      new Response(
        JSON.stringify({
          x402: paymentRequired,
          error: 'payment_required',
        }),
        {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': b64encode(paymentRequired),
          },
        },
      );

    const sigHeader = c.req.header('PAYMENT-SIGNATURE');
    if (!sigHeader) return challenge();
    const paymentPayload = b64decode<PaymentPayload>(sigHeader);
    if (!paymentPayload) return challenge();

    // L1/H1: the demo GRANTS data on verification, so the nonce must be
    // consumed here — in dry-run there is no later settle to do it, and
    // without this one signature buys unlimited accesses. In production
    // mode we do NOT consume: settleExactPayment below consumes the nonce
    // after a successful broadcast.
    const verified = await verifyExactPayment(
      { paymentPayload, paymentRequirements: requirements },
      { store, markUsed: config.dryRun },
    );
    if (!verified.isValid) {
      return new Response(
        JSON.stringify({
          x402: paymentRequired,
          error: 'payment_required',
          invalidReason: verified.invalidReason,
        }),
        {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': b64encode(paymentRequired),
          },
        },
      );
    }

    const data = {
      message: 'welcome to the agent economy',
      dataset: {
        invoices_settled: 1337,
        volume_usdc: '420.69',
        note: 'If you are reading this, an agent paid for it. No API key. No account. Just 402.',
      },
      dryRun: config.dryRun,
    };

    if (config.dryRun) {
      // Local-testing mode: crypto verified, nothing settles. Say so plainly.
      const dryResp = {
        success: false,
        dryRun: true,
        errorReason: 'dry_run_mode',
        network: requirements.network,
        payer: verified.payer,
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-RESPONSE': b64encode(dryResp),
        },
      });
    }

    const settled = await settleExactPayment(
      { paymentPayload, paymentRequirements: requirements },
      { store, settlerKey: config.settlerKey, dryRun: false },
    );
    if (!settled.success) {
      const status = settled.errorReason === 'missing_settler_key' ? 503 : 402;
      return c.json(
        { error: 'settlement_failed', errorReason: settled.errorReason },
        status as 402,
      );
    }
    // The Tape: log the real broadcast.
    const demoRow = settlementRow(
      { paymentPayload, paymentRequirements: requirements },
      settled,
      'demo-data',
    );
    if (demoRow) loungeDb?.logSettlement(demoRow);
    return new Response(JSON.stringify({ ...data, dryRun: false }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-RESPONSE': b64encode(settled),
      },
    });
  });

  return app;
}
