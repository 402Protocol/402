/**
 * Claim-site Hono app.
 *
 *   CLAIM_MODE=demo npx tsx src/cli/claim.ts   (or: npm run claim)
 *
 * Routes:
 *   GET  /                        demo landing (mint a demo claim link)
 *   POST /api/claim/issue         provision wallet + session, return claim link
 *                                 (live mode: requires x-admin-key)
 *   GET  /claim/:token            the ceremony page
 *   GET  /claim-assets/*          static frontend
 *   POST /api/claim/validate      { token } -> { status, step }
 *   POST /api/claim/passkey/options { token } -> WebAuthn creation options
 *   POST /api/claim/passkey/verify  { token, attestation } -> registered
 *   POST /api/claim/export         { token } -> { words } (demo)
 *   POST /api/claim/backup-confirm { token } -> { deposit_address }
 *
 * The deposit address is revealed ONLY after backup confirmation.
 */
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClaimConfig, type ClaimConfig } from './config.js';
import { ClaimDb } from './db.js';
import { issueClaimToken, verifyClaimToken } from './tokens.js';
import { createProvisioner, type ClaimProvisioner, type PasskeyAttestation } from './turnkey.js';
import { TurnkeySigner } from '../taap/signer.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');

/** Demo-only: keep one word list per session so back/refresh shows the same words. */
const demoWordsCache = new Map<string, string[]>();

export interface ClaimAppDeps {
  config: ClaimConfig;
  db: ClaimDb;
  provisioner: ClaimProvisioner;
}

