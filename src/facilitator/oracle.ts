/**
 * 402 Oracles v0 — pay-per-call data feeds for agents.
 *
 *   GET /oracle/price?symbol=ETH  -> x402-gated token price in USD
 *   GET /oracle/gas               -> x402-gated Ink gas price
 *
 * Payment flow mirrors GET /demo/data exactly: 402 challenge without a
 * PAYMENT-SIGNATURE, verifyExactPayment with the signature, then serve.
 * In dry-run the signature is verified and the data served (nonce consumed
 * at verify time — one signature buys one query); in production the payment
 * is settled onchain before the data is served, behind the same API-key
 * gate as /settle.
 *
 * Every served query fires onQueryServed so the Lounge can log it for the
 * command map's Oracle Row spectacle feed.
 */
import { Hono } from 'hono';
import { parseUnits } from 'viem';
import { INK_CONFIG } from './chains.js';
import type { FacilitatorConfig } from './config.js';
import { NonceStore } from './nonces.js';
import { settleExactPayment } from './settle.js';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from './types.js';
import { verifyExactPayment } from './verify.js';

/** v0 price allowlist — anything else is a 400. */
export const PRICE_SYMBOLS = ['ETH', 'BTC', 'USDC'] as const;
export type PriceSymbol = (typeof PRICE_SYMBOLS)[number];

/** Upstream price cache TTL: keep responses fast and the free API happy. */
export const PRICE_CACHE_TTL_MS = 30_000;

const b64encode = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString('base64');

function b64decode<T>(s: string): T | null {
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Build this oracle's payment requirements from config. */
export function oracleRequirements(
  config: FacilitatorConfig,
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: INK_CONFIG.caip2,
    asset: INK_CONFIG.usdc.address,
    amount: parseUnits(
      config.oraclePriceUsdc,
      INK_CONFIG.usdc.decimals,
    ).toString(),
    payTo: config.oraclePayTo as string,
    maxTimeoutSeconds: 120,
    extra: { name: 'USDC', version: '2' },
  };
}

export interface OracleQuery {
  payer: string;
  endpoint: 'price' | 'gas';
  symbol?: string;
  priceUsd?: string;
}

export interface OracleDeps {
  store?: NonceStore;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Fired after every served query (the spectacle feed). */
  onQueryServed?: (q: OracleQuery) => void;
  /**
   * API-key gate for production mode (dry-run off), same posture as
   * /demo/data: fail closed without keys, 401 without a valid key.
   * Receives a header getter for the current request.
   */
  productionGate?: (
    getHeader: (name: string) => string | undefined,
  ) => 'ok' | 'not_configured' | 'unauthorized';
}

// ---- data sources ---------------------------------------------------------

interface PriceCacheEntry {
  priceUsd: string;
  asOf: number;
  stale: boolean;
}

const priceCache = new Map<string, PriceCacheEntry>();

