/**
 * 402 Lounge — the Rekt ticker.
 *
 * Read-only spectator feed: subscribes to Nado's public liquidation
 * WebSocket (no keys, no writes, no payments), stores the big liquidations
 * in the lounge DB, and serves them at GET /lounge/rekt. Pure spectacle:
 * people stare at liquidations the way they stare at slot machines.
 */
import WebSocket from 'ws';
import type { LoungeDb } from './db.js';

export const REKT_WS_URL_DEFAULT = 'wss://gateway.prod.nado.xyz/v1/subscribe';
export const REKT_PAIRS_URL_DEFAULT = 'https://api.prod.nado.xyz/gateway/v2/pairs';

/**
 * A validated liquidation event. ticker is null until the caller fills it
 * in from the product map.
 */
export interface RektEvent {
  productId: number;
  ticker: string | null;
  /** The side that got liquidated: 'long' = a long was rekt. */
  side: 'long' | 'short';
  price: number;
  /** Signed base size; |amount| * price = notional USD. */
  amount: number;
  notionalUsd: number;
  /** Unix seconds. */
  ts: number;
  liquidatee: string;
}

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

/**
 * Validate a raw liquidation message off the Nado /subscribe stream.
 *
 * Wire shape: {type:'liquidation', product_id, timestamp (string, millis),
 * product_ids (may be [spotId, perpId] for spreads — ignored, the top-level
 * product_id wins), amount (signed string; >0 = long rekt, <0 = short rekt),
 * price, liquidator, liquidatee}.
 *
 * Returns null for anything malformed or economically empty.
 */
export function parseLiquidationEvent(raw: unknown): RektEvent | null {
  if (!isRecord(raw) || raw.type !== 'liquidation') return null;
  const productId = num(raw.product_id);
  const tsMs = num(raw.timestamp);
  const amount = num(raw.amount);
  const price = num(raw.price);
  const liquidatee =
    typeof raw.liquidatee === 'string' ? raw.liquidatee.trim() : '';
  if (productId === null || !Number.isInteger(productId) || productId <= 0)
    return null;
  if (tsMs === null || tsMs <= 0) return null;
  if (amount === null || amount === 0) return null;
  if (price === null || price <= 0) return null;
  if (!liquidatee) return null;
  return {
    productId,
    ticker: null,
    side: amount > 0 ? 'long' : 'short',
    price,
    amount,
    notionalUsd: Math.abs(amount) * price,
    ts: Math.floor(tsMs / 1000),
    liquidatee,
  };
}

/** Notional filter: only liquidations at or above the floor make the ticker. */
export function passesNotionalThreshold(
  e: RektEvent,
  minNotionalUsd: number,
): boolean {
  return e.notionalUsd >= minNotionalUsd;
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

/** Dedup key: same product + second + wallet + size = same event. */
export function rektEventKey(e: RektEvent): string {
  return `${e.productId}:${e.ts}:${e.liquidatee}:${e.amount}`;
}

/** Bounded recent-key set for WS dedup (reconnects can replay events). */
export class RecentKeys {
  private keys = new Map<string, number>();
  constructor(private max = 5000) {}
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(key: string): void {
    this.keys.delete(key);
    this.keys.set(key, Date.now());
    if (this.keys.size > this.max) {
      const oldest = this.keys.keys().next();
      if (!oldest.done) this.keys.delete(oldest.value);
    }
  }
  get size(): number {
    return this.keys.size;
  }
}

export interface RektSubscriberOpts {
  wsUrl: string;
  onEvent: (e: RektEvent) => void;
  log?: (msg: string) => void;
}

/**
 * Maintains a subscription to Nado's public liquidation stream with
 * auto-reconnect (exponential backoff, capped ~60s). Never throws out of
 * the reconnect loop — it logs and retries forever.
 */
export class RektSubscriber {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private seen = new RecentKeys();
  private msgId = 1;

  constructor(private opts: RektSubscriberOpts) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private log(msg: string): void {
    this.opts.log?.(`[rekt] ${msg}`);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl, {
        headers: {
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': '402-rekt-ticker/1',
        },
        perMessageDeflate: true,
        handshakeTimeout: 15000,
      });
    } catch (err) {
      this.log(`connect threw: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped) return;
      this.backoffMs = 1000;
      // Don't keep the process alive on our account: in production the HTTP
      // server holds the event loop open; in tests the process must exit.
      const sock = (
        ws as unknown as { _socket?: { unref?: () => void } }
      )._socket;
      try {
        sock?.unref?.();
      } catch {
        /* ignore */
      }
      ws.send(
        JSON.stringify({
          id: this.msgId++,
          method: 'subscribe',
          stream: { type: 'liquidation' },
        }),
      );
      this.log('subscribed to liquidation stream');
      this.pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }, 20_000);
      this.pingTimer.unref?.();
    });

    ws.on('message', (data) => {
      if (this.stopped) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const e = parseLiquidationEvent(msg);
      if (!e) return;
      const key = rektEventKey(e);
      if (this.seen.has(key)) return;
      this.seen.add(key);
      try {
        this.opts.onEvent(e);
      } catch (err) {
        this.log(`onEvent threw: ${(err as Error).message}`);
      }
    });

    const dead = (why: string) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!this.stopped) {
        this.log(`socket ${why}; reconnecting`);
        this.scheduleReconnect();
      }
    };
    ws.on('close', (code) => dead(`closed (${code})`));
    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const wait = Math.min(this.backoffMs, 60_000);
    const jitter = Math.floor(Math.random() * 1000);
    this.log(`reconnect in ${wait + jitter}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      this.connect();
    }, wait + jitter);
    this.reconnectTimer.unref?.();
  }
}