export function createClaimApp(deps: ClaimAppDeps): Hono {
  const { config, db, provisioner } = deps;
  const app = new Hono();
  /** WebAuthn challenges awaiting attestation, keyed by sid. */
  const challenges = new Map<string, string>();

  const adminKey = process.env.CLAIM_ADMIN_KEY?.trim();
  if (config.mode === 'live' && !adminKey) {
    throw new Error('CLAIM_MODE=live requires CLAIM_ADMIN_KEY (the MCP provisions wallets through it).');
  }

  const requireAdmin = (c: { req: { header: (h: string) => string | undefined } }): { status: 401; body: { ok: false; error: string } } | null => {
    if (!adminKey) return null; // demo without a key: open (all objects are fake)
    if (c.req.header('x-admin-key') === adminKey) return null;
    return { status: 401, body: { ok: false, error: 'unauthorized: bad x-admin-key' } };
  };

  const json = (c: any, body: unknown, status = 200) => c.json(body, status);
  const fail = (c: any, message: string, status = 400) => json(c, { ok: false, error: message }, status);

  /** Resolve a bearer token to its live session, or null. */
  const sessionFromToken = (token: string) => {
    const payload = verifyClaimToken(config.hmacSecret, token);
    if (!payload) return null;
    const s = db.getSession(payload.sid);
    if (!s) return null;
    if (s.expires_at < Math.floor(Date.now() / 1000)) return null;
    return s;
  };

  // ---- static ----
  app.use('/claim-assets/*', serveStatic({ root: WEB_DIR, rewriteRequestPath: (p) => p.replace(/^\/claim-assets/, '') }));

  app.get('/', (c) => {
    return c.html(readFileSync(join(WEB_DIR, 'landing.html'), 'utf8'));
  });

  app.get('/claim/:token', (c) => {
    const s = sessionFromToken(c.req.param('token'));
    if (!s) return c.html(readFileSync(join(WEB_DIR, 'dead.html'), 'utf8'), 404);
    return c.html(readFileSync(join(WEB_DIR, 'index.html'), 'utf8'));
  });

  // ---- API ----

  /** Public onboarding config: the hosted MCP URL (empty = not configured yet). */
  app.get('/api/claim/public-config', (c) => {
    return json(c, { ok: true, mode: config.mode, mcpUrl: config.mcpUrl });
  });

  /** Provision a wallet + session and return the claim link. Called by the MCP (or the demo landing). */
  app.post('/api/claim/issue', async (c) => {
    try {
      const denied = requireAdmin(c as any);
      if (denied) return json(c, denied.body, denied.status);
      const label = randomUUID().slice(0, 8);
      const w = await provisioner.provisionWallet(label);
      // Issue the token AFTER the session exists (token embeds the sid).
      const sid = db.createSession({
        token: 'placeholder',
        subOrgId: w.subOrgId,
        walletAddress: w.address,
        walletAccount: w.address,
        ttlSeconds: config.linkTtlSeconds,
      });
      const token = issueClaimToken(config.hmacSecret, sid, config.linkTtlSeconds);
      db.setTokenHash(sid, token);
      const base = new URL(c.req.url).origin;
      return json(c, { ok: true, claim_url: `${base}/claim/${token}`, sid, mode: config.mode });
    } catch (e) {
      return fail(c, (e as Error).message, 500);
    }
  });

  app.post('/api/claim/validate', async (c) => {
    const { token } = await c.req.json().catch(() => ({}));
    const s = typeof token === 'string' ? sessionFromToken(token) : null;
    if (!s) return fail(c, 'invalid or expired claim link', 404);
    return json(c, { ok: true, status: s.status, mode: config.mode });
  });

  /**
   * Ceremony progress for the agent. The deposit address is revealed ONLY
   * after backup_confirmed — the same rule as the ceremony itself. The MCP
   * polls this so it can nudge the human without ever seeing the words.
   */
  app.post('/api/claim/status', async (c) => {
    const { token } = await c.req.json().catch(() => ({}));
    const s = typeof token === 'string' ? sessionFromToken(token) : null;
    if (!s) return fail(c, 'invalid or expired claim link', 404);
    const done = s.status === 'complete';
    return json(c, {
      ok: true,
      status: s.status,
      backed_up: done,
      deposit_address: done ? s.wallet_address : null,
    });
  });

  app.post('/api/claim/passkey/options', async (c) => {
    try {
      const { token } = await c.req.json().catch(() => ({}));
      const s = typeof token === 'string' ? sessionFromToken(token) : null;
      if (!s) return fail(c, 'invalid or expired claim link', 404);
      if (s.status !== 'issued') return fail(c, `wrong step: ${s.status}`, 409);
      const challenge = randomBytes(32).toString('base64url');
      challenges.set(s.sid, challenge);
      const url = new URL(c.req.url);
      return json(c, {
        ok: true,
        options: {
          challenge,
          rp: { name: '402 Claim', id: url.hostname },
          user: {
            id: randomBytes(16).toString('base64url'),
            name: 'wallet-owner',
            displayName: 'Wallet Owner',
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          timeout: 60000,
          attestation: 'direct',
        },
      });
    } catch (e) {
      return fail(c, (e as Error).message, 500);
    }
  });

  app.post('/api/claim/passkey/verify', async (c) => {
    try {
      const { token, attestation } = await c.req.json().catch(() => ({}));
      const s = typeof token === 'string' ? sessionFromToken(token) : null;
      if (!s) return fail(c, 'invalid or expired claim link', 404);
      if (s.status !== 'issued') return fail(c, `wrong step: ${s.status}`, 409);
      const challenge = challenges.get(s.sid);
      if (!challenge) return fail(c, 'no challenge issued — call passkey/options first', 409);
      const att = attestation as PasskeyAttestation;
      if (!att?.credentialId || !att?.attestationObject || !att?.clientDataJson) {
        return fail(c, 'malformed attestation', 400);
      }
      const w = { subOrgId: s.sub_org_id, walletId: '', address: s.wallet_address, userId: '' };
      const { credentialId } = await provisioner.registerPasskey(w, att, challenge);
      challenges.delete(s.sid);
      const updated = db.advance(s.sid, 'passkey_registered', { passkey_credential_id: credentialId });
      return json(c, { ok: true, status: updated.status });
    } catch (e) {
      return fail(c, (e as Error).message, 500);
    }
  });

  /** Run the export. The words are shown ONLY on the user's screen — the server never logs them. */
  app.post('/api/claim/export', async (c) => {
    try {
      const { token } = await c.req.json().catch(() => ({}));
      const s = typeof token === 'string' ? sessionFromToken(token) : null;
      if (!s) return fail(c, 'invalid or expired claim link', 404);
      // Strict in live (words show once). Demo tolerates a refresh mid-ceremony.
      const reexport = config.mode === 'demo' && s.status === 'exported';
      if (s.status !== 'passkey_registered' && !reexport) return fail(c, `wrong step: ${s.status}`, 409);
      const w = { subOrgId: s.sub_org_id, walletId: '', address: s.wallet_address, userId: '' };
      // Demo: same words for the whole ceremony (back button / refresh keep working).
      let words = config.mode === 'demo' ? demoWordsCache.get(s.sid) : undefined;
      if (!words) {
        ({ words } = await provisioner.exportMnemonic(w));
        if (config.mode === 'demo') demoWordsCache.set(s.sid, words);
      }
      const updated = reexport ? s : db.advance(s.sid, 'exported');
      return json(c, { ok: true, status: updated.status, words });
    } catch (e) {
      return fail(c, (e as Error).message, 500);
    }
  });

  /** User confirms the words are written down. ONLY now is the deposit address revealed. */
  app.post('/api/claim/backup-confirm', async (c) => {
    try {
      const { token, confirmed } = await c.req.json().catch(() => ({}));
      const s = typeof token === 'string' ? sessionFromToken(token) : null;
      if (!s) return fail(c, 'invalid or expired claim link', 404);
      if (s.status !== 'exported') return fail(c, `wrong step: ${s.status}`, 409);
      if (confirmed !== true) return fail(c, 'pass confirmed=true only after writing the words down', 400);
      db.advance(s.sid, 'backup_confirmed');
      const done = db.advance(s.sid, 'complete');
      return json(c, {
        ok: true,
        status: done.status,
        deposit_address: s.wallet_address,
        note: 'Backup recorded. This is your deposit address — fund it to start trading.',
      });
    } catch (e) {
      return fail(c, (e as Error).message, 500);
    }
  });

  return app;
}

/** Standalone wiring: config + db + provisioner -> app. */
export function buildClaimDeps(config?: ClaimConfig): { app: Hono; db: ClaimDb; config: ClaimConfig } {
  const cfg = config ?? loadClaimConfig();
  const db = new ClaimDb(cfg.dbPath);
  const signer =
    cfg.mode === 'live'
      ? new TurnkeySigner({
          orgId: cfg.turnkeyOrgId!,
          apiPublicKey: cfg.turnkeyApiPublicKey!,
          apiPrivateKeyHex: cfg.turnkeyApiPrivateKey!,
        })
      : undefined;
  const provisioner = createProvisioner({
    mode: cfg.mode,
    signer,
  });
  return { app: createClaimApp({ config: cfg, db, provisioner }), db, config: cfg };
}
