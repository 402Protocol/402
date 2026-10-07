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
 *  - Success is reported only when the chain confirms the intended payment:
 *    the receipt must have status success AND carry the expected USDC
 *    Transfer event (payer -> recipient, exact value). A reverted receipt is
 *    a failure and the nonce stays unmarked so the payer can retry. A
 *    successful receipt WITHOUT the expected transfer is `unresolved`, not
 *    failed: the authorization is likely consumed, so the hash is preserved
 *    as evidence instead of being discarded.
 *  - Ordering: authenticate + validate the request first (expiry deferred),
 *    then reconcile any saved broadcast — a tx that confirmed before expiry
 *    is still a valid payment after expiry — then enforce expiry before any
 *    new broadcast.
 *  - In-flight dedupe (H2): concurrent duplicates of the same settlement
 *    are rejected with `duplicate_settlement` while one is processing, so
 *    exactly one broadcast happens per unique authorization.
 *  - Timeout recovery (#2): a send intent is persisted BEFORE broadcast and
 *    the tx hash is saved the moment it is broadcast. If confirmation times
 *    out, the next attempt reconciles that transaction onchain before ever
 *    broadcasting again — a tx that confirms after the request timed out is
 *    reported as success, never double-broadcast. If the send outcome is
 *    unknown (crash between broadcast and hash-save), the retry fails
 *    closed until the intended payment can be proven. A consumed onchain
 *    nonce alone cannot prove payment: it may have been cancelled or used
 *    for a different recipient or amount.
 *  - Claim fencing (#3): the in-flight claim carries an ownership token.
 *    Only the holder may release it or write settlement state — a stale
 *    worker that lost its claim stands down instead of broadcasting or
 *    clobbering its replacement's recovery state.
 */
import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFromCaip2 } from './chains.js';
import {
  splitSignature,
  usdcEip3009Abi,
  viemChain,
} from './eip3009.js';
import {
  settlementIdentity,
  settlementKey,
  type SettlementIdentity,
  type SettlementStore,
} from './settlement-store.js';
import { verifyExactPayment } from './verify.js';
import type { SettleRequest, SettleResponse } from './types.js';

/** How long to wait for a broadcast to confirm before reporting a timeout. */
export const SETTLEMENT_CONFIRM_TIMEOUT_MS = 60_000;

/** Minimal receipt shape needed to confirm a settlement. */
export interface SettlementReceipt {
  status: string;
  logs: Array<{ address: string; topics: Hex[]; data: Hex }>;
}

/** Arguments for the EIP-3009 broadcast. */
export interface BroadcastArgs {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * Chain interaction surface for the settlement broadcast path. The default
 * implementation uses viem clients; tests inject a fake. Covers every chain
 * touch after verification, so timeout/reconcile behavior is testable
 * without broadcasting.
 */
export interface SettlementChainIO {
  /** True when the EIP-3009 nonce was already consumed onchain. */
  isAuthorizationUsed(from: Address, nonce: Hex): Promise<boolean>;
  /** Payer's USDC balance. */
  payerBalance(from: Address): Promise<bigint>;
  /** Broadcast transferWithAuthorization. Returns the tx hash. */
  broadcast(args: BroadcastArgs): Promise<Hex>;
  /** Wait for the receipt, throwing WaitForTransactionReceiptTimeoutError after timeoutMs. */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<SettlementReceipt>;
  /** Fetch the receipt, or null when the tx is not mined yet. */
  getReceipt(hash: Hex): Promise<SettlementReceipt | null>;
}

/**
 * Broadcast log: settlement key -> tx hash of the latest broadcast for that
 * settlement. A Map satisfies this interface; fix #3 will back it with
 * durable storage and a richer key. Same-process only, same caveat as
 * NonceStore.
 */
/** Outcome of reconciling a prior broadcast against the chain. */
export type ReconcileOutcome = 'confirmed' | 'failed' | 'pending' | 'unresolved';

export interface SettleOptions {
  store: SettlementStore;
  /** Settler private key. Absent -> settle is refused outright. */
  settlerKey?: Hex;
  /** True -> simulate only, never broadcast. */
  dryRun: boolean;
  nowSec?: number;
  /** Override the chain's default RPC. */
  rpcUrl?: string;
  /** Chain interaction surface. Defaults to viem clients. */
  io?: SettlementChainIO;
}

function isValidSettlerKey(k: unknown): k is Hex {
  return typeof k === 'string' && /^0x[0-9a-fA-F]{64}$/.test(k);
}

// ---- H2 (2026-09-23 audit) + #3: duplicate-settlement guard --------------
//
// Concurrent duplicate /settle requests could both pass the nonce check and
// double-broadcast: one transaction reverts but the operator still pays gas
// (worst case: the payee gets paid twice). The per-request `store.has`
// check is not enough because two requests can interleave between the check
// and the broadcast.
//
// Claim the settlement in the SettlementStore before doing any work and
// reject duplicates with `duplicate_settlement` (mapped to HTTP 409 by the
// route) while one is processing. Exactly one broadcast per unique
// settlement. The claim is released in a finally block; a crashed instance's
// stale claim can be taken over after INFLIGHT_CLAIM_TTL_SEC. Unlike the old
// in-process Map, the claim works across facilitator instances sharing the
// durable store; the onchain authorizationState check remains the backstop.

/**
 * Stable dedupe key for a settlement request, or null when the request is
 * too malformed to key (falls through to normal validation errors).
 * Now derived from the full settlement identity: chain + token + payer + nonce.
 */
export function settlementDedupeKey(req: SettleRequest): string | null {
  const id = settlementIdentity(req);
  return id ? settlementKey(id) : null;
}

/**
 * Confirm the intended payment from the broadcast receipt.
 *
 * Returns true ONLY when the receipt has status success AND carries the
 * expected USDC Transfer event (payer -> recipient, exact value). Any other
 * outcome — reverted receipt, missing logs, a transfer to the wrong
 * recipient, a transfer of the wrong amount, or logs from a different token
 * contract — returns false, so a reverted or unexpected transaction can
 * never be reported as a successful payment.
 */
export function receiptConfirmsPayment(args: {
  receipt: SettlementReceipt;
  usdcAddress: Address;
  from: Address;
  to: Address;
  value: bigint;
}): boolean {
  const { receipt, usdcAddress, from, to, value } = args;
  if (receipt.status !== 'success') return false;
  const wantToken = usdcAddress.toLowerCase();
  const wantFrom = from.toLowerCase();
  const wantTo = to.toLowerCase();
  return receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== wantToken) return false;
    let decoded: { eventName: string; args: Record<string, unknown> };
    try {
      decoded = decodeEventLog({
        abi: usdcEip3009Abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: Record<string, unknown> };
    } catch {
      return false; // Not a decodable USDC event; ignore this log.
    }
    return (
      decoded.eventName === 'Transfer' &&
      String(decoded.args.from).toLowerCase() === wantFrom &&
      String(decoded.args.to).toLowerCase() === wantTo &&
      (decoded.args.value as bigint) === value
    );
  });
}

