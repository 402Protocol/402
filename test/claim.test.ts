/**
 * Claim-site tests: token crypto, session state machine, demo provisioner,
 * and the HTTP API (in-process, no network).
 *
 * Run: npx tsx test/claim.test.ts   (or: npm run test:claim)
 */
import assert from 'node:assert/strict';
import { issueClaimToken, verifyClaimToken } from '../src/claim/tokens.js';
import { ClaimDb } from '../src/claim/db.js';
import { createProvisioner, demoMnemonic } from '../src/claim/turnkey.js';
import { createClaimApp } from '../src/claim/server.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const SECRET = 'test-secret-min-16-chars!!';

// ---------- tokens ----------

await check('issue/verify round-trips', () => {
  const t = issueClaimToken(SECRET, 'sid-1', 3600);
  const p = verifyClaimToken(SECRET, t);
  assert.ok(p);
  assert.equal(p!.sid, 'sid-1');
});

await check('forged token fails', () => {
  const t = issueClaimToken(SECRET, 'sid-1', 3600);
  const forged = t.slice(0, -2) + 'xx';
  assert.equal(verifyClaimToken(SECRET, forged), null);
});

await check('wrong secret fails', () => {
  const t = issueClaimToken(SECRET, 'sid-1', 3600);
  assert.equal(verifyClaimToken('other-secret-min-16!!', t), null);
});

await check('expired token fails', () => {
  const t = issueClaimToken(SECRET, 'sid-1', -10);
  assert.equal(verifyClaimToken(SECRET, t), null);
});

await check('malformed token fails', () => {
  assert.equal(verifyClaimToken(SECRET, 'not-a-token'), null);
  assert.equal(verifyClaimToken(SECRET, ''), null);
});

// ---------- state machine ----------

await check('claim transitions advance one step at a time', () => {
  const db = new ClaimDb(':memory:');
  const sid = db.createSession({
    token: 'tok', subOrgId: 'so', walletAddress: '0xabc', walletAccount: '0xabc', ttlSeconds: 60,
  });
  assert.throws(() => db.advance(sid, 'exported'), /illegal claim transition/);
  let s = db.advance(sid, 'passkey_registered', { passkey_credential_id: 'cred-1' });
  assert.equal(s.status, 'passkey_registered');
  assert.equal(s.passkey_credential_id, 'cred-1');
  s = db.advance(sid, 'exported');
  assert.equal(s.status, 'exported');
  s = db.advance(sid, 'backup_confirmed');
  assert.equal(s.status, 'backup_confirmed');
  s = db.advance(sid, 'complete');
  assert.equal(s.status, 'complete');
  assert.ok(s.completed_at);
  assert.throws(() => db.advance(sid, 'issued'), /illegal claim transition/);
  db.close();
});

await check('sessions resolve by token hash, never the raw token', () => {
  const db = new ClaimDb(':memory:');
  const sid = db.createSession({
    token: 'tok', subOrgId: 'so', walletAddress: '0xabc', walletAccount: '0xabc', ttlSeconds: 60,
  });
  const s = db.getSessionByToken('tok');
  assert.ok(s);
  assert.equal(s!.sid, sid);
  assert.equal(db.getSessionByToken('nope'), null);
  db.close();
});

// ---------- demo provisioner ----------

await check('demo provisioner makes plausible objects', async () => {
  const p = createProvisioner({ mode: 'demo' });
  const w = await p.provisionWallet('lbl');
  assert.match(w.address, /^0x[0-9a-f]{40}$/);
  assert.ok(w.subOrgId.startsWith('demo-sub-org-'));
  const { credentialId } = await p.registerPasskey(w, {
    credentialId: 'cred', clientDataJson: 'cdj', attestationObject: 'ao',
  }, 'challenge');
  assert.equal(credentialId, 'cred');
  const { words } = await p.exportMnemonic(w);
  assert.equal(words.length, 12);
  assert.ok(words.every((x) => typeof x === 'string' && x.length > 0));
});

await check('demo mnemonic draws 12 real BIP39 words', () => {
  const words = demoMnemonic();
  assert.equal(words.length, 12);
  assert.ok(new Set(words).size >= 10, 'should be near-all-unique');
});

// ---------- HTTP API ----------

function buildTestApp() {
  const db = new ClaimDb(':memory:');
  const app = createClaimApp({
    config: {
      mode: 'demo',
      hmacSecret: SECRET,
      dbPath: ':memory:',
      port: 0,
      linkTtlSeconds: 3600,
      mcpUrl: '',
    },
    db,
    provisioner: createProvisioner({ mode: 'demo' }),
  });
  return { app, db };
}

