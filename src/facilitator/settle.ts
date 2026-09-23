/**
 * 402 Phase 2 — /settle core for the `exact` scheme on EVM.
 *
 * Submits the payer-signed EIP-3009 authorization via
 * USDC.transferWithAuthorization, moving funds payer -> recipient directly.
 * The facilitator never custodies funds; the settler key only pays gas.
 *
 * Safety rules:
 *  - No settler key (FOUR02_SETTLER_KEY) -> refuse, always.
 *  - Dry-run mode (FOUR02_DRY_RUN, default true) -> simulate via eth_call,
 *    never broadcast.
 *  - The nonce is marked consumed only after a broadcast is confirmed or a
 *    dry-run simulation passes; a failed simulation leaves the nonce free so
 *    the payer can fund and retry.
 *  - In-flight dedupe (H2): concurrent duplicates of the same settlement
 *    are rejected with `duplicate_settlement` while one is processing, so
 *    exactly one broadcast happens per unique authorization.
 */
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFromCaip2 } from './chains.js';
import {
  splitSignature,
  usdcEip3009Abi,
  viemChain,
} from './eip3009.js';
import { NonceStore } from './nonces.js';
import { verifyExactPayment } from './verify.js';
import type { SettleRequest, SettleResponse } from './types.js';

export interface SettleOptions {
  store: NonceStore;
  /** Settler private key. Absent -> settle is refused outright. */
  settlerKey?: Hex;
  /** True -> simulate only, never broadcast. */
  dryRun: boolean;
  nowSec?: number;
  /** Override the chain's default RPC. */
  rpcUrl?: string;
}

function isValidSettlerKey(k: unknown): k is Hex {
  return typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k);
}

// ---- H2 (2026-09-23 audit): duplicate-settlement guard ----------------------
//
// Concurrent duplicate /settle requests could both pass the nonce check and
// double-broadcast: one transaction reverts but the operator still pays gas
// (worst case: the payee gets paid twice). The per-request `store.has`
// check is not enough because two requests can interleave between the check
// and the broadcast.
//
// Track in-flight settlements by a stable key — network + EIP-3009 nonce,
// which is unique per payer authorization — and reject duplicates with
// `duplicate_settlement` (mapped to HTTP 409 by the route) while one is
// processing. Exactly one broadcast per unique settlement. The entry is
// removed in a finally block so a crashed/failed settlement never wedges
// the key forever. Same-process only (same caveat as NonceStore); the
// onchain authorizationState check remains the backstop across processes.
const inFlightSettlements = new Map<string, Promise<SettleResponse>>();

/**
 * Stable dedupe key for a settlement request, or null when the request is
 * too malformed to key (falls through to normal validation errors).
 */
export function settlementDedupeKey(req: SettleRequest): string | null {
  try {
    const network = req?.paymentRequirements?.network;
    const nonce = req?.paymentPayload?.payload?.authorization?.nonce;
    if (typeof network !== 'string' || typeof nonce !== 'string' || !nonce) {
      return null;
    }
    return `${network.toLowerCase()}:${nonce.toLowerCase()}`;
  } catch {
    return null;
  }
}

export async function settleExactPayment(
  req: SettleRequest,
  opts: SettleOptions,
): Promise<SettleResponse> {
  const key = settlementDedupeKey(req);
  if (!key) return settleInner(req, opts);
  const existing = inFlightSettlements.get(key);
  if (existing) {
    return {
      success: false,
      errorReason: 'duplicate_settlement',
      network: req.paymentRequirements.network,
      detail:
        'An identical settlement is already being processed. Wait for it instead of resubmitting.',
    };
  }
  // Registered synchronously, before any await: a concurrent duplicate that
  // arrives while this one is in flight is guaranteed to see the entry.
  const p = settleInner(req, opts);
  inFlightSettlements.set(key, p);
  try {
    return await p;
  } finally {
    if (inFlightSettlements.get(key) === p) inFlightSettlements.delete(key);
  }
}