/**
 * Reconcile a previously broadcast settlement transaction against the chain.
 *  - 'confirmed': the tx is mined and carries the expected USDC transfer.
 *  - 'failed':    the tx reverted — it will never pay, safe to retry.
 *  - 'unresolved': the tx succeeded onchain but carries no matching USDC
 *                 transfer. The authorization is likely consumed: keep the
 *                 hash as evidence, never rebroadcast blind.
 *  - 'pending':   the tx is not mined yet.
 * RPC errors propagate; the caller must not rebroadcast on uncertainty.
 */
export async function reconcileBroadcast(args: {
  io: Pick<SettlementChainIO, 'getReceipt'>;
  hash: Hex;
  usdcAddress: Address;
  from: Address;
  to: Address;
  value: bigint;
}): Promise<ReconcileOutcome> {
  const receipt = await args.io.getReceipt(args.hash);
  if (!receipt) return 'pending';
  if (
    receiptConfirmsPayment({
      receipt,
      usdcAddress: args.usdcAddress,
      from: args.from,
      to: args.to,
      value: args.value,
    })
  ) {
    return 'confirmed';
  }
  return receipt.status === 'success' ? 'unresolved' : 'failed';
}

/** Default SettlementChainIO backed by viem clients. */
export function viemSettlementIO(deps: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: Chain;
  account: Address;
  usdcAddress: Address;
}): SettlementChainIO {
  const { publicClient, walletClient, chain, account, usdcAddress } = deps;
  return {
    isAuthorizationUsed: (from, nonce) =>
      publicClient.readContract({
        address: usdcAddress,
        abi: usdcEip3009Abi,
        functionName: 'authorizationState',
        args: [from, nonce],
      }) as Promise<boolean>,
    payerBalance: (from) =>
      publicClient.readContract({
        address: usdcAddress,
        abi: usdcEip3009Abi,
        functionName: 'balanceOf',
        args: [from],
      }) as Promise<bigint>,
    broadcast: (b) =>
      walletClient.writeContract({
        address: usdcAddress,
        abi: usdcEip3009Abi,
        functionName: 'transferWithAuthorization',
        args: [b.from, b.to, b.value, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s],
        chain,
        account,
      }),
    waitForReceipt: (hash, timeoutMs) =>
      publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs }),
    getReceipt: async (hash) => {
      try {
        return await publicClient.getTransactionReceipt({ hash });
      } catch (e) {
        // Not mined yet — distinct from a real RPC failure.
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
  };
}