async function post(app: any, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

await check('full ceremony via HTTP: issue -> validate -> options -> verify -> export -> confirm', async () => {
  const { app, db } = buildTestApp();

  const issued = await post(app, '/api/claim/issue', {});
  assert.equal(issued.status, 200);
  assert.ok(issued.body.ok);
  const claimUrl: string = issued.body.claim_url;
  const token = claimUrl.split('/').pop()!;
  assert.ok(token.includes('.'));

  const v0 = await post(app, '/api/claim/validate', { token });
  assert.equal(v0.body.status, 'issued');

  // export before passkey: refused
  const early = await post(app, '/api/claim/export', { token });
  assert.equal(early.status, 409);

  const opts = await post(app, '/api/claim/passkey/options', { token });
  assert.ok(opts.body.ok);
  assert.equal(opts.body.options.rp.name, '402 Claim');
  assert.ok(opts.body.options.challenge);

  // verify without options challenge consumed twice: first ok
  const verify = await post(app, '/api/claim/passkey/verify', {
    token,
    attestation: { credentialId: 'cred-1', clientDataJson: 'cdj', attestationObject: 'ao' },
  });
  assert.ok(verify.body.ok, JSON.stringify(verify.body));
  assert.equal(verify.body.status, 'passkey_registered');

  // replay verify: wrong step now
  const replay = await post(app, '/api/claim/passkey/verify', {
    token,
    attestation: { credentialId: 'cred-1', clientDataJson: 'cdj', attestationObject: 'ao' },
  });
  assert.equal(replay.status, 409);

  const exp = await post(app, '/api/claim/export', { token });
  assert.ok(exp.body.ok);
  assert.equal(exp.body.words.length, 12);

  // confirm without confirmed=true: refused
  const noack = await post(app, '/api/claim/backup-confirm', { token, confirmed: false });
  assert.equal(noack.status, 400);

  const done = await post(app, '/api/claim/backup-confirm', { token, confirmed: true });
  assert.ok(done.body.ok);
  assert.equal(done.body.status, 'complete');
  assert.match(done.body.deposit_address, /^0x[0-9a-f]{40}$/);

  const v1 = await post(app, '/api/claim/validate', { token });
  assert.equal(v1.body.status, 'complete');
  db.close();
});

await check('bad token 404s on validate', async () => {
  const { app, db } = buildTestApp();
  const r = await post(app, '/api/claim/validate', { token: 'bogus.token' });
  assert.equal(r.status, 404);
  db.close();
});

await check('claim page 404s on dead link, serves on live link', async () => {
  const { app, db } = buildTestApp();
  const dead = await app.request('/claim/bogus.token');
  assert.equal(dead.status, 404);
  assert.match(await dead.text(), /LINK DEAD/);
  const issued = await post(app, '/api/claim/issue', {});
  const token = (issued.body.claim_url as string).split('/').pop()!;
  const live = await app.request(`/claim/${token}`);
  assert.equal(live.status, 200);
  assert.match(await live.text(), /CLAIM YOUR WALLET/);
  db.close();
});

await check('landing page serves', async () => {
  const { app, db } = buildTestApp();
  const r = await app.request('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /MINT DEMO CLAIM LINK/i);
  db.close();
});

await check('status endpoint: issued -> complete reveals address only at the end', async () => {
  const { app, db } = buildTestApp();
  const issued = await post(app, '/api/claim/issue', {});
  const token = (issued.body.claim_url as string).split('/').pop()!;
  let st = await post(app, '/api/claim/status', { token });
  assert.equal(st.status, 200);
  assert.equal(st.body.status, 'issued');
  assert.equal(st.body.backed_up, false);
  assert.equal(st.body.deposit_address, null);
  // Drive the state machine (the ceremony itself is tested separately).
  const s = db.getSessionByToken(token)!;
  db.advance(s.sid, 'passkey_registered', { passkey_credential_id: 'cred' });
  db.advance(s.sid, 'exported');
  st = await post(app, '/api/claim/status', { token });
  assert.equal(st.body.status, 'exported');
  assert.equal(st.body.deposit_address, null, 'no address before backup');
  db.advance(s.sid, 'backup_confirmed');
  db.advance(s.sid, 'complete');
  st = await post(app, '/api/claim/status', { token });
  assert.equal(st.body.status, 'complete');
  assert.equal(st.body.backed_up, true);
  assert.match(st.body.deposit_address, /^0x[0-9a-fA-F]{40}$/);
  const bad = await post(app, '/api/claim/status', { token: 'nope.nope' });
  assert.equal(bad.status, 404);
  db.close();
});

console.log(`\n${passed} checks passed`);
