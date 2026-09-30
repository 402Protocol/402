/**
 * Claim-session storage (node:sqlite, DatabaseSync).
 *
 * Session state machine:
 *   issued -> passkey_registered -> exported -> backup_confirmed -> complete
 *
 * The deposit address is revealed ONLY at backup_confirmed. Until then the
 * wallet is empty and unfundable by construction (no address disclosed).
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

export type ClaimStatus =
  | 'issued'
  | 'passkey_registered'
  | 'exported'
  | 'backup_confirmed'
  | 'complete';

export interface ClaimSession {
  sid: string;
  token_hash: string;
  sub_org_id: string;
  wallet_address: string;
  wallet_account: string;
  status: ClaimStatus;
  passkey_credential_id: string | null;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_sessions (
  sid TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  sub_org_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  wallet_account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  passkey_credential_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_claim_token ON claim_sessions(token_hash);
`;

export class ClaimDb {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path) || '.', { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** Create a session for a freshly provisioned wallet. Returns the sid. */
  createSession(args: {
    token: string;
    subOrgId: string;
    walletAddress: string;
    walletAccount: string;
    ttlSeconds: number;
  }): string {
    const sid = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO claim_sessions
         (sid, token_hash, sub_org_id, wallet_address, wallet_account, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'issued', ?, ?)`,
      )
      .run(
        sid,
        createHash('sha256').update(args.token).digest('hex'),
        args.subOrgId,
        args.walletAddress,
        args.walletAccount,
        now,
        now + args.ttlSeconds,
      );
    return sid;
  }

  getSession(sid: string): ClaimSession | null {
    return (this.db.prepare('SELECT * FROM claim_sessions WHERE sid = ?').get(sid) as unknown as ClaimSession) ?? null;
  }

  getSessionByToken(token: string): ClaimSession | null {
    const h = createHash('sha256').update(token).digest('hex');
    return (this.db.prepare('SELECT * FROM claim_sessions WHERE token_hash = ?').get(h) as unknown as ClaimSession) ?? null;
  }

  /** Replace the token hash (used when the token is issued after the session row exists). */
  setTokenHash(sid: string, token: string): void {
    this.db
      .prepare('UPDATE claim_sessions SET token_hash = ? WHERE sid = ?')
      .run(createHash('sha256').update(token).digest('hex'), sid);
  }

  /** Advance status; throws when the transition is illegal. */
  advance(sid: string, to: ClaimStatus, patch: { passkey_credential_id?: string } = {}): ClaimSession {
    const s = this.getSession(sid);
    if (!s) throw new Error('unknown session');
    const order: ClaimStatus[] = ['issued', 'passkey_registered', 'exported', 'backup_confirmed', 'complete'];
    if (order.indexOf(to) !== order.indexOf(s.status) + 1) {
      throw new Error(`illegal claim transition: ${s.status} -> ${to}`);
    }
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE claim_sessions SET status = ?, passkey_credential_id = COALESCE(?, passkey_credential_id),
         completed_at = CASE WHEN ? = 'complete' THEN ? ELSE completed_at END WHERE sid = ?`,
      )
      .run(to, patch.passkey_credential_id ?? null, to, now, sid);
    return this.getSession(sid)!;
  }

  close() {
    this.db.close();
  }
}