export async function settleExactPayment(
  req: SettleRequest,
  opts: SettleOptions,
): Promise<SettleResponse> {
  const id = settlementIdentity(req);
  if (!id) return settleInner(req, opts, null, null);
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  // Durable in-flight claim (#3): taken synchronously, before any await, so
  // a concurrent duplicate — same process or a second instance sharing the
  // store — is guaranteed to see it. The claim carries an ownership token:
  // only the holder may release it or write settlement state, so a stale
  // worker can never clobber its replacement's claim or recovery state.
  const claimToken = opts.store.tryClaimInFlight(id, nowSec);
  if (!claimToken) {
    return {
      success: false,
      errorReason: 'duplicate_settlement',
      network: req.paymentRequirements.network,
      detail:
        'An identical settlement is already being processed. Wait for it instead of resubmitting.',
    };
  }
  try {
    return await settleInner(req, opts, id, claimToken);
  } finally {
    opts.store.releaseInFlight(id, claimToken);
  }
}

async function settleInner(
  req: SettleRequest,
  opts: SettleOptions,
  id: SettlementIdentity | null,
  claimToken: string | null,
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

  // Authenticate and validate the request first, without consuming the nonce
  // yet — but defer the expiry check. A saved broadcast for this
  // authorization may have confirmed before expiry, and that payment is
  // still recoverable after expiry via reconcile below.
  const verified = await verifyExactPayment(req, {
    store: opts.store,
    markUsed: false,
    nowSec,
    skipExpiryCheck: true,
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
  const walletClient = createWalletClient({
    account: settler,
    chain,
    transport: http(rpcUrl),
  });
  const io =
    opts.io ??
    viemSettlementIO({
      publicClient,
      walletClient,
      chain,
      account: settler.address,
      usdcAddress: cfg.usdc.address,
    });
  const payment = { usdcAddress: cfg.usdc.address, from, to, value };

  /**
   * Fencing: when this worker no longer holds the settlement's claim
   * (another worker took it over after it went stale), stand down instead
   * of writing settlement state or broadcasting. Returns a claim_lost
   * response, or null when this worker still holds the claim.
   */
  const assertClaim = (): SettleResponse | null => {
    if (!id || !claimToken) return null; // no claim held (malformed request path)
    if (opts.store.ownsClaim(id, claimToken)) return null;
    return {
      success: false,
      errorReason: 'claim_lost',
      network: cfg.caip2,
      payer: from,
      detail:
        'Another worker took over this settlement; standing down to avoid a duplicate broadcast or clobbered recovery state.',
    };
  };

  // #2: reconcile a prior broadcast BEFORE any new broadcast. A retry that
  // arrives after a timeout must learn what the first transaction did —
  // confirmed (report success), finalized-without-paying (safe to retry),
  // or still pending (wait for it) — instead of broadcasting a duplicate.
  // This runs before the nonce/already-used checks: a tx that confirmed
  // after a timeout consumed the authorization, and the correct answer is
  // success, not `authorization_already_used`.
  if (id) {
    const lost = assertClaim();
    if (lost) return lost;
    const priorHash = opts.store.getBroadcast(id);
    if (priorHash) {
      let outcome: ReconcileOutcome;
      try {
        outcome = await reconcileBroadcast({ io, hash: priorHash, ...payment });
      } catch (e) {
        // Uncertain state: never rebroadcast blind. The operator retries the
        // same authorization once the RPC is healthy.
        return {
          success: false,
          errorReason: 'reconcile_failed',
          transaction: priorHash,
          network: cfg.caip2,
          payer: from,
          detail: `Could not determine the prior broadcast's status; not rebroadcasting to avoid a duplicate. Retry the same authorization. Cause: ${(e as Error).message?.slice(0, 200)}`,
        };
      }
      if (outcome === 'confirmed') {
        opts.store.deleteBroadcast(id);
        if (id) opts.store.mark(id, Number(validBefore));
        return {
          success: true,
          transaction: priorHash,
          network: cfg.caip2,
          payer: from,
        };
      }
      if (outcome === 'pending') {
        // Still in flight: wait for the original tx, don't broadcast a second.
        try {
          const receipt = await io.waitForReceipt(priorHash, SETTLEMENT_CONFIRM_TIMEOUT_MS);
          const lostAfterWait = assertClaim();
          if (lostAfterWait) return lostAfterWait;
          if (receiptConfirmsPayment({ receipt, ...payment })) {
            opts.store.deleteBroadcast(id);
            if (id) opts.store.mark(id, Number(validBefore));
            return {
              success: true,
              transaction: priorHash,
              network: cfg.caip2,
              payer: from,
            };
          }
          if (receipt.status !== 'success') {
            // Reverted while we waited — safe to fall through and retry.
            opts.store.deleteBroadcast(id);
          } else {
            // Successful receipt but no matching USDC transfer: unresolved,
            // not failed. Preserve the hash as evidence; do not rebroadcast.
            return {
              success: false,
              errorReason: 'settlement_unresolved',
              transaction: priorHash,
              network: cfg.caip2,
              payer: from,
              detail:
                'A prior broadcast succeeded onchain but the expected USDC transfer was not found in its receipt. The authorization may be consumed; investigate the transaction before retrying.',
            };
          }
        } catch (e) {
          if (e instanceof WaitForTransactionReceiptTimeoutError) {
            return {
              success: false,
              errorReason: 'settlement_timeout',
              transaction: priorHash,
              network: cfg.caip2,
              payer: from,
              detail:
                'A prior broadcast is still unconfirmed. Resubmit the same authorization to reconcile it; it will not broadcast twice.',
            };
          }
          return {
            success: false,
            errorReason: 'settlement_failed',
            transaction: priorHash,
            network: cfg.caip2,
            payer: from,
            detail: (e as Error).message?.slice(0, 500),
          };
        }
      } else if (outcome === 'unresolved') {
        // The prior tx succeeded onchain but carried no matching USDC
        // transfer. The authorization is likely consumed: keep the hash as
        // evidence and do not rebroadcast.
        return {
          success: false,
          errorReason: 'settlement_unresolved',
          transaction: priorHash,
          network: cfg.caip2,
          payer: from,
          detail:
            'A prior broadcast succeeded onchain but the expected USDC transfer was not found in its receipt. The authorization may be consumed; investigate the transaction before retrying.',
        };
      } else {
        // 'failed': the prior tx is finalized and never paid — safe to retry.
        const lost = assertClaim();
        if (lost) return lost;
        opts.store.deleteBroadcast(id);
      }
    } else if (opts.store.hasBroadcastIntent(id)) {
      // A previous attempt recorded a send intent but never saved a hash:
      // the send outcome is unknown (crash or store failure at the broadcast
      // boundary). authorizationState is shared by transfers and
      // cancellations and binds only payer + nonce, not recipient + amount.
      // Retain the intent regardless of nonce state: without exact payment
      // evidence, never report success or rebroadcast blind.
      return {
        success: false,
        errorReason: 'settlement_unknown',
        network: cfg.caip2,
        payer: from,
        detail:
          'A previous attempt recorded a broadcast intent but no transaction hash (possible crash at the broadcast boundary). Nonce consumption alone cannot prove the expected USDC payment; the authorization may have been cancelled or used for a different payment. Investigate and recover the transaction hash before retrying — this will not rebroadcast.',
      };
    }
  }

  // Expiry is enforced here: after reconcile (a tx that confirmed before
  // expiry is still a valid payment) and before any new broadcast.
  if (BigInt(nowSec) >= validBefore) {
    return {
      success: false,
      errorReason: 'authorization_expired',
      network: cfg.caip2,
      payer: from,
    };
  }
  if (id && opts.store.has(id, nowSec)) {
    return {
      success: false,
      errorReason: 'nonce_replay',
      network: cfg.caip2,
      payer: verified.payer,
    };
  }

  // Belt-and-braces: the chain itself tracks consumed EIP-3009 nonces.
  let alreadyUsed = false;
  try {
    alreadyUsed = await io.isAuthorizationUsed(from, nonce);
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
    const lostDryRun = assertClaim();
    if (lostDryRun) return lostDryRun;
    if (id) opts.store.mark(id, Number(validBefore));
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
  const balance = await io.payerBalance(from);
  if (balance < value) {
    return {
      success: false,
      errorReason: 'insufficient_funds',
      network: cfg.caip2,
      payer: from,
    };
  }

  try {
    const lost = assertClaim();
    if (lost) return lost;
    // Persist the send intent BEFORE submission. If we crash between
    // broadcast and saving the hash, the retry sees the intent without a
    // hash and fails closed instead of double-broadcasting. If the intent
    // itself cannot be persisted, refuse to broadcast without recovery.
    if (id) {
      try {
        opts.store.setBroadcastIntent(id);
      } catch (e) {
        return {
          success: false,
          errorReason: 'store_unavailable',
          network: cfg.caip2,
          payer: from,
          detail: `Cannot persist the send intent; refusing to broadcast without recovery. Cause: ${(e as Error).message?.slice(0, 200)}`,
        };
      }
    }
    const hash = await io.broadcast({
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
      v,
      r,
      s,
    });
    // Save the hash the moment it is broadcast, so a later attempt
    // reconciles this transaction instead of broadcasting a duplicate.
    // If this write fails the hash is still known in memory for this
    // attempt; a future retry fails closed via the surviving intent.
    if (id) {
      try {
        opts.store.setBroadcast(id, hash);
        opts.store.deleteBroadcastIntent(id);
      } catch {
        // proceed with the in-memory hash
      }
    }
    let receipt: SettlementReceipt;
    try {
      receipt = await io.waitForReceipt(hash, SETTLEMENT_CONFIRM_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof WaitForTransactionReceiptTimeoutError) {
        // The hash stays in the store: the next attempt reconciles it.
        return {
          success: false,
          errorReason: 'settlement_timeout',
          transaction: hash,
          network: cfg.caip2,
          payer: from,
          detail:
            'Broadcast succeeded but confirmation timed out. Resubmit the same authorization to reconcile; it will not broadcast twice.',
        };
      }
      throw e;
    }
    const lostAfterWait = assertClaim();
    if (lostAfterWait) return lostAfterWait;
    // Core rule: report success only when the chain confirms the intended
    // payment. A reverted receipt is a failure — the EIP-3009 authorization
    // was never consumed, so the nonce stays unmarked and the payer can
    // retry. A successful receipt without the expected USDC transfer is
    // UNRESOLVED, not failed: the authorization is likely consumed onchain,
    // so the hash is preserved as evidence instead of being discarded.
    if (!receiptConfirmsPayment({ receipt, ...payment })) {
      if (receipt.status !== 'success') {
        if (id) opts.store.deleteBroadcast(id);
        return {
          success: false,
          errorReason: 'transaction_reverted',
          transaction: hash,
          network: cfg.caip2,
          payer: from,
          detail: 'Transaction reverted onchain; payment was not made.',
        };
      }
      return {
        success: false,
        errorReason: 'settlement_unresolved',
        transaction: hash,
        network: cfg.caip2,
        payer: from,
        detail:
          'Transaction succeeded onchain but the expected USDC transfer was not found in its receipt. The authorization may be consumed; investigate the transaction before retrying.',
      };
    }
    if (id) {
      try {
        opts.store.deleteBroadcast(id);
        opts.store.deleteBroadcastIntent(id);
        opts.store.mark(id, Number(validBefore));
      } catch {
        // The payment is confirmed onchain; never report failure for a
        // confirmed payment because of a local write error. The onchain
        // authorizationState check remains the replay backstop.
      }
    }
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