async function settleInner(
  req: SettleRequest,
  opts: SettleOptions,
): Promise<SettleResponse> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  if (!isValidSettlerKey(opts.settlerKey)) {
    return {
      success: false,
      errorReason: 'missing_settler_key',
      detail:
        'No settler key configured. Set FOUR02_SETTLER_KEY (founder-held) to enable settlement.',
    };
  }

  // Full verification first, without consuming the nonce yet.
  const verified = await verifyExactPayment(req, {
    store: opts.store,
    markUsed: false,
    nowSec,
  });
  const network = req?.paymentRequirements?.network;
  if (!verified.isValid) {
    return {
      success: false,
      errorReason: verified.invalidReason,
      network,
      payer: verified.payer,
    };
  }

  const cfg = chainFromCaip2(network);
  if (!cfg) {
    return { success: false, errorReason: 'invalid_network', network };
  }
  if (opts.store.has(cfg.chainId, req.paymentPayload.payload.authorization.nonce, nowSec)) {
    return {
      success: false,
      errorReason: 'nonce_replay',
      network: cfg.caip2,
      payer: verified.payer,
    };
  }

  const auth = req.paymentPayload.payload.authorization;
  const from = getAddress(auth.from);
  const to = getAddress(auth.to);
  const value = BigInt(auth.value);
  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  const nonce = auth.nonce as Hex;
  const { v, r, s } = splitSignature(req.paymentPayload.payload.signature as Hex);

  const chain = viemChain(cfg);
  const rpcUrl = opts.rpcUrl ?? cfg.rpcUrl;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const settler = privateKeyToAccount(opts.settlerKey);

  // Belt-and-braces: the chain itself tracks consumed EIP-3009 nonces.
  let alreadyUsed = false;
  try {
    alreadyUsed = (await publicClient.readContract({
      address: cfg.usdc.address,
      abi: usdcEip3009Abi,
      functionName: 'authorizationState',
      args: [from, nonce],
    })) as boolean;
  } catch (e) {
    return {
      success: false,
      errorReason: 'settlement_failed',
      network: cfg.caip2,
      payer: from,
      detail: `authorizationState check failed: ${(e as Error).message}`,
    };
  }
  if (alreadyUsed) {
    return {
      success: false,
      errorReason: 'authorization_already_used',
      network: cfg.caip2,
      payer: from,
    };
  }

  const args = [from, to, value, validAfter, validBefore, nonce, v, r, s] as const;

  if (opts.dryRun) {
    // Simulate the settlement without broadcasting. Never touches writeContract.
    try {
      await publicClient.simulateContract({
        address: cfg.usdc.address,
        abi: usdcEip3009Abi,
        functionName: 'transferWithAuthorization',
        args,
        account: settler.address,
      });
    } catch (e) {
      return {
        success: false,
        dryRun: true,
        errorReason: 'dry_run_mode',
        network: cfg.caip2,
        payer: from,
        detail: `simulation reverted (nothing broadcast): ${(e as Error).message?.slice(0, 300)}`,
      };
    }
    opts.store.mark(cfg.chainId, nonce, Number(validBefore));
    return {
      success: false,
      dryRun: true,
      errorReason: 'dry_run_mode',
      network: cfg.caip2,
      payer: from,
      detail:
        'simulation passed; nothing was broadcast (FOUR02_DRY_RUN=true). Set FOUR02_DRY_RUN=false with a funded settler key to settle for real.',
    };
  }

  // Real settlement: check the payer can cover it, then broadcast.
  const balance = (await publicClient.readContract({
    address: cfg.usdc.address,
    abi: usdcEip3009Abi,
    functionName: 'balanceOf',
    args: [from],
  })) as bigint;
  if (balance < value) {
    return {
      success: false,
      errorReason: 'insufficient_funds',
      network: cfg.caip2,
      payer: from,
    };
  }

  try {
    const walletClient = createWalletClient({
      account: settler,
      chain,
      transport: http(rpcUrl),
    });
    const hash = await walletClient.writeContract({
      address: cfg.usdc.address,
      abi: usdcEip3009Abi,
      functionName: 'transferWithAuthorization',
      args,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    opts.store.mark(cfg.chainId, nonce, Number(validBefore));
    return {
      success: true,
      transaction: hash,
      network: cfg.caip2,
      payer: from,
    };
  } catch (e) {
    return {
      success: false,
      errorReason: 'settlement_failed',
      network: cfg.caip2,
      payer: from,
      detail: (e as Error).message?.slice(0, 500),
    };
  }
}

/** Settler address for /supported's `signers`, or null when no key is set. */
export function settlerAddress(settlerKey?: Hex): Address | null {
  if (!isValidSettlerKey(settlerKey)) return null;
  return privateKeyToAccount(settlerKey).address;
}
