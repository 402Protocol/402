/**
 * 402 Phase 2 — durable settlement state (fix #3).
 *
 * Settlement state used to live in process memory (NonceStore, the in-flight
 * Map, the broadcast log): a restart or a second facilitator instance forgot
 * consumed nonces, in-flight settlements, and broadcast tx hashes. The
 * onchain `authorizationState` check was the only backstop.
 *
 * This module defines the SettlementStore interface — one home for all
 * settlement state — keyed by the full authorization identity:
 * (chain, token, payer, nonce). Two implementations:
 *  - NonceStore (./nonces.js): in-memory, for tests and single-process dev.
 *  - SqliteSettlementStore (here): durable, shared across restarts and
 *    across facilitator instances via a SQLite file in WAL mode.
 *
 * Tables:
 *  - settlement_nonces:     consumed EIP-3009 nonces (replay protection).
 *  - settlement_broadcasts: latest broadcast tx hash per authorization
 *                           (timeout recovery, fix #2).
 *  - settlement_inflight:   mutual-exclusion claims so two instances never
 *                           settle the same authorization concurrently.
 *                           Stale claims (older than INFLIGHT_CLAIM_TTL_SEC)
 *                           can be taken over — this is the crash-recovery
 *                           path for a dead instance's in-flight settlement.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';
import { chainFromCaip2 } from './chains.js';
import type { SettleRequest } from './types.js';

/** Full identity of an EIP-3009 authorization. The durable key. */
export interface SettlementIdentity {
  chainId: number;
  token: Address;
  payer: Address;
  nonce: Hex;
}

/** How long an in-flight claim is honored before it is considered stale. */
export const INFLIGHT_CLAIM_TTL_SEC = 300;

/** Canonical string key for a settlement identity (all parts lowercased). */
export function settlementKey(id: SettlementIdentity): string {
  return `${id.chainId}:${id.token.toLowerCase()}:${id.payer.toLowerCase()}:${id.nonce.toLowerCase()}`;
}

/**
 * Build the settlement identity for a request, or null when the request is
 * too malformed to key (falls through to normal validation errors).
 */
export function settlementIdentity(req: SettleRequest): SettlementIdentity | null {
  try {
    const network = req?.paymentRequirements?.network;
    const auth = req?.paymentPayload?.payload?.authorization;
    const cfg = typeof network === 'string' ? chainFromCaip2(network) : undefined;
    const from = auth?.from;
    const nonce = auth?.nonce;
    if (!cfg || typeof from !== 'string' || !from || typeof nonce !== 'string' || !nonce) {
      return null;
    }
    return {
      chainId: cfg.chainId,
      token: getAddress(cfg.usdc.address),
      payer: getAddress(from),
      nonce: nonce.toLowerCase() as Hex,
    };
  } catch {
    return null;
  }
}

