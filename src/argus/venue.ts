/**
 * Argus venue adapter — Nado PUBLIC read-only endpoints.
 *
 * PAPER ONLY: this module performs public market-data reads and nothing else.
 * No keys, no signing, no broadcasts, no write endpoints. The Nado indexer
 * query shape (POST {url}/v1 with {"<type>": {params}}) was reverse-engineered
 * from @nadohq/indexer-client 0.52.0 and verified live 2026-10-02.
 */
import type { Candle, MarketSnapshot } from './types.js';

export const ARGUS_PAIRS_URL_DEFAULT =
  'https://api.prod.nado.xyz/gateway/v2/pairs';
export const ARGUS_INDEXER_URL_DEFAULT = 'https://api.prod.nado.xyz/archive';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Nado x18 fixed-point (string) -> float. Prices/funding are plain post-division. */
export function fromX18(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n / 1e18;
}

/**
 * product_id -> display ticker (e.g. 2 -> 'BTC-PERP').
 * NOTE: on this API perps have EVEN ids (2 = BTC-PERP), spot odd —
 * don't assume the reverse; always resolve through this map.
 */
export async function fetchProductMap(
  pairsUrl: string,
): Promise<Map<number, string>> {
  const res = await fetch(pairsUrl, {
    headers: { 'Accept-Encoding': 'gzip, deflate, br' },
  });
  if (!res.ok) throw new Error(`pairs fetch failed: ${res.status}`);
  const body = (await res.json()) as unknown;
  const map = new Map<number, string>();
  if (Array.isArray(body)) {
    for (const p of body) {
      if (!isRecord(p)) continue;
      const id = num(p.product_id);
      const base = typeof p.base === 'string' ? p.base.trim() : '';
      if (id !== null && Number.isInteger(id) && base) map.set(id, base);
    }
  }
  return map;
}

async function indexerQuery<T>(
  indexerUrl: string,
  type: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${indexerUrl}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [type]: params }),
  });
  if (!res.ok) throw new Error(`indexer query ${type} failed: ${res.status}`);
  return (await res.json()) as T;
}

function parseCandle(raw: unknown): Candle | null {
  if (!isRecord(raw)) return null;
  const time = num(raw.timestamp);
  const open = fromX18(raw.open_x18);
  const high = fromX18(raw.high_x18);
  const low = fromX18(raw.low_x18);
  const close = fromX18(raw.close_x18);
  const volume = num(raw.volume);
  if (
    time === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    time <= 0 ||
    close <= 0
  )
    return null;
  return { time, open, high, low, close, volume };
}

/**
 * Historical OHLCV candles, oldest-first. granularity is seconds per candle
 * (14400 = 4h, 86400 = 1d). Verified live against the Nado indexer.
 */
export async function fetchCandles(
  indexerUrl: string,
  productId: number,
  granularity: number,
  limit: number,
): Promise<Candle[]> {
  const body = await indexerQuery<{ candlesticks?: unknown[] }>(
    indexerUrl,
    'candlesticks',
    { product_id: productId, limit, granularity },
  );
  const out: Candle[] = [];
  if (Array.isArray(body.candlesticks)) {
    for (const c of body.candlesticks) {
      const parsed = parseCandle(c);
      if (parsed) out.push(parsed);
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Latest mark/index prices + funding rates for the universe. */
export async function fetchMarketSnapshot(
  indexerUrl: string,
  productIds: number[],
): Promise<Map<number, MarketSnapshot>> {
  const [pricesBody, fundingBody] = await Promise.all([
    indexerQuery<Record<string, unknown>>(indexerUrl, 'perp_prices', {
      product_ids: productIds,
    }),
    indexerQuery<Record<string, unknown>>(indexerUrl, 'funding_rates', {
      product_ids: productIds,
    }),
  ]);
  const out = new Map<number, MarketSnapshot>();
  for (const pid of productIds) {
    const p = pricesBody[String(pid)];
    const f = fundingBody[String(pid)];
    if (!isRecord(p) || !isRecord(f)) continue;
    const markPrice = fromX18(p.mark_price_x18);
    const indexPrice = fromX18(p.index_price_x18);
    const fundingRate = fromX18(f.funding_rate_x18);
    if (markPrice === null || markPrice <= 0) continue;
    out.set(pid, {
      productId: pid,
      ticker: '',
      markPrice,
      indexPrice: indexPrice ?? markPrice,
      fundingRate: fundingRate ?? 0,
    });
  }
  return out;
}
