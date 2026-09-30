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
  | 'in_review'
  | 'verified'
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
  /** TRACES seat token id backing the claim (decimal string), for the
   * per-seat active-job cap. Null when seats are not required. */
  workerSeatId: string | null;
  title: string;
  spec: string;
  /** When true, the spec is withheld from public board/detail reads
   * (returned as null, specHash kept) and only served to the requester or
   * the claimed worker via POST /jobs/:id/spec. */
  specPrivate: boolean;
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

/**
 * Verification-panel lifecycle. Panels are ADVISORY ONLY: they never move
 * funds and never trigger release/dispute — that stays with the
 * poster/arbiter escrow flow. A panel only ever attests.
 */
export type PanelState = 'open' | 'verified' | 'rejected' | 'closed';

export interface PanelReviewer {
  reviewerAgentId: string;
  reviewerWallet: Address;
  assignedAt: number;
  replacedAt: number | null;
  votedAt: number | null;
}

export interface PanelVote {
  reviewerAgentId: string;
  /** true = accept, false = reject. */
  verdict: boolean;
  /** 0-100. */
  score: number;
  votedAt: number;
}

export interface JobPanel {
  jobId: number;
  state: PanelState;
  createdAt: number;
  deadlineAt: number;
  decidedAt: number | null;
  reviewers: PanelReviewer[];
  votes: PanelVote[];
}

