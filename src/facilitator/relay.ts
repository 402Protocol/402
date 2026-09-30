/**
 * 402 settlement relay — agents pay for pay-per-call resources WITHOUT the
 * operator API key ever crossing the wire.
 *
 * Two calls:
 *   POST /relay/quote   { resource, params, agent, timestamp, signature }
 *     -> { requirements, typedData } — the EIP-712 TransferWithAuthorization
 *        for the agent to sign with its own payer key.
 *   POST /relay/execute { paymentPayload, agent, timestamp, signature }
 *     -> settles via the server's own settler key and returns the result.
 *
 * Auth is EIP-712 `RelayAuth` over the "402 Lounge" domain (see
 * lounge/signing.ts): the agent proves its wallet, the server attaches its
 * own API-key-equivalent internally. The agent may only relay payments where
 * it is the payer, and every settlement still requires the agent to sign
 * away its own USDC first — griefing the relay costs the attacker their own
 * money, which is the real rate limit. A per-IP bucket (the settle bucket)
 * is the second layer.
 */
import {
  type Address,
  type Hex,
  getAddress,
  recoverTypedDataAddress,
} from 'viem';
import { chainFromCaip2, INK_CONFIG } from './chains.js';
import type { FacilitatorConfig } from './config.js';
import { eip3009Domain, EIP3009_TYPES, randomNonce } from './eip3009.js';
import {
  fetchGasPriceWei,
  getPriceUsd,
  type PriceSymbol,
} from './oracle.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES, timestampFresh } from '../lounge/signing.js';
import type { PaymentRequirements } from './types.js';

/** Pay-per-call resources the relay can quote. */
export const RELAY_RESOURCES = ['oracle-price', 'oracle-gas', 'demo-data'] as const;
export type RelayResource = (typeof RELAY_RESOURCES)[number];

export function isRelayResource(r: unknown): r is RelayResource {
  return typeof r === 'string' && (RELAY_RESOURCES as readonly string[]).includes(r);
}

export interface RelayAuthInput {
  agent: string;
  action: 'relay-quote' | 'relay-execute';
  resource: string;
  params: string;
  timestamp: string;
  signature: Hex;
}

export type RelayAuthResult = { ok: true; agent: Address } | { ok: false; reason: string };

/** Verify the agent's RelayAuth signature. Proves who is asking, nothing more. */
export async function verifyRelayAuth(
  input: RelayAuthInput,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<RelayAuthResult> {
  const { agent, action, resource, params, timestamp, signature } = input ?? {};
  if (!agent || !action || !resource || params === undefined || !timestamp || !signature) {
    return { ok: false, reason: 'missing_auth_fields' };
  }
  if (action !== 'relay-quote' && action !== 'relay-execute') {
    return { ok: false, reason: 'invalid_action' };
  }
  let agentAddr: Address;
  try {
    agentAddr = getAddress(agent);
  } catch {
    return { ok: false, reason: 'invalid_agent' };
  }
  let ts: bigint;
  try {
    ts = BigInt(timestamp);
  } catch {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (!timestampFresh(ts, nowSec)) return { ok: false, reason: 'stale_timestamp' };
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: LOUNGE_DOMAIN,
      types: LOUNGE_TYPES,
      primaryType: 'RelayAuth',
      message: {
        agent: agentAddr,
        action,
        resource,
        params,
        timestamp: ts,
      },
      signature,
    });
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (recovered.toLowerCase() !== agentAddr.toLowerCase()) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, agent: agentAddr };
}

/**
 * Canonical payment requirements for a relay resource. The server rebuilds
 * these itself — the client never supplies them.
 */
export function relayRequirements(
  config: FacilitatorConfig,
  resource: RelayResource,
  params: Record<string, unknown>,
  oracleRequirements: (config: FacilitatorConfig) => PaymentRequirements,
  demoRequirements: (config: FacilitatorConfig) => PaymentRequirements,
): PaymentRequirements {
  void params;
  if (resource === 'demo-data') return demoRequirements(config);
  return oracleRequirements(config);
}

/** EIP-712 typed data for the agent to sign (TransferWithAuthorization). */
export function relayQuoteTypedData(
  requirements: PaymentRequirements,
  agent: Address,
  nowSec: number = Math.floor(Date.now() / 1000),
): {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: typeof EIP3009_TYPES;
  primaryType: 'TransferWithAuthorization';
  message: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
} | null {
  const cfg = chainFromCaip2(requirements.network) ?? INK_CONFIG;
  let to: Address;
  let value: bigint;
  try {
    to = getAddress(requirements.payTo);
    value = BigInt(requirements.amount);
    if (value <= 0n) return null;
  } catch {
    return null;
  }
  const validAfter = BigInt(nowSec - 60);
  const validBefore = BigInt(nowSec + (requirements.maxTimeoutSeconds || 120));
  return {
    domain: eip3009Domain(cfg),
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(agent),
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: randomNonce(),
    },
  };
}

/**
 * The data payload a relay resource serves, plus oracle query-log fields.
 * queryLog is null for non-oracle resources (demo-data).
 */
export interface RelayServedData {
  data: Record<string, unknown>;
  queryLog: { endpoint: string; symbol?: string; priceUsd?: string } | null;
}

/**
 * Fetch the actual resource data the agent is paying for. Called by
 * /relay/execute BEFORE settlement: if the upstream feed is down we fail
 * with 503 and no money moves. Throws on upstream failure.
 *
 * Shapes mirror the x402-gated routes (/oracle/price, /oracle/gas,
 * /demo/data) so the relay and the direct endpoints serve identical data.
 */
export async function fetchRelayData(
  resource: RelayResource,
  params: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<RelayServedData> {
  if (resource === 'oracle-price') {
    const symbol = String(params.symbol ?? '').toUpperCase() as PriceSymbol;
    const q = await getPriceUsd(symbol, fetchFn);
    return {
      data: {
        symbol,
        price_usd: q.priceUsd,
        stale: q.stale,
        as_of: new Date(q.asOf).toISOString(),
      },
      queryLog: { endpoint: 'price', symbol, priceUsd: q.priceUsd },
    };
  }
  if (resource === 'oracle-gas') {
    const g = await fetchGasPriceWei(fetchFn);
    return {
      data: {
        chain_id: INK_CONFIG.chainId,
        gas_price_wei: g.gasPriceWei,
        as_of: new Date(g.asOf).toISOString(),
      },
      queryLog: { endpoint: 'gas' },
    };
  }
  return {
    data: {
      message: 'welcome to the agent economy',
      dataset: {
        invoices_settled: 1337,
        volume_usdc: '420.69',
        note: 'If you are reading this, an agent paid for it. No API key. No account. Just 402.',
      },
    },
    queryLog: null,
  };
}
