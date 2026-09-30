/**
 * 402 Job Marketplace — agent avatar snapshots.
 *
 * When a holder pairs an agent with a TRACES seat NFT (the seat gate's
 * onchain agentToSeat pairing), we snapshot the seat's artwork and use it
 * as the agent's canonical face (Agents tab, Ledger agent chips). Latest
 * face wins: re-pairing overwrites the stored snapshot.
 *
 * The whole flow is fail-soft: any failure (RPC down, bad metadata,
 * oversized or non-image bytes) logs a one-line warning and returns null —
 * enrollment continues with no avatar. Image bytes are never logged.
 */
import { createPublicClient, http, type Address } from 'viem';
import { ink } from '../constants.js';

export interface AvatarSnapshot {
  bytes: Buffer;
  contentType: string;
}

/** (seatTokenId) => snapshot, or null when the snapshot could not be taken. */
export type SnapshotSeatAvatar = (
  seatTokenId: bigint,
) => Promise<AvatarSnapshot | null>;

const TOKEN_URI_ABI = [
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

/** IPFS gateway used when tokenURI/image are ipfs:// URIs. Overridable. */
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const METADATA_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 10_000;
/** Hard cap on fetched artwork bytes (TRACES SVGs are a few KB). */
export const MAX_AVATAR_BYTES = 1_000_000;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function ensureTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Resolve an ipfs:// (or plain https://) URI to a fetchable gateway URL.
 * Returns null for anything else — we never fetch arbitrary schemes.
 */
export function ipfsToGateway(
  uri: string,
  gatewayBase: string,
): string | null {
  const base = ensureTrailingSlash(gatewayBase);
  if (uri.startsWith('ipfs://')) {
    const rest = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
    if (!rest) return null;
    return base + rest;
  }
  if (uri.startsWith('https://') || uri.startsWith('http://')) return uri;
  return null;
}

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  ms: number,
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Stream the body with a hard byte cap. Returns null when the body exceeds
 * the cap (the stream is cancelled) or has no readable body.
 */
async function readCapped(
  res: Response,
  cap: number,
): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Accept content-type image/* at face value; otherwise accept only bodies
 * that sniff like SVG (some gateways mislabel). Anything else is rejected.
 */
function sniffContentType(
  header: string | null,
  bytes: Buffer,
): string | null {
  const h = (header ?? '').split(';')[0].trim().toLowerCase();
  if (h.startsWith('image/')) return h;
  const head = bytes
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  // Tolerate an XML prolog or leading comments before the <svg> tag.
  if (head.includes('<svg')) return 'image/svg+xml';
  return null;
}

export interface SnapshotAvatarOpts {
  rpcUrl: string;
  seatContract: Address;
  gatewayBase?: string;
  /** Test seam: replaces the live tokenURI read. */
  readTokenUri?: (seatTokenId: bigint) => Promise<string>;
  /** Test seam: replaces global fetch. */
  fetchImpl?: FetchImpl;
}

/**
 * Build the seat-artwork snapshotter. In production it reads tokenURI live
 * from the TRACES seat contract on Ink and fetches through the IPFS
 * gateway; tests inject readTokenUri/fetchImpl and never touch the network.
 */
export function defaultSnapshotSeatAvatar(
  opts: SnapshotAvatarOpts,
): SnapshotSeatAvatar {
  const gatewayBase = ensureTrailingSlash(
    opts.gatewayBase ?? DEFAULT_IPFS_GATEWAY,
  );
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const readTokenUri =
    opts.readTokenUri ??
    (async (seatTokenId: bigint): Promise<string> => {
      const client = createPublicClient({
        chain: ink,
        transport: http(opts.rpcUrl),
      });
      return client.readContract({
        address: opts.seatContract,
        abi: TOKEN_URI_ABI,
        functionName: 'tokenURI',
        args: [seatTokenId],
      });
    });

  return async (seatTokenId: bigint): Promise<AvatarSnapshot | null> => {
    try {
      const tokenUri = await readTokenUri(seatTokenId);
      const metaUrl = ipfsToGateway(tokenUri, gatewayBase);
      if (!metaUrl) {
        console.warn(
          `[jobs] avatar snapshot: seat ${seatTokenId} tokenURI is not a fetchable URI`,
        );
        return null;
      }
      const metaRes = await fetchWithTimeout(
        fetchImpl,
        metaUrl,
        METADATA_TIMEOUT_MS,
      );
      if (!metaRes.ok) {
        console.warn(
          `[jobs] avatar snapshot: metadata fetch failed for seat ${seatTokenId} (HTTP ${metaRes.status})`,
        );
        return null;
      }
      let image: unknown;
      try {
        const meta = (await metaRes.json()) as { image?: unknown };
        image = meta?.image;
      } catch {
        console.warn(
          `[jobs] avatar snapshot: metadata is not JSON for seat ${seatTokenId}`,
        );
        return null;
      }
      if (typeof image !== 'string') {
        console.warn(
          `[jobs] avatar snapshot: metadata has no image field for seat ${seatTokenId}`,
        );
        return null;
      }
      const imageUrl = ipfsToGateway(image, gatewayBase);
      if (!imageUrl) {
        console.warn(
          `[jobs] avatar snapshot: seat ${seatTokenId} image is not a fetchable URI`,
        );
        return null;
      }
      const imgRes = await fetchWithTimeout(
        fetchImpl,
        imageUrl,
        IMAGE_TIMEOUT_MS,
      );
      if (!imgRes.ok) {
        console.warn(
          `[jobs] avatar snapshot: image fetch failed for seat ${seatTokenId} (HTTP ${imgRes.status})`,
        );
        return null;
      }
      const declared = imgRes.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_AVATAR_BYTES) {
        console.warn(
          `[jobs] avatar snapshot: seat ${seatTokenId} image exceeds the ${MAX_AVATAR_BYTES}-byte cap (declared ${declared})`,
        );
        return null;
      }
      const bytes = await readCapped(imgRes, MAX_AVATAR_BYTES);
      if (!bytes) {
        console.warn(
          `[jobs] avatar snapshot: seat ${seatTokenId} image exceeds the ${MAX_AVATAR_BYTES}-byte cap`,
        );
        return null;
      }
      const contentType = sniffContentType(
        imgRes.headers.get('content-type'),
        bytes,
      );
      if (!contentType) {
        console.warn(
          `[jobs] avatar snapshot: seat ${seatTokenId} image is not a recognized image`,
        );
        return null;
      }
      return { bytes, contentType };
    } catch (e) {
      // Fail-soft by design: enrollment continues with no avatar.
      console.warn(
        `[jobs] avatar snapshot failed for seat ${seatTokenId}: ${
          e instanceof Error ? e.message : 'unknown error'
        }`,
      );
      return null;
    }
  };
}
