/**
 * 402 Job Marketplace v0 — SQLite storage (node:sqlite, DatabaseSync).
 *
 * Tables: job_listings, job_workers, used_tx_hashes. Same conventions as
 * the LoungeDb: synchronous API, single process, multi-step mutations run
 * inside BEGIN/COMMIT so state transitions and tx-hash burns stay atomic.
 *
 * Trust split: the DB is cheap metadata — the escrow contract holds the
 * money and the ERC-8004 registry holds identity. The DB never invents an
 * outcome; every money-moving transition is gated on a verified txHash,
 * and each txHash is single-use (used_tx_hashes, the blackjack-buyin
 * replay pattern).
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { type Address, getAddress } from 'viem';

/** Job lifecycle states (spec §Job lifecycle). */
export type JobState =
  | 'open'
  | 'claimed'
  | 'submitted'
  | 'complete'
  | 'disputed'
  | 'resolved'
  | 'refunded';

/** txHash purposes burned in used_tx_hashes. */
export type JobsTxPurpose = 'post' | 'claim' | 'accept' | 'dispute' | 'refund' | 'resolve';

export interface JobListing {
  id: number;
  /** Onchain job id in the BountyEscrow contract (decimal string). */
  escrowJobId: string;
  /** Escrow contract address the bounty was funded in. */
  escrow: Address;
  requester: Address;
  worker: Address | null;
  /** ERC-8004 agent id captured trustlessly at claim time (decimal string). */
  workerAgentId: string | null;
  title: string;
  spec: string;
  /** keccak256(spec); must equal the onchain termsHash (no bait-and-switch). */
  specHash: string;
  category: string;
  /** Decimal USDC string, 6dp (e.g. "25.00"). */
  bountyUsdc: string;
  /** Unix seconds. */
  deadline: number;
  state: JobState;
  submissionHash: string | null;
  submissionUri: string | null;
  /** Unix seconds, set when the job enters `disputed` (dispute SLA clock). */
  disputedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobWorker {
  wallet: Address;
  /** ERC-8004 agent id (decimal string). */
  agentId: string;
  /** TRACES seat token id — NULL until seats are required at launch+. */
  seatTokenId: string | null;
  enrolledAt: number;
  lastVerifiedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escrow_job_id TEXT NOT NULL,
  escrow TEXT NOT NULL,
  requester TEXT NOT NULL,
  worker TEXT,
  worker_agent_id TEXT,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  bounty_usdc TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL,
  submission_hash TEXT,
  submission_uri TEXT,
  disputed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_workers (
  wallet TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  seat_token_id TEXT,
  enrolled_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS used_tx_hashes (
  tx_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON job_listings(state, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_category ON job_listings(category, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_worker_agent ON job_listings(worker_agent_id, created_at);
`;

function rowToListing(row: Record<string, unknown>): JobListing {
  return {
    id: row.id as number,
    escrowJobId: row.escrow_job_id as string,
    escrow: row.escrow as string as Address,
    requester: row.requester as string as Address,
    worker: (row.worker as string | null) as Address | null,
    workerAgentId: (row.worker_agent_id as string | null) ?? null,
    title: row.title as string,
    spec: row.spec as string,
    specHash: row.spec_hash as string,
    category: row.category as string,
    bountyUsdc: row.bounty_usdc as string,
    deadline: row.deadline as number,
    state: row.state as JobState,
    submissionHash: (row.submission_hash as string | null) ?? null,
    submissionUri: (row.submission_uri as string | null) ?? null,
    disputedAt: (row.disputed_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class JobsDb {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** node:sqlite has no transaction() helper — BEGIN/COMMIT manually. */
  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /**
   * Burn a tx hash (single-use). Returns false when already used —
   * the replay-protection check (PRIMARY KEY conflict).
   */
  markTxUsed(
    purpose: JobsTxPurpose,
    txHash: string,
    jobId: number,
    usedAt: number,
  ): boolean {
    try {
      this.db
        .prepare(
          'INSERT INTO used_tx_hashes (tx_hash, purpose, job_id, used_at) VALUES (?, ?, ?, ?)',
        )
        .run(txHash.toLowerCase(), purpose, jobId, usedAt);
      return true;
    } catch (e) {
      if (
        e instanceof Error &&
        /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)
      ) {
        return false;
      }
      throw e;
    }
  }

  isTxUsed(txHash: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM used_tx_hashes WHERE tx_hash = ?')
      .get(txHash.toLowerCase()) as unknown;
    return row !== undefined;
  }

  /**
   * Create a listing and burn the funding tx hash atomically: the hash is
   * inserted first, so a replay can never mint a second listing.
   */
  createListing(o: {
    escrowJobId: string;
    escrow: Address;
    requester: Address;
    title: string;
    spec: string;
    specHash: string;
    category: string;
    bountyUsdc: string;
    deadline: number;
    txHash: string;
    now: number;
  }): { ok: true; id: number } | { ok: false; reason: 'tx_reused' } {
    return this.txn(() => {
      if (!this.markTxUsed('post', o.txHash, -1, o.now)) {
        return { ok: false, reason: 'tx_reused' as const };
      }
      const res = this.db
        .prepare(
          `INSERT INTO job_listings
             (escrow_job_id, escrow, requester, worker, worker_agent_id, title, spec,
              spec_hash, category, bounty_usdc, deadline, state,
              submission_hash, submission_uri, disputed_at, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          o.escrowJobId,
          getAddress(o.escrow),
          getAddress(o.requester),
          o.title,
          o.spec,
          o.specHash,
          o.category,
          o.bountyUsdc,
          o.deadline,
          o.now,
          o.now,
        );
      const id = Number(res.lastInsertRowid);
      // Point the burned hash at the real listing now that we know the id.
      this.db
        .prepare('UPDATE used_tx_hashes SET job_id = ? WHERE tx_hash = ?')
        .run(id, o.txHash.toLowerCase());
      return { ok: true, id };
    });
  }

  getJob(id: number): JobListing | null {
    const row = this.db
      .prepare('SELECT * FROM job_listings WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToListing(row) : null;
  }

  /** Public board: newest first, optional state/category filters. */
  listJobs(o: {
    status?: JobState;
    category?: string;
    limit: number;
  }): JobListing[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (o.status) {
      where.push('state = ?');
      params.push(o.status);
    }
    if (o.category) {
      where.push('category = ?');
      params.push(o.category);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM job_listings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, o.limit) as Record<string, unknown>[];
    return rows.map(rowToListing);
  }

  /** All jobs a given agent id worked on (the DB half of the resume). */
  jobsForAgent(agentId: string): JobListing[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM job_listings WHERE worker_agent_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToListing);
  }

  /**
   * State-machine transition, enforced inside a transaction: the row must
   * currently be in one of `from`, otherwise 'wrong_state'. `apply` runs
   * the extra column updates for the transition.
   */
  private transition(
    id: number,
    from: JobState[],
    to: JobState,
    now: number,
    apply?: (listing: JobListing) => void,
  ): 'ok' | 'not_found' | 'wrong_state' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (!from.includes(listing.state)) return 'wrong_state';
      apply?.(listing);
      this.db
        .prepare('UPDATE job_listings SET state = ?, updated_at = ? WHERE id = ?')
        .run(to, now, id);
      return 'ok';
    });
  }

  /** open -> claimed (worker + agentId bound at claim time). */
  claimJob(
    id: number,
    worker: Address,
    agentId: string,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state !== 'open') return 'wrong_state';
      if (!this.markTxUsed('claim', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          `UPDATE job_listings
           SET state = 'claimed', worker = ?, worker_agent_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(getAddress(worker), agentId, now, id);
      return 'ok';
    });
  }

  /** claimed -> submitted (worker deliverable hash + uri; offchain, no tx). */
  submitJob(
    id: number,
    submissionHash: string,
    submissionUri: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' {
    return this.transition(id, ['claimed'], 'submitted', now, () => {
      this.db
        .prepare(
          'UPDATE job_listings SET submission_hash = ?, submission_uri = ? WHERE id = ?',
        )
        .run(submissionHash, submissionUri, id);
    });
  }

  /** submitted -> complete (requester accepted; release verified onchain).
   *
   * `claimed` is also accepted as a source: confirmDelivery is a
   * permissionless onchain call, so a worker can deliver without ever
   * touching the API's submit endpoint. When a verified release() exists
   * onchain, the DB mirrors it rather than stranding the listing in
   * `claimed` forever. The release tx itself proves payer approval +
   * worker delivery — nothing is invented.
   */
  acceptJob(
    id: number,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state !== 'submitted' && listing.state !== 'claimed') {
        return 'wrong_state';
      }
      if (!this.markTxUsed('accept', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          "UPDATE job_listings SET state = 'complete', updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      return 'ok';
    });
  }

  /** claimed|submitted -> disputed (either party; raiseDispute verified onchain). */
  disputeJob(
    id: number,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state !== 'claimed' && listing.state !== 'submitted') {
        return 'wrong_state';
      }
      if (!this.markTxUsed('dispute', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          "UPDATE job_listings SET state = 'disputed', disputed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
      return 'ok';
    });
  }

  /** disputed -> resolved (arbiter outcome mirrored; resolve endpoint). */
  resolveJob(
    id: number,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state !== 'disputed') return 'wrong_state';
      if (!this.markTxUsed('resolve', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          "UPDATE job_listings SET state = 'resolved', updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      return 'ok';
    });
  }

  /**
   * open|claimed -> refunded (deadline + refundDelay passed onchain; refund
   * endpoint mirrors the JobRefunded event).
   *
   * `disputed` is deliberately NOT a source: the escrow's refund() reverts
   * from Disputed onchain, so a disputed -> refunded row would invent an
   * outcome that can never happen. `submitted` is excluded for the same
   * reason (Delivered can't be refunded — the payer must release/dispute).
   */
  refundJob(
    id: number,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state !== 'open' && listing.state !== 'claimed') {
        return 'wrong_state';
      }
      if (!this.markTxUsed('refund', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          "UPDATE job_listings SET state = 'refunded', updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      return 'ok';
    });
  }

  /**
   * Enroll (or re-verify) a worker. Upsert: first enrollment keeps its
   * enrolled_at; every call refreshes last_verified_at. No auth here —
   * the caller verifies the signature + onchain identity first.
   */
  enrollWorker(o: {
    wallet: Address;
    agentId: string;
    seatTokenId?: string | null;
    now: number;
  }): { isNew: boolean } {
    const existing = this.getWorker(o.wallet);
    if (existing) {
      this.db
        .prepare(
          `UPDATE job_workers SET agent_id = ?, seat_token_id = ?, last_verified_at = ?
           WHERE wallet = ?`,
        )
        .run(o.agentId, o.seatTokenId ?? null, o.now, getAddress(o.wallet));
      return { isNew: false };
    }
    this.db
      .prepare(
        `INSERT INTO job_workers (wallet, agent_id, seat_token_id, enrolled_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        getAddress(o.wallet),
        o.agentId,
        o.seatTokenId ?? null,
        o.now,
        o.now,
      );
    return { isNew: true };
  }

  getWorker(wallet: string): JobWorker | null {
    let addr: string;
    try {
      addr = getAddress(wallet);
    } catch {
      return null;
    }
    const row = this.db
      .prepare('SELECT * FROM job_workers WHERE wallet = ?')
      .get(addr) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      wallet: row.wallet as Address,
      agentId: row.agent_id as string,
      seatTokenId: (row.seat_token_id as string | null) ?? null,
      enrolledAt: row.enrolled_at as number,
      lastVerifiedAt: row.last_verified_at as number,
    };
  }
}