interface DexPair {
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/**
 * Best-liquidity USD price for a symbol from DexScreener (free, no key).
 * Throws on upstream failure or unparseable data.
 */
export async function fetchPriceUsd(
  symbol: PriceSymbol,
  fetchFn: typeof fetch = fetch,
): Promise<{ priceUsd: string; asOf: number }> {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`;
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`dexscreener_http_${res.status}`);
  const data = (await res.json()) as { pairs?: DexPair[] };
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];
  let best: DexPair | null = null;
  let bestLiq = -1;
  for (const p of pairs) {
    if (!p.priceUsd) continue;
    const liq = p.liquidity?.usd ?? 0;
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p;
    }
  }
  if (!best?.priceUsd) throw new Error('no_priced_pair');
  return { priceUsd: best.priceUsd, asOf: Date.now() };
}

/** Cached wrapper: fresh cache hit, or fetch; stale cache served on failure. */
export async function getPriceUsd(
  symbol: PriceSymbol,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<{ priceUsd: string; asOf: number; stale: boolean }> {
  const cached = priceCache.get(symbol);
  if (cached && nowMs - cached.asOf < PRICE_CACHE_TTL_MS) {
    return { priceUsd: cached.priceUsd, asOf: cached.asOf, stale: false };
  }
  try {
    const fresh = await fetchPriceUsd(symbol, fetchFn);
    priceCache.set(symbol, { priceUsd: fresh.priceUsd, asOf: fresh.asOf, stale: false });
    return { ...fresh, stale: false };
  } catch (e) {
    if (cached) {
      return { priceUsd: cached.priceUsd, asOf: cached.asOf, stale: true };
    }
    throw e;
  }
}

/** For tests: clear the in-memory price cache. */
export function clearPriceCache(): void {
  priceCache.clear();
}

/** Ink gas price via eth_gasPrice on the configured RPC. */
export async function fetchGasPriceWei(
  fetchFn: typeof fetch = fetch,
): Promise<{ gasPriceWei: string; asOf: number }> {
  const res = await fetchFn(INK_CONFIG.rpcUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_gasPrice',
      params: [],
    }),
  });
  if (!res.ok) throw new Error(`rpc_http_${res.status}`);
  const data = (await res.json()) as { result?: string; error?: unknown };
  if (typeof data.result !== 'string' || data.error) {
    throw new Error('rpc_bad_response');
  }
  return { gasPriceWei: BigInt(data.result).toString(10), asOf: Date.now() };
}

// ---- the x402-gated app ----------------------------------------------------

export function createOracleApp(
  config: FacilitatorConfig,
  deps: OracleDeps = {},
): Hono {
  const app = new Hono();
  const store = deps.store ?? new NonceStore();
  const fetchFn = deps.fetchFn ?? fetch;

  if (!config.oraclePayTo) {
    app.use('*', async (c) =>
      c.json(
        {
          error: 'oracle_not_configured',
          detail:
            'Set FOUR02_ORACLE_PAYTO to the USDC recipient to enable oracles.',
        },
        500,
      ),
    );
    return app;
  }

  const requirements = oracleRequirements(config);

  const challenge = (resource: { url: string; description: string }): Response => {
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { ...resource, mimeType: 'application/json' },
      accepts: [requirements],
    };
    return new Response(
      JSON.stringify({ x402: paymentRequired, error: 'payment_required' }),
      {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': b64encode(paymentRequired),
        },
      },
    );
  };

  const invalidChallenge = (
    resource: { url: string; description: string },
    invalidReason: string,
  ): Response => {
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { ...resource, mimeType: 'application/json' },
      accepts: [requirements],
    };
    return new Response(
      JSON.stringify({
        x402: paymentRequired,
        error: 'payment_required',
        invalidReason,
      }),
      {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': b64encode(paymentRequired),
        },
      },
    );
  };

  /**
   * Shared paid-query pipeline: challenge → verify → fetch data → serve.
   * `serve` produces the data payload (or throws → 503). The query is
   * logged via onQueryServed only after the data is successfully served.
   */
  async function paidQuery(
    c: {
      req: { header(name: string): string | undefined };
      json(o: unknown, status?: number): Response;
    },
    resource: { url: string; description: string },
    serve: () => Promise<{ data: Record<string, unknown>; log: OracleQuery }>,
  ): Promise<Response> {
    // Production gate BEFORE the challenge: never let an unauthenticated
    // caller burn effort signing for a request we'd refuse to settle.
    if (!config.dryRun) {
      const gate = deps.productionGate
        ? deps.productionGate((n) => c.req.header(n))
        : 'not_configured';
      if (gate === 'not_configured') {
        return c.json(
          {
            error: 'oracle_auth_not_configured',
            detail:
              'Set FOUR02_SETTLE_API_KEYS to enable oracles with live settlement.',
          },
          503,
        );
      }
      if (gate === 'unauthorized') {
        return c.json(
          {
            error: 'unauthorized',
            detail: 'Oracles require an API key when dry-run is off.',
          },
          401,
        );
      }
    }

    const sigHeader = c.req.header('PAYMENT-SIGNATURE');
    if (!sigHeader) return challenge(resource);
    const paymentPayload = b64decode<PaymentPayload>(sigHeader);
    if (!paymentPayload) return challenge(resource);

    // Same nonce posture as /demo/data: data is granted at verify time, so
    // in dry-run the nonce is consumed here; in production the settle below
    // consumes it after a successful broadcast.
    const verified = await verifyExactPayment(
      { paymentPayload, paymentRequirements: requirements },
      { store, markUsed: config.dryRun },
    );
    if (!verified.isValid) {
      return invalidChallenge(resource, verified.invalidReason ?? 'invalid');
    }

    let served: { data: Record<string, unknown>; log: OracleQuery };
    try {
      served = await serve();
    } catch {
      return c.json({ error: 'oracle_upstream_unavailable' }, 503);
    }

    const payer = verified.payer ?? 'unknown';
    deps.onQueryServed?.({ ...served.log, payer });

    if (config.dryRun) {
      return new Response(JSON.stringify(served.data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-RESPONSE': b64encode({
            success: false,
            dryRun: true,
            errorReason: 'dry_run_mode',
            network: requirements.network,
            payer,
          }),
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
    return new Response(
      JSON.stringify({ ...served.data, dryRun: false }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-RESPONSE': b64encode(settled),
        },
      },
    );
  }

  app.get('/price', async (c) => {
    const raw = (c.req.query('symbol') ?? '').toUpperCase();
    if (!(PRICE_SYMBOLS as readonly string[]).includes(raw)) {
      return c.json(
        {
          error: 'unsupported_symbol',
          detail: `symbol must be one of: ${PRICE_SYMBOLS.join(', ')}`,
        },
        400,
      );
    }
    const symbol = raw as PriceSymbol;
    return paidQuery(
      c,
      {
        url: `/oracle/price?symbol=${symbol}`,
        description: `402 oracle: ${symbol} price (${config.oraclePriceUsdc} USDC)`,
      },
      async () => {
        const q = await getPriceUsd(symbol, fetchFn);
        return {
          data: {
            symbol,
            price_usd: q.priceUsd,
            stale: q.stale,
            as_of: new Date(q.asOf).toISOString(),
          },
          log: { endpoint: 'price', symbol, priceUsd: q.priceUsd } as OracleQuery,
        };
      },
    );
  });

  app.get('/gas', (c) =>
    paidQuery(
      c,
      {
        url: '/oracle/gas',
        description: `402 oracle: Ink gas price (${config.oraclePriceUsdc} USDC)`,
      },
      async () => {
        const g = await fetchGasPriceWei(fetchFn);
        return {
          data: {
            chain_id: INK_CONFIG.chainId,
            gas_price_wei: g.gasPriceWei,
            as_of: new Date(g.asOf).toISOString(),
          },
          log: { endpoint: 'gas' } as OracleQuery,
        };
      },
    ),
  );

  return app;
}