export interface RektFeedOpts {
  wsUrl?: string;
  pairsUrl?: string;
  minNotionalUsd?: number;
  log?: (msg: string) => void;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/**
 * Start the rekt feed: hourly product-map refresh + liquidation subscriber.
 * Big liquidations go into the lounge DB; rows older than 7 days are pruned
 * on insert. Fail-soft by design: every async edge is caught and logged,
 * so the ticker can never crash the server. Returns stop().
 */
export function startRektFeed(
  db: LoungeDb,
  opts: RektFeedOpts = {},
): () => void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const noop = () => {};
  if ((env('REKT_ENABLED') ?? '1') === '0') {
    log('[rekt] disabled via REKT_ENABLED=0');
    return noop;
  }
  const wsUrl = opts.wsUrl ?? env('REKT_WS_URL') ?? REKT_WS_URL_DEFAULT;
  const pairsUrl =
    opts.pairsUrl ?? env('REKT_PAIRS_URL') ?? REKT_PAIRS_URL_DEFAULT;
  const minNotional = opts.minNotionalUsd ?? Number(env('REKT_MIN_NOTIONAL_USD') ?? '10000');
  const floor =
    Number.isFinite(minNotional) && minNotional > 0 ? minNotional : 10000;

  let productMap = new Map<number, string>();
  let stopped = false;

  const refreshMap = async () => {
    try {
      const m = await fetchProductMap(pairsUrl);
      if (m.size > 0) {
        productMap = m;
        log(`[rekt] product map: ${m.size} products`);
      }
    } catch (err) {
      log(`[rekt] product map refresh failed: ${(err as Error).message}`);
    }
  };
  void refreshMap();
  const mapTimer = setInterval(() => {
    if (!stopped) void refreshMap();
  }, 3_600_000);
  mapTimer.unref?.();

  const sub = new RektSubscriber({
    wsUrl,
    log,
    onEvent: (e) => {
      if (stopped) return;
      if (!passesNotionalThreshold(e, floor)) return;
      try {
        db.insertRektEvent({
          productId: e.productId,
          ticker: productMap.get(e.productId) ?? null,
          side: e.side,
          price: e.price,
          amount: e.amount,
          notionalUsd: e.notionalUsd,
          liquidatee: e.liquidatee,
          ts: e.ts,
        });
      } catch (err) {
        log(`[rekt] insert failed: ${(err as Error).message}`);
      }
    },
  });
  sub.start();
  log(`[rekt] feed started (min notional $${floor.toLocaleString('en-US')})`);

  return () => {
    stopped = true;
    clearInterval(mapTimer);
    sub.stop();
    log('[rekt] feed stopped');
  };
}
