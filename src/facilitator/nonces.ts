/**
 * 402 Phase 2 — in-memory SettlementStore (replay protection + broadcast log
 * + in-flight claims).
 *
 * Each authorization nonce may be used at most once. Entries expire with the
 * authorization (validBefore), so memory stays bounded.
 *
 * This is the single-process implementation of SettlementStore, for tests
 * and single-process dev. Production with restarts / multiple instances
 * should use SqliteSettlementStore (./settlement-store.js), selected with
 * FOUR02_SETTLEMENT_DB_PATH.
 */
import type { Hex } from 'viem';
import {
  INFLIGHT_CLAIM_TTL_SEC,
  settlementKey,
  type SettlementIdentity,
  type SettlementStore,
} from './settlement-store.js';

export class NonceStore implements SettlementStore {
  private used = new Map<string, number>(); // key -> expiry unix seconds
  private broadcasts = new Map<string, Hex>(); // key -> tx hash
  private inflight = new Map<string, number>(); // key -> claimedAt unix seconds

  /** True if this authorization was already consumed and has not yet expired. */
  has(id: SettlementIdentity, nowSec: number): boolean {
    const k = settlementKey(id);
    const expiry = this.used.get(k);
    if (expiry === undefined) return false;
    if (expiry <= nowSec) {
      this.used.delete(k);
      return false;
    }
    return true;
  }

  /** Record an authorization as consumed until expiresAtSec. */
  mark(id: SettlementIdentity, expiresAtSec: number): void {
    this.used.set(settlementKey(id), Number(expiresAtSec));
    // H2 fix: sweep against the ACTUAL current time. Passing the entry's
    // expiry here used to wipe the whole store the moment it hit 10k entries.
    this.sweep(Math.floor(Date.now() / 1000));
  }

  get size(): number {
    return this.used.size;
  }

  getBroadcast(id: SettlementIdentity): Hex | undefined {
    return this.broadcasts.get(settlementKey(id));
  }

  setBroadcast(id: SettlementIdentity, hash: Hex): void {
    this.broadcasts.set(settlementKey(id), hash);
  }

  deleteBroadcast(id: SettlementIdentity): void {
    this.broadcasts.delete(settlementKey(id));
  }

  tryClaimInFlight(id: SettlementIdentity, nowSec: number): boolean {
    const k = settlementKey(id);
    const claimedAt = this.inflight.get(k);
    if (claimedAt !== undefined && claimedAt + INFLIGHT_CLAIM_TTL_SEC > nowSec) {
      return false;
    }
    this.inflight.set(k, nowSec);
    return true;
  }

  releaseInFlight(id: SettlementIdentity): void {
    this.inflight.delete(settlementKey(id));
  }

  close(): void {
    // Nothing to release for the in-memory store.
  }

  private sweep(nowSec: number): void {
    if (this.used.size < 10_000) return;
    for (const [k, expiry] of this.used) {
      if (expiry <= nowSec) this.used.delete(k);
    }
  }
}
