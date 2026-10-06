/**
 * Foundry public stats — derived from onchain truth, not local state.
 *
 * Every successful Foundry launch pays exactly FOUNDRY_FEE_ETH (default
 * 0.001 ETH) to the Foundry fee treasury. Counting those payments on the
 * Ink explorer is the true launch count, and the latest payment's sender
 * identifies the latest launch's creator on Hookit's launch board.
 *
 * Read-only. No keys, no signing. Cached 5 minutes in the HTTP layer.
 */

export interface FeePayment {
  hash: string;
  from: string;
  timestamp: string; // ISO-8601 from the explorer
}

export interface LatestLaunch {
  /** 1-based launch number (== total launch count). */
  n: number;
  name: string;
  ticker: string;
  url: string;
}

export interface FoundryStats {
  launches: number;
  feePerLaunchEth: string;
  feesCollectedEth: string;
  latest: LatestLaunch | null;
}

const DEFAULT_TREASURY = '0xaa4e163da1545f6967d284c0c5cfa469c644ed23';
const BLOCKSCOUT_V2 = 'https://explorer.inkonchain.com/api/v2';
const MAX_PAGES = 200;

export function foundryFeeRecipient(): string {
  return (process.env.FOUNDRY_FEE_RECIPIENT ?? '').trim() || DEFAULT_TREASURY;
}

export function foundryFeeEth(): string {
  return (process.env.FOUNDRY_FEE_ETH ?? '').trim() || '0.001';
}

/** ETH decimal string -> wei decimal string (exact for fee magnitudes). */
export function feeEthToWei(feeEth: string): string {
  return BigInt(Math.round(parseFloat(feeEth) * 1e18)).toString();
}

/**
 * All exact-fee payments into the treasury, oldest first. Follows Blockscout
 * pagination. Throws on upstream failure (the HTTP layer maps it to 502).
 */
export async function fetchFeePayments(
  fetchFn: typeof fetch,
): Promise<FeePayment[]> {
  const treasury = foundryFeeRecipient().toLowerCase();
  const feeWei = feeEthToWei(foundryFeeEth());
  const out: FeePayment[] = [];
  let params = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchFn(
      `${BLOCKSCOUT_V2}/addresses/${treasury}/transactions?filter=to${params}`,
    );
    if (!res.ok) throw new Error(`blockscout txs: HTTP ${res.status}`);
    const body = (await res.json()) as {
      items?: Array<{
        hash?: string;
        from?: { hash?: string };
        to?: { hash?: string };
        value?: string;
        timestamp?: string;
      }>;
      next_page_params?: Record<string, string | number> | null;
    };
    for (const tx of body.items ?? []) {
      const to = String(tx?.to?.hash ?? '').toLowerCase();
      if (to === treasury && String(tx?.value) === feeWei) {
        out.push({
          hash: String(tx.hash),
          from: String(tx.from?.hash ?? ''),
          timestamp: String(tx.timestamp ?? ''),
        });
      }
    }
    const np = body.next_page_params;
    if (!np || typeof np !== 'object') break;
    params =
      '&' +
      Object.keys(np)
        .map(
          (k) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(np[k]))}`,
        )
        .join('&');
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return out;
}

interface HookitPool {
  creator?: string;
  contractAddress?: string;
  name?: string;
  ticker?: string;
  launchedAt?: number;
}

/** The creator's most recently launched pool, or null. */
export async function fetchLatestPoolForCreator(
  fetchFn: typeof fetch,
  hookitApiUrl: string,
  creator: string,
): Promise<HookitPool | null> {
  const res = await fetchFn(
    `${hookitApiUrl.replace(/\/$/, '')}/api/launches?limit=25`,
  );
  if (!res.ok) throw new Error(`hookit launches: HTTP ${res.status}`);
  const body = (await res.json()) as { pools?: HookitPool[] };
  const want = creator.toLowerCase();
  let best: HookitPool | null = null;
  for (const p of body.pools ?? []) {
    if (String(p?.creator ?? '').toLowerCase() !== want) continue;
    if (!best || Number(p.launchedAt ?? 0) > Number(best.launchedAt ?? 0)) {
      best = p;
    }
  }
  return best;
}

export async function getFoundryStats(
  fetchFn: typeof fetch,
  hookitApiUrl: string,
): Promise<FoundryStats> {
  const feeEth = foundryFeeEth();
  const payments = await fetchFeePayments(fetchFn);
  const launches = payments.length;
  const feesCollectedEth = (launches * parseFloat(feeEth)).toFixed(3);
  let latest: LatestLaunch | null = null;
  if (payments.length > 0) {
    const last = payments[payments.length - 1];
    const pool = await fetchLatestPoolForCreator(fetchFn, hookitApiUrl, last.from);
    if (pool?.contractAddress) {
      latest = {
        n: launches,
        name: String(pool.name ?? ''),
        ticker: String(pool.ticker ?? ''),
        url: `https://www.hookit.fun/token/${pool.contractAddress}`,
      };
    }
  }
  return { launches, feePerLaunchEth: feeEth, feesCollectedEth, latest };
}