export interface ReviewerStats {
  reviewerAgentId: string;
  reviewsDone: number;
  agreedWithQuorum: number;
  outlierVotes: number;
  noShows: number;
  cooldownUntil: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escrow_job_id TEXT NOT NULL,
  escrow TEXT NOT NULL,
  requester TEXT NOT NULL,
  worker TEXT,
  worker_agent_id TEXT,
  /** TRACES seat backing this claim — set at claim time for per-seat caps. */
  worker_seat_id TEXT,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  spec_private INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_jobs_requester_created ON job_listings(requester, created_at);
-- Verification panels (advisory only — never move funds).
CREATE TABLE IF NOT EXISTS job_panels (
  job_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS job_panel_reviewers (
  job_id INTEGER NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  reviewer_wallet TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  replaced_at INTEGER,
  voted_at INTEGER,
  PRIMARY KEY (job_id, reviewer_agent_id)
);
CREATE TABLE IF NOT EXISTS job_reviews (
  job_id INTEGER NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  verdict INTEGER NOT NULL,
  score INTEGER NOT NULL,
  voted_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (job_id, reviewer_agent_id)
);
CREATE TABLE IF NOT EXISTS reviewer_stats (
  reviewer_agent_id TEXT PRIMARY KEY,
  reviews_done INTEGER NOT NULL DEFAULT 0,
  agreed_with_quorum INTEGER NOT NULL DEFAULT 0,
  outlier_votes INTEGER NOT NULL DEFAULT 0,
  no_shows INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_panel_reviewers_wallet ON job_panel_reviewers(reviewer_wallet, replaced_at);
-- Onchain batch keeper: which (epoch, chunk) ids have been submitted to the
-- PanelBatchWriter contract. epoch_id = YYYYMMDD * 1000 + chunkIndex.
CREATE TABLE IF NOT EXISTS panel_epoch_submissions (
  epoch_id INTEGER PRIMARY KEY,
  submitted_at INTEGER NOT NULL,
  tx_hash TEXT NOT NULL
);
`;

function rowToListing(row: Record<string, unknown>): JobListing {
  return {
    id: row.id as number,
    escrowJobId: row.escrow_job_id as string,
    escrow: row.escrow as string as Address,
    requester: row.requester as string as Address,
    worker: (row.worker as string | null) as Address | null,
    workerAgentId: (row.worker_agent_id as string | null) ?? null,
    workerSeatId: (row.worker_seat_id as string | null) ?? null,
    title: row.title as string,
    spec: row.spec as string,
    specPrivate: Number(row.spec_private ?? 0) === 1,
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
    this.migrate();
  }

  /**
   * Column migrations for DBs created before the current schema.
   * CREATE TABLE IF NOT EXISTS never alters an existing table, so each
   * later column lands here as a guarded ALTER TABLE. Existing rows get the
   * column default (public specs for pre-privacy listings).
   */
  private migrate(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(job_listings)')
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('spec_private')) {
      this.db.exec(
        'ALTER TABLE job_listings ADD COLUMN spec_private INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!names.has('worker_seat_id')) {
      this.db.exec('ALTER TABLE job_listings ADD COLUMN worker_seat_id TEXT');
    }
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
    specPrivate?: boolean;
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
              spec_private, spec_hash, category, bounty_usdc, deadline, state,
              submission_hash, submission_uri, disputed_at, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          o.escrowJobId,
          getAddress(o.escrow),
          getAddress(o.requester),
          o.title,
          o.spec,
          o.specPrivate ? 1 : 0,
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
   * Board-spam cap: how many listings `requester` created at/after
   * `sinceSec` (rolling 24h window). Backed by idx_jobs_requester_created.
   */
  countListingsSince(requester: string, sinceSec: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM job_listings WHERE requester = ? AND created_at >= ?',
      )
      .get(getAddress(requester), sinceSec) as { n: number } | undefined;
    return row?.n ?? 0;
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
    seatId: string | null = null,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state !== 'open') return 'wrong_state';
      if (!this.markTxUsed('claim', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          `UPDATE job_listings
           SET state = 'claimed', worker = ?, worker_agent_id = ?,
               worker_seat_id = COALESCE(?, worker_seat_id), updated_at = ?
           WHERE id = ?`,
        )
        .run(getAddress(worker), agentId, seatId, now, id);
      return 'ok';
    });
  }

  /**
   * Active jobs backed by one TRACES seat: claimed, submitted, in_review,
   * verified, or disputed. Terminal states (complete/resolved/refunded)
   * free the seat. The seat gate enforces the per-seat cap against this
   * count at claim.
   */
  countActiveJobsForSeat(seatId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM job_listings
         WHERE worker_seat_id = ?
           AND state IN ('claimed', 'submitted', 'in_review', 'verified', 'disputed')`,
      )
      .get(seatId) as { n: number };
    return row.n;
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
   *
   * `in_review` / `verified` are sources too: the poster may release while
   * a panel is still deliberating (panels are advisory). The open panel is
   * closed — its votes become moot once the money moves.
   */
  acceptJob(
    id: number,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (
        listing.state !== 'submitted' &&
        listing.state !== 'claimed' &&
        listing.state !== 'in_review' &&
        listing.state !== 'verified'
      ) {
        return 'wrong_state';
      }
      if (!this.markTxUsed('accept', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          "UPDATE job_listings SET state = 'complete', updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      this.closePanel(id, now);
      return 'ok';
    });
  }

  /** claimed|submitted|in_review|verified -> disputed (either party; raiseDispute verified onchain). */
  disputeJob(
    id: number,
    txHash: string,
    now: number,
  ): 'ok' | 'not_found' | 'wrong_state' | 'tx_reused' {
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (
        listing.state !== 'claimed' &&
        listing.state !== 'submitted' &&
        listing.state !== 'in_review' &&
        listing.state !== 'verified'
      ) {
        return 'wrong_state';
      }
      if (!this.markTxUsed('dispute', txHash, id, now)) return 'tx_reused';
      this.db
        .prepare(
          "UPDATE job_listings SET state = 'disputed', disputed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
      this.closePanel(id, now);
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
   * Forward-only onchain reconciliation (POST /jobs/:id/sync). Advances the
   * row toward a verified onchain state read from the escrow contract —
   * used when the action happened onchain WITHOUT touching the API (direct
   * contract call), which would otherwise strand the listing in a stale
   * state forever.
   *
   * Rules:
   * - Only moves FORWARD along the contract's state machine; never rolls
   *   a row back (a reorged-away tx is the documented accepted risk — the
   *   DB never un-invents a mirrored outcome).
   * - Never touches terminal rows (complete/resolved/refunded).
   * - When leaving 'open', the worker/agentId MUST be bound from the
   *   onchain job (the contract verified identity at claimBounty time, so
   *   the chain is the trustless source — a stale offchain row can't lie).
   * - No txHash is burned: the onchain read IS the proof, and every
   *   endpoint re-verifies its own tx anyway, so an unburned sync tx can
   *   never be weaponized elsewhere.
   */
  syncJobState(
    id: number,
    to: 'claimed' | 'disputed' | 'complete' | 'resolved' | 'refunded',
    o: { worker?: Address | null; agentId?: string | null; now: number },
  ): 'ok' | 'noop' | 'not_found' | 'no_path' {
    const forward: Record<string, JobState[]> = {
      claimed: ['open'],
      disputed: ['open', 'claimed', 'submitted', 'in_review', 'verified'],
      complete: ['open', 'claimed', 'submitted', 'in_review', 'verified'],
      resolved: ['open', 'claimed', 'submitted', 'disputed', 'in_review', 'verified'],
      refunded: ['open', 'claimed'],
    };
    return this.txn(() => {
      const listing = this.getJob(id);
      if (!listing) return 'not_found';
      if (listing.state === to) return 'noop';
      if (!forward[to].includes(listing.state)) return 'no_path';
      const worker = o.worker ? getAddress(o.worker) : listing.worker;
      const agentId = o.agentId ?? listing.workerAgentId;
      // A claimant must exist onchain for claimed/disputed/complete/resolved
      // (claimBounty always sets provider+agentId). Refunded is the exception:
      // refund() from Open has no claimant, so an unclaimed open -> refunded
      // sync must not demand one. Leaving 'open' for a claimant-target
      // without chain-bound worker/agentId would invent a claimant — refuse.
      const needsClaimant =
        to === 'claimed' || to === 'disputed' || to === 'complete' || to === 'resolved';
      if (needsClaimant && listing.state === 'open' && (!worker || !agentId)) {
        return 'no_path';
      }
      this.db
        .prepare(
          `UPDATE job_listings
           SET state = ?, worker = ?, worker_agent_id = ?,
               disputed_at = CASE WHEN ? = 'disputed' THEN ? ELSE disputed_at END,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(to, worker, agentId, to, o.now, o.now, id);
      // A sync that moves the job out of panel review moots the panel.
      if (to === 'disputed' || to === 'complete' || to === 'resolved' || to === 'refunded') {
        this.closePanel(id, o.now);
      }
      return 'ok';
    });
  }

  /**
   * Enroll (or re-verify) a worker. Upsert: first enrollment keeps its
   * enrolled_at; every call refreshes last_verified_at. No auth here —
   * the caller verifies the signature + onchain identity first.
   *
   * seatTokenId: when undefined the existing seat is PRESERVED (a claim-time
   * re-verification must not wipe the seat the seat gate checks); pass null
   * to clear it explicitly.
   */
  enrollWorker(o: {
    wallet: Address;
    agentId: string;
    seatTokenId?: string | null;
    now: number;
  }): { isNew: boolean } {
    const existing = this.getWorker(o.wallet);
    if (existing) {
      const seat =
        o.seatTokenId === undefined ? existing.seatTokenId : o.seatTokenId;
      this.db
        .prepare(
          `UPDATE job_workers SET agent_id = ?, seat_token_id = ?, last_verified_at = ?
           WHERE wallet = ?`,
        )
        .run(o.agentId, seat, o.now, getAddress(o.wallet));
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

  // ---- verification panels (advisory only) ----

  /**
   * Draw `count` eligible reviewers, randomly ordered. Eligibility:
   * - enrolled (in job_workers)
   * - not in excludeAgentIds / excludeWallets (the job's worker + poster)
   * - >= 1 completed (complete|resolved) job — earned history, not a fresh wallet
   * - no currently-open panel assignment (max 1 active review at a time)
   * - not on reviewer cooldown (no-show penalty)
   * - never reviewed excludeJobId before (fresh eyes on resubmission)
   *
   * Returns fewer than `count` when the pool is short — the caller decides
   * whether that is enough (it is not: v0 needs a full panel of 3).
   */
  drawReviewers(o: {
    count: number;
    excludeAgentIds?: string[];
    excludeWallets?: string[];
    excludeJobId?: number;
    now: number;
  }): { wallet: Address; agentId: string }[] {
    const agentEx = [...(o.excludeAgentIds ?? [])];
    const walletEx = (o.excludeWallets ?? []).map((w) => {
      try {
        return getAddress(w).toLowerCase();
      } catch {
        return '';
      }
    });
    const agentPlace = agentEx.map(() => '?').join(', ');
    const walletPlace = walletEx.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT w.wallet AS wallet, w.agent_id AS agent_id
         FROM job_workers w
         WHERE ${agentEx.length ? `w.agent_id NOT IN (${agentPlace}) AND` : ''}
               ${walletEx.length ? `LOWER(w.wallet) NOT IN (${walletPlace}) AND` : ''}
               ${o.excludeJobId !== undefined ? `NOT EXISTS (
                 SELECT 1 FROM job_panel_reviewers pr
                 WHERE pr.job_id = ? AND pr.reviewer_agent_id = w.agent_id
               ) AND` : ''}
               (
                 SELECT COUNT(*) FROM job_listings l
                 WHERE l.worker_agent_id = w.agent_id
                   AND l.state IN ('complete', 'resolved')
               ) >= 1
           AND NOT EXISTS (
                 SELECT 1 FROM job_panel_reviewers pr
                 JOIN job_panels p ON p.job_id = pr.job_id
                 WHERE pr.reviewer_agent_id = w.agent_id
                   AND pr.replaced_at IS NULL
                   AND p.state = 'open'
               )
           AND COALESCE(
                 (SELECT s.cooldown_until FROM reviewer_stats s
                  WHERE s.reviewer_agent_id = w.agent_id), 0
               ) <= ?
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(
        ...agentEx,
        ...walletEx,
        ...(o.excludeJobId !== undefined ? [o.excludeJobId] : []),
        o.now,
        o.count,
      ) as { wallet: string; agent_id: string }[];
    return rows.map((r) => ({
      wallet: r.wallet as Address,
      agentId: r.agent_id,
    }));
  }

  /**
   * Open a panel: submitted -> in_review + insert the panel and its
   * reviewer assignments, atomically. The caller drew the reviewers first.
   *
   * A resubmission (after a rejected panel) replaces the old panel rows:
   * the rejected panel's stats are already booked in reviewer_stats, and
   * the worker had the rejected window to read the revealed votes. One
   * active panel per job keeps the UNIQUE(job_id) invariant.
   */
  openPanel(
    jobId: number,
    reviewers: { wallet: Address; agentId: string }[],
    now: number,
    deadlineAt: number,
  ): 'ok' | 'not_found' | 'wrong_state' {
    return this.txn(() => {
      const listing = this.getJob(jobId);
      if (!listing) return 'not_found';
      if (listing.state !== 'submitted') return 'wrong_state';
      this.db.prepare('DELETE FROM job_reviews WHERE job_id = ?').run(jobId);
      this.db.prepare('DELETE FROM job_panel_reviewers WHERE job_id = ?').run(jobId);
      this.db.prepare('DELETE FROM job_panels WHERE job_id = ?').run(jobId);
      this.db
        .prepare(
          `INSERT INTO job_panels (job_id, state, created_at, deadline_at, decided_at)
           VALUES (?, 'open', ?, ?, NULL)`,
        )
        .run(jobId, now, deadlineAt);
      const ins = this.db.prepare(
        `INSERT INTO job_panel_reviewers
           (job_id, reviewer_agent_id, reviewer_wallet, assigned_at, replaced_at, voted_at)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      );
      for (const r of reviewers) {
        ins.run(jobId, r.agentId, getAddress(r.wallet), now);
      }
      this.db
        .prepare("UPDATE job_listings SET state = 'in_review', updated_at = ? WHERE id = ?")
        .run(now, jobId);
      return 'ok';
    });
  }

  /** Full panel row with reviewers + votes, or null when no panel exists. */
  getPanel(jobId: number): JobPanel | null {
    const p = this.db
      .prepare('SELECT * FROM job_panels WHERE job_id = ?')
      .get(jobId) as Record<string, unknown> | undefined;
    if (!p) return null;
    const reviewers = (
      this.db
        .prepare(
          'SELECT * FROM job_panel_reviewers WHERE job_id = ? ORDER BY assigned_at, reviewer_agent_id',
        )
        .all(jobId) as Record<string, unknown>[]
    ).map((r) => ({
      reviewerAgentId: r.reviewer_agent_id as string,
      reviewerWallet: r.reviewer_wallet as Address,
      assignedAt: r.assigned_at as number,
      replacedAt: (r.replaced_at as number | null) ?? null,
      votedAt: (r.voted_at as number | null) ?? null,
    }));
    const votes = (
      this.db
        .prepare(
          'SELECT * FROM job_reviews WHERE job_id = ? ORDER BY voted_at, reviewer_agent_id',
        )
        .all(jobId) as Record<string, unknown>[]
    ).map((r) => ({
      reviewerAgentId: r.reviewer_agent_id as string,
      verdict: Number(r.verdict) === 1,
      score: r.score as number,
      votedAt: r.voted_at as number,
    }));
    return {
      jobId,
      state: p.state as PanelState,
      createdAt: p.created_at as number,
      deadlineAt: p.deadline_at as number,
      decidedAt: (p.decided_at as number | null) ?? null,
      reviewers,
      votes,
    };
  }

  /**
   * Record a review vote and settle the panel when quorum is reached.
   * Atomic: the vote insert, the quorum evaluation, the job transition,
   * and the reviewer-stats accounting all land in one transaction.
   *
   * Quorum over ACTIVE (non-replaced) reviewers' votes: 2+ accepts with
   * more accepts than rejects -> verified (job in_review -> verified);
   * 2+ rejects with more rejects than accepts -> rejected (job back to
   * claimed, resubmittable). Anything else stays open.
   */
  recordReview(o: {
    jobId: number;
    reviewerWallet: Address;
    reviewerAgentId: string;
    verdict: boolean;
    score: number;
    signature: string;
    now: number;
  }): 'ok' | 'not_found' | 'no_panel' | 'not_assigned' | 'already_voted' | 'wrong_state' {
    return this.txn(() => {
      const listing = this.getJob(o.jobId);
      if (!listing) return 'not_found';
      const panel = this.getPanel(o.jobId);
      if (!panel || panel.state !== 'open') return 'no_panel';
      if (listing.state !== 'in_review') return 'wrong_state';
      const assignment = panel.reviewers.find(
        (r) =>
          r.reviewerAgentId === o.reviewerAgentId &&
          r.replacedAt === null,
      );
      if (
        !assignment ||
        assignment.reviewerWallet.toLowerCase() !== o.reviewerWallet.toLowerCase()
      ) {
        return 'not_assigned';
      }
      if (assignment.votedAt !== null) return 'already_voted';
      this.db
        .prepare(
          `INSERT INTO job_reviews
             (job_id, reviewer_agent_id, verdict, score, voted_at, signature)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          o.jobId,
          o.reviewerAgentId,
          o.verdict ? 1 : 0,
          o.score,
          o.now,
          o.signature,
        );
      this.db
        .prepare(
          `UPDATE job_panel_reviewers SET voted_at = ?
           WHERE job_id = ? AND reviewer_agent_id = ?`,
        )
        .run(o.now, o.jobId, o.reviewerAgentId);

      // Quorum over active reviewers only.
      const votes = (
        this.db
          .prepare(
            `SELECT r.verdict AS verdict FROM job_reviews r
             JOIN job_panel_reviewers pr
               ON pr.job_id = r.job_id AND pr.reviewer_agent_id = r.reviewer_agent_id
             WHERE r.job_id = ? AND pr.replaced_at IS NULL`,
          )
          .all(o.jobId) as { verdict: number }[]
      ).map((r) => r.verdict === 1);
      const accepts = votes.filter(Boolean).length;
      const rejects = votes.length - accepts;
      const outcome =
        accepts >= 2 && accepts > rejects
          ? 'verified'
          : rejects >= 2 && rejects > accepts
            ? 'rejected'
            : null;
      if (outcome) {
        const to: JobState = outcome === 'verified' ? 'verified' : 'claimed';
        this.db
          .prepare('UPDATE job_listings SET state = ?, updated_at = ? WHERE id = ?')
          .run(to, o.now, o.jobId);
        this.db
          .prepare("UPDATE job_panels SET state = ?, decided_at = ? WHERE job_id = ?")
          .run(outcome, o.now, o.jobId);
        // Reviewer accounting: agreement with the final quorum outcome.
        // A no-vote (replaced reviewers) is not an outlier — it is a no-show,
        // handled by replaceNoShows.
        const expected = outcome === 'verified';
        const voters = (
          this.db
            .prepare(
              `SELECT r.reviewer_agent_id AS agent_id, r.verdict AS verdict
               FROM job_reviews r
               JOIN job_panel_reviewers pr
                 ON pr.job_id = r.job_id AND pr.reviewer_agent_id = r.reviewer_agent_id
               WHERE r.job_id = ? AND pr.replaced_at IS NULL`,
            )
            .all(o.jobId) as { agent_id: string; verdict: number }[]
        );
        for (const v of voters) {
          const agreed = (v.verdict === 1) === expected;
          this.db
            .prepare(
              `INSERT INTO reviewer_stats
                 (reviewer_agent_id, reviews_done, agreed_with_quorum, outlier_votes, no_shows, cooldown_until)
               VALUES (?, 1, ?, ?, 0, 0)
               ON CONFLICT(reviewer_agent_id) DO UPDATE SET
                 reviews_done = reviews_done + 1,
                 agreed_with_quorum = agreed_with_quorum + ?,
                 outlier_votes = outlier_votes + ?`,
            )
            .run(v.agent_id, agreed ? 1 : 0, agreed ? 0 : 1, agreed ? 1 : 0, agreed ? 0 : 1);
        }
      }
      return 'ok';
    });
  }

  /**
   * Lazy no-show replacement: when an open panel's deadline has passed,
   * every assigned reviewer who never voted is replaced — marked replaced,
   * booked as a no-show (7-day assignment cooldown), and swapped for a
   * fresh draw. The panel deadline refreshes. When no replacements are
   * available the deadline is simply extended (the panel never shrinks to
   * a weaker quorum).
   *
   * Runs on every review read/write, so no cron is needed.
   */
  replaceNoShows(
    jobId: number,
    now: number,
    extendSeconds: number,
    cooldownSeconds: number,
    draw: (count: number, excludeAgentIds: string[]) => { wallet: Address; agentId: string }[],
  ): { replaced: string[]; added: { wallet: Address; agentId: string }[]; panelClosed: boolean } {
    return this.txn(() => {
      const panel = this.getPanel(jobId);
      if (!panel || panel.state !== 'open' || now <= panel.deadlineAt) {
        return { replaced: [], added: [], panelClosed: false };
      }
      const noShows = panel.reviewers.filter(
        (r) => r.replacedAt === null && r.votedAt === null,
      );
      if (noShows.length === 0) return { replaced: [], added: [], panelClosed: false };
      const noShowIds = noShows.map((r) => r.reviewerAgentId);
      for (const id of noShowIds) {
        this.db
          .prepare(
            `UPDATE job_panel_reviewers SET replaced_at = ?
             WHERE job_id = ? AND reviewer_agent_id = ?`,
          )
          .run(now, jobId, id);
        this.db
          .prepare(
            `INSERT INTO reviewer_stats
               (reviewer_agent_id, reviews_done, agreed_with_quorum, outlier_votes, no_shows, cooldown_until)
             VALUES (?, 0, 0, 0, 1, ?)
             ON CONFLICT(reviewer_agent_id) DO UPDATE SET
               no_shows = no_shows + 1,
               cooldown_until = excluded.cooldown_until`,
          )
          .run(id, now + cooldownSeconds);
      }
      // Fresh draw: exclude everyone who ever touched this panel (no
      // grudges, no second chances on the same job).
      const everAssigned = panel.reviewers.map((r) => r.reviewerAgentId);
      const fresh = draw(noShows.length, everAssigned).slice(0, noShows.length);
      const ins = this.db.prepare(
        `INSERT INTO job_panel_reviewers
           (job_id, reviewer_agent_id, reviewer_wallet, assigned_at, replaced_at, voted_at)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      );
      for (const r of fresh) {
        ins.run(jobId, r.agentId, getAddress(r.wallet), now);
      }
      // Liveness fallback: if nobody is left to vote (the whole pool
      // no-showed and the draw came up empty), the panel can never reach
      // quorum — close it and return the job to `submitted` so the poster
      // can still release directly. Panels are advisory and must never
      // strand a job.
      const active = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM job_panel_reviewers
             WHERE job_id = ? AND replaced_at IS NULL`,
          )
          .get(jobId) as { n: number }
      ).n;
      if (active === 0) {
        this.db
          .prepare("UPDATE job_panels SET state = 'closed', decided_at = ? WHERE job_id = ?")
          .run(now, jobId);
        this.db
          .prepare("UPDATE job_listings SET state = 'submitted', updated_at = ? WHERE id = ?")
          .run(now, jobId);
        return { replaced: noShowIds, added: fresh, panelClosed: true };
      }
      this.db
        .prepare('UPDATE job_panels SET deadline_at = ? WHERE job_id = ?')
        .run(now + extendSeconds, jobId);
      return { replaced: noShowIds, added: fresh, panelClosed: false };
    });
  }

  /** Close a live panel without a verdict (job left in_review/verified via another path). */
  closePanel(jobId: number, now: number): void {
    this.db
      .prepare(
        "UPDATE job_panels SET state = 'closed', decided_at = ? WHERE job_id = ? AND state IN ('open','verified')",
      )
      .run(now, jobId);
  }

  /**
   * Open panels where `wallet` is an actively assigned reviewer, with the
   * job context a reviewer needs to do the job: title, spec (assignment
   * implies read authorization — a reviewer cannot judge against terms they
   * cannot see), and the submission URI (withheld from public reads until
   * completion).
   */
  assignedPanels(wallet: string): {
    jobId: number;
    title: string;
    spec: string;
    specHash: string;
    category: string;
    bountyUsdc: string;
    submissionHash: string | null;
    submissionUri: string | null;
    reviewerAgentId: string;
    assignedAt: number;
    deadlineAt: number;
    voted: boolean;
  }[] {
    let addr: string;
    try {
      addr = getAddress(wallet);
    } catch {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT l.id AS job_id, l.title AS title, l.spec AS spec,
                l.spec_hash AS spec_hash, l.category AS category,
                l.bounty_usdc AS bounty_usdc,
                l.submission_hash AS submission_hash,
                l.submission_uri AS submission_uri,
                pr.reviewer_agent_id AS reviewer_agent_id,
                pr.assigned_at AS assigned_at,
                p.deadline_at AS deadline_at,
                pr.voted_at AS voted_at
         FROM job_panel_reviewers pr
         JOIN job_panels p ON p.job_id = pr.job_id
         JOIN job_listings l ON l.id = pr.job_id
         WHERE pr.reviewer_wallet = ? AND pr.replaced_at IS NULL AND p.state = 'open'
         ORDER BY p.deadline_at ASC`,
      )
      .all(addr) as Record<string, unknown>[];
    return rows.map((r) => ({
      jobId: r.job_id as number,
      title: r.title as string,
      spec: r.spec as string,
      specHash: r.spec_hash as string,
      category: r.category as string,
      bountyUsdc: r.bounty_usdc as string,
      submissionHash: (r.submission_hash as string | null) ?? null,
      submissionUri: (r.submission_uri as string | null) ?? null,
      reviewerAgentId: r.reviewer_agent_id as string,
      assignedAt: r.assigned_at as number,
      deadlineAt: r.deadline_at as number,
      voted: r.voted_at !== null,
    }));
  }

  /** Reviewer accounting read (feeds the future onchain batch keeper). */
  getReviewerStats(agentId: string): ReviewerStats {
    const row = (
      this.db
        .prepare('SELECT * FROM reviewer_stats WHERE reviewer_agent_id = ?')
        .get(agentId) as Record<string, unknown> | undefined
    );
    return {
      reviewerAgentId: agentId,
      reviewsDone: Number(row?.reviews_done ?? 0),
      agreedWithQuorum: Number(row?.agreed_with_quorum ?? 0),
      outlierVotes: Number(row?.outlier_votes ?? 0),
      noShows: Number(row?.no_shows ?? 0),
      cooldownUntil: Number(row?.cooldown_until ?? 0),
    };
  }

  /** All reviewer stat rows (feeds the onchain panel batch keeper). */
  listReviewerStats(): ReviewerStats[] {
    const rows = this.db
      .prepare('SELECT * FROM reviewer_stats ORDER BY reviewer_agent_id')
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      reviewerAgentId: row.reviewer_agent_id as string,
      reviewsDone: Number(row.reviews_done ?? 0),
      agreedWithQuorum: Number(row.agreed_with_quorum ?? 0),
      outlierVotes: Number(row.outlier_votes ?? 0),
      noShows: Number(row.no_shows ?? 0),
      cooldownUntil: Number(row.cooldown_until ?? 0),
    }));
  }

  /** Has this (epoch, chunk) batch already been submitted onchain? */
  isEpochSubmitted(epochId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM panel_epoch_submissions WHERE epoch_id = ?')
      .get(epochId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  /** Record a submitted onchain batch (after the tx confirms). */
  markEpochSubmitted(epochId: number, txHash: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO panel_epoch_submissions (epoch_id, submitted_at, tx_hash) VALUES (?, ?, ?)',
      )
      .run(epochId, Math.floor(Date.now() / 1000), txHash);
  }
}
