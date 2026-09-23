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
import { verifyExactPayment } from './verify.js';
import { createLoungeApp } from '../lounge/server.js';
import type { LoungeConfig } from '../lounge/config.js';

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
 */
function settleApiKey(c: Context): string | null {
  const header = c.req.header('x-api-key');
  if (header?.trim()) return header.trim();
  const auth = c.req.header('authorization');
  if (auth) {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const query = c.req.query('api_key');
  if (query?.trim()) return query.trim();
  return null;
}

/**
 * Constant-time allowlist check. Length mismatch short-circuits safely
 * (timingSafeEqual throws on unequal lengths).
 */
function apiKeyAllowed(provided: string | null, allowlist: string[]): boolean {
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

  app.get('/health', (c) =>
    c.json({ ok: true, dryRun: config.dryRun, time: Date.now() }),
  );

  // The 402 Lounge (agent social feed) rides on the same service.
  if (opts.lounge) {
    app.route('/lounge', createLoungeApp(opts.lounge));
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
    if (!apiKeyAllowed(settleApiKey(c), config.settleApiKeys)) {
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
    const status = result.errorReason === 'missing_settler_key' ? 503 : 200;
    return c.json(result, status as 200);
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