export interface SettlementStore {
  /** True when this authorization's nonce was already consumed and unexpired. */
  has(id: SettlementIdentity, nowSec: number): boolean;
  /** Record an authorization's nonce as consumed until expiresAtSec. */
  mark(id: SettlementIdentity, expiresAtSec: number): void;
  /** Latest broadcast tx hash for this authorization, if any. */
  getBroadcast(id: SettlementIdentity): Hex | undefined;
  /** Save the broadcast tx hash for this authorization. */
  setBroadcast(id: SettlementIdentity, hash: Hex): void;
  /** Forget the broadcast tx hash for this authorization. */
  deleteBroadcast(id: SettlementIdentity): void;
  /**
   * Claim exclusive processing of this settlement. Returns true when this
   * caller won the claim. A second claimant (same process or another
   * instance) gets false while the claim is fresh; a stale claim
   * (older than INFLIGHT_CLAIM_TTL_SEC) can be taken over.
   */
  tryClaimInFlight(id: SettlementIdentity, nowSec: number): boolean;
  /** Release an in-flight claim. */
  releaseInFlight(id: SettlementIdentity): void;
  /** Release resources (closes the DB for the SQLite store). */
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settlement_nonces (
  chain_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  payer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, token, payer, nonce)
);
CREATE TABLE IF NOT EXISTS settlement_broadcasts (
  chain_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  payer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, token, payer, nonce)
);
CREATE TABLE IF NOT EXISTS settlement_inflight (
  chain_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  payer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, token, payer, nonce)
);
`;

/** SQLite-backed SettlementStore. The DB file is the shared source of truth. */
export class SqliteSettlementStore implements SettlementStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL mode: readers don't block writers — required for two instances.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  private norm(id: SettlementIdentity) {
    return {
      chainId: id.chainId,
      token: id.token.toLowerCase(),
      payer: id.payer.toLowerCase(),
      nonce: id.nonce.toLowerCase(),
    };
  }

  has(id: SettlementIdentity, nowSec: number): boolean {
    const n = this.norm(id);
    const row = this.db
      .prepare(
        'SELECT expires_at FROM settlement_nonces WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?',
      )
      .get(n.chainId, n.token, n.payer, n.nonce) as { expires_at: number } | undefined;
    if (!row) return false;
    if (row.expires_at <= nowSec) {
      this.db
        .prepare(
          'DELETE FROM settlement_nonces WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?',
        )
        .run(n.chainId, n.token, n.payer, n.nonce);
      return false;
    }
    return true;
  }

  mark(id: SettlementIdentity, expiresAtSec: number): void {
    const n = this.norm(id);
    this.db
      .prepare(
        `INSERT INTO settlement_nonces (chain_id, token, payer, nonce, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, token, payer, nonce)
         DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(n.chainId, n.token, n.payer, n.nonce, Math.floor(expiresAtSec));
  }

  getBroadcast(id: SettlementIdentity): Hex | undefined {
    const n = this.norm(id);
    const row = this.db
      .prepare(
        'SELECT tx_hash FROM settlement_broadcasts WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?',
      )
      .get(n.chainId, n.token, n.payer, n.nonce) as { tx_hash: string } | undefined;
    return row ? (row.tx_hash as Hex) : undefined;
  }

  setBroadcast(id: SettlementIdentity, hash: Hex): void {
    const n = this.norm(id);
    this.db
      .prepare(
        `INSERT INTO settlement_broadcasts (chain_id, token, payer, nonce, tx_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, token, payer, nonce)
         DO UPDATE SET tx_hash = excluded.tx_hash, updated_at = excluded.updated_at`,
      )
      .run(n.chainId, n.token, n.payer, n.nonce, hash, Math.floor(Date.now() / 1000));
  }

  deleteBroadcast(id: SettlementIdentity): void {
    const n = this.norm(id);
    this.db
      .prepare(
        'DELETE FROM settlement_broadcasts WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?',
      )
      .run(n.chainId, n.token, n.payer, n.nonce);
  }

  tryClaimInFlight(id: SettlementIdentity, nowSec: number): boolean {
    const n = this.norm(id);
    // Atomic: insert wins; on conflict we steal only a stale claim.
    // changes === 1 means this caller holds the claim.
    const res = this.db
      .prepare(
        `INSERT INTO settlement_inflight (chain_id, token, payer, nonce, claimed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, token, payer, nonce)
         DO UPDATE SET claimed_at = excluded.claimed_at
         WHERE settlement_inflight.claimed_at <= ?`,
      )
      .run(n.chainId, n.token, n.payer, n.nonce, nowSec, nowSec - INFLIGHT_CLAIM_TTL_SEC);
    return res.changes === 1;
  }

  releaseInFlight(id: SettlementIdentity): void {
    const n = this.norm(id);
    this.db
      .prepare(
        'DELETE FROM settlement_inflight WHERE chain_id = ? AND token = ? AND payer = ? AND nonce = ?',
      )
      .run(n.chainId, n.token, n.payer, n.nonce);
  }

  close(): void {
    this.db.close();
  }
}
