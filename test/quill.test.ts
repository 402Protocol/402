/**
 * Quill X poster tests.
 *
 *   npx tsx test/quill.test.ts
 *
 * Covers: authorize-URL builder, PKCE challenge generation, token-exchange
 * and refresh request shapes (mock fetch), the 280-char guard, dry-run
 * default, token file save/load + auto-refresh, and the HTTP routes
 * (/oauth/start, /oauth/callback, /post, /status) including the secret
 * redaction on /status.
 *
 * No live network calls (fetch is injected everywhere). No secrets.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthorizeUrl,
  codeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateState,
  quillXConfigFromEnv,
  refreshAccessToken,
  QUILL_X_SCOPES,
  X_AUTHORIZE_URL,
  X_TOKEN_URL,
} from '../src/quill/oauth.js';
import {
  defaultTokenPath,
  getValidAccessToken,
  loadStoredTokens,
  saveStoredTokens,
  tokenSetToStored,
} from '../src/quill/tokens.js';
import {
  MAX_TWEET_CHARS,
  postTweet,
  TweetTooLongError,
  tweetLength,
  X_TWEETS_URL,
} from '../src/quill/poster.js';
import { createQuillHttpApp } from '../src/quill/http.js';

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

/** Mock fetch: records calls, serves canned JSON responses. */
function mockFetch() {
  const calls: { url: string; init: any }[] = [];
  let responder: (url: string, init: any) => any = () => ({ ok: true });
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const body = responder(String(url), init);
    return {
      ok: body.ok !== false,
      status: body.status ?? 200,
      json: async () => body.json ?? {},
      text: async () => body.text ?? '',
    };
  }) as typeof fetch;
  return {
    fn,
    calls,
    respondWith: (r: (url: string, init: any) => any) => {
      responder = r;
    },
  };
}

const CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://402-production.up.railway.app/quill/oauth/callback',
};

const TOKENS = {
  access_token: 'AT-123',
  token_type: 'bearer',
  expires_in: 7200,
  refresh_token: 'RT-456',
  scope: [...QUILL_X_SCOPES].join(' '),
};

// ---------- oauth.ts ----------

await check('authorize URL carries required params', () => {
  const verifier = generateCodeVerifier();
  const url = new URL(
    buildAuthorizeUrl({
      config: CONFIG,
      state: 's3cr3t-state',
      challenge: codeChallenge(verifier),
    }),
  );
  assert.equal(url.origin + url.pathname, X_AUTHORIZE_URL);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), CONFIG.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(url.searchParams.get('state'), 's3cr3t-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    codeChallenge(verifier),
  );
  const scopes = url.searchParams.get('scope')!.split(' ');
  for (const s of ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write']) {
    assert.ok(scopes.includes(s), `missing scope ${s}`);
  }
});

await check('PKCE challenge is base64url(sha256(verifier))', () => {
  const verifier = generateCodeVerifier();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  const expected = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(codeChallenge(verifier), expected);
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
  assert.notEqual(generateState(), generateState());
});

await check('quillXConfigFromEnv reads env, null when missing', () => {
  const saved = {
    id: process.env.QUILL_X_CLIENT_ID,
    secret: process.env.QUILL_X_CLIENT_SECRET,
    uri: process.env.QUILL_X_REDIRECT_URI,
  };
  delete process.env.QUILL_X_CLIENT_ID;
  delete process.env.QUILL_X_CLIENT_SECRET;
  assert.equal(quillXConfigFromEnv(), null);
  process.env.QUILL_X_CLIENT_ID = 'cid';
  process.env.QUILL_X_CLIENT_SECRET = 'csecret';
  assert.equal(quillXConfigFromEnv()!.redirectUri, 'https://402-production.up.railway.app/quill/oauth/callback');
  process.env.QUILL_X_REDIRECT_URI = 'http://localhost:9999/cb';
  assert.equal(quillXConfigFromEnv()!.redirectUri, 'http://localhost:9999/cb');
  if (saved.id !== undefined) process.env.QUILL_X_CLIENT_ID = saved.id; else delete process.env.QUILL_X_CLIENT_ID;
  if (saved.secret !== undefined) process.env.QUILL_X_CLIENT_SECRET = saved.secret; else delete process.env.QUILL_X_CLIENT_SECRET;
  if (saved.uri !== undefined) process.env.QUILL_X_REDIRECT_URI = saved.uri; else delete process.env.QUILL_X_REDIRECT_URI;
});

await check('exchangeCodeForTokens posts the right form', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ json: TOKENS }));
  const out = await exchangeCodeForTokens({
    fetchFn: m.fn,
    config: CONFIG,
    code: 'auth-code-xyz',
    codeVerifier: 'verifier-abc',
  });
  assert.equal(out.access_token, 'AT-123');
  assert.equal(m.calls.length, 1);
  const { url, init } = m.calls[0];
  assert.equal(url, X_TOKEN_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  const wantBasic =
    'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64');
  assert.equal(init.headers.authorization, wantBasic);
  const body = new URLSearchParams(init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code-xyz');
  assert.equal(body.get('code_verifier'), 'verifier-abc');
  assert.equal(body.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(body.get('client_id'), CONFIG.clientId);
});

await check('exchangeCodeForTokens throws on non-ok', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ ok: false, status: 400, text: 'invalid_grant' }));
  await assert.rejects(
    () =>
      exchangeCodeForTokens({
        fetchFn: m.fn,
        config: CONFIG,
        code: 'bad',
        codeVerifier: 'v',
      }),
    /HTTP 400/,
  );
});

await check('refreshAccessToken posts refresh_token grant', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ json: { ...TOKENS, access_token: 'AT-789' } }));
  const out = await refreshAccessToken({
    fetchFn: m.fn,
    config: CONFIG,
    refreshToken: 'RT-456',
  });
  assert.equal(out.access_token, 'AT-789');
  const body = new URLSearchParams(m.calls[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'RT-456');
  assert.equal(body.get('client_id'), CONFIG.clientId);
});

// ---------- poster.ts ----------

await check('280-char guard: 280 ok, 281 rejected', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ json: { data: { id: '111' } } }));
  assert.equal(tweetLength('a'.repeat(280)), 280);
  const r = await postTweet({
    fetchFn: m.fn,
    accessToken: 'AT',
    text: 'a'.repeat(280),
    dryRun: false,
  });
  assert.equal(r.tweetId, '111');
  await assert.rejects(
    () =>
      postTweet({
        fetchFn: m.fn,
        accessToken: 'AT',
        text: 'a'.repeat(281),
        dryRun: false,
      }),
    TweetTooLongError,
  );
  assert.equal(MAX_TWEET_CHARS, 280);
});

await check('length counts code points, not UTF-16 units', () => {
  assert.equal(tweetLength('🪶'.repeat(140)), 140);
  assert.equal(tweetLength('🪶'.repeat(281)), 281);
});

await check('dryRun is the default: nothing sent', async () => {
  const m = mockFetch();
  const r = await postTweet({ fetchFn: m.fn, accessToken: 'AT', text: 'hello' });
  assert.equal(r.dryRun, true);
  assert.equal(r.posted, false);
  assert.equal(r.tweetId, null);
  assert.equal(m.calls.length, 0);
});

await check('real post uses bearer + { text }', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ json: { data: { id: '222' } } }));
  const r = await postTweet({
    fetchFn: m.fn,
    accessToken: 'AT-123',
    text: 'hello ink',
    dryRun: false,
  });
  assert.equal(r.posted, true);
  assert.equal(m.calls.length, 1);
  const { url, init } = m.calls[0];
  assert.equal(url, X_TWEETS_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer AT-123');
  assert.deepEqual(JSON.parse(init.body), { text: 'hello ink' });
});

await check('replyTo adds reply.in_reply_to_tweet_id', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ json: { data: { id: '333' } } }));
  const r = await postTweet({
    fetchFn: m.fn,
    accessToken: 'AT',
    text: 'ughhh you are right',
    dryRun: false,
    replyToTweetId: '2107222633427111975',
  });
  assert.equal(r.posted, true);
  assert.deepEqual(JSON.parse(m.calls[0].init.body), {
    text: 'ughhh you are right',
    reply: { in_reply_to_tweet_id: '2107222633427111975' },
  });
});

// ---------- tokens.ts ----------

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quill-test-'));
  return join(dir, 'quill-tokens.json');
}

await check('defaultTokenPath: env override wins', () => {
  const prev = process.env.QUILL_X_TOKEN_PATH;
  process.env.QUILL_X_TOKEN_PATH = '/data/custom-tokens.json';
  assert.equal(defaultTokenPath(), '/data/custom-tokens.json');
  if (prev === undefined) delete process.env.QUILL_X_TOKEN_PATH;
  else process.env.QUILL_X_TOKEN_PATH = prev;
});

await check('token file save/load roundtrip, mode 0600', () => {  const path = tmpPath();
  const stored = {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    expires_at_ms: Date.now() + 3600_000,
    obtained_at_ms: Date.now(),
  };
  saveStoredTokens(stored, path);
  assert.deepEqual(loadStoredTokens(path), stored);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(loadStoredTokens(path + '.missing'), null);
});

await check('tokenSetToStored requires a refresh token', () => {
  assert.throws(
    () => tokenSetToStored({ ...TOKENS, refresh_token: undefined } as any, Date.now()),
    /refresh_token/,
  );
  const s = tokenSetToStored(TOKENS, 1_000_000);
  assert.equal(s.expires_at_ms, 1_000_000 + 7200 * 1000);
});

await check('getValidAccessToken: fresh token, no network', async () => {
  const m = mockFetch();
  const path = tmpPath();
  saveStoredTokens(
    {
      access_token: 'AT-fresh',
      refresh_token: 'RT-x',
      expires_at_ms: Date.now() + 3600_000,
      obtained_at_ms: Date.now(),
    },
    path,
  );
  const at = await getValidAccessToken({
    fetchFn: m.fn,
    config: CONFIG,
    path,
  });
  assert.equal(at, 'AT-fresh');
  assert.equal(m.calls.length, 0);
});

await check('getValidAccessToken: expired token triggers refresh + save', async () => {
  const m = mockFetch();
  m.respondWith(() => ({ json: { ...TOKENS, access_token: 'AT-new' } }));
  const path = tmpPath();
  saveStoredTokens(
    {
      access_token: 'AT-old',
      refresh_token: 'RT-old',
      expires_at_ms: Date.now() - 1000,
      obtained_at_ms: Date.now() - 7201_000,
    },
    path,
  );
  const at = await getValidAccessToken({
    fetchFn: m.fn,
    config: CONFIG,
    path,
  });
  assert.equal(at, 'AT-new');
  assert.equal(m.calls.length, 1);
  assert.equal(loadStoredTokens(path)!.access_token, 'AT-new');
});

await check('getValidAccessToken: null when nothing stored', async () => {
  const m = mockFetch();
  const at = await getValidAccessToken({
    fetchFn: m.fn,
    config: CONFIG,
    path: tmpPath() + '-nope.json',
  });
  assert.equal(at, null);
  assert.equal(m.calls.length, 0);
});

// ---------- http.ts ----------

const savedEnv = {
  id: process.env.QUILL_X_CLIENT_ID,
  secret: process.env.QUILL_X_CLIENT_SECRET,
  uri: process.env.QUILL_X_REDIRECT_URI,
};
function clearXEnv() {
  delete process.env.QUILL_X_CLIENT_ID;
  delete process.env.QUILL_X_CLIENT_SECRET;
  delete process.env.QUILL_X_REDIRECT_URI;
}
function setXEnv() {
  process.env.QUILL_X_CLIENT_ID = CONFIG.clientId;
  process.env.QUILL_X_CLIENT_SECRET = CONFIG.clientSecret;
}

await check('GET /status reports unconfigured, no secrets', async () => {
  clearXEnv();
  const app = createQuillHttpApp({ tokenPath: tmpPath() + '-x.json' });
  const res = await app.request('/status');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.configured, false);
  assert.equal(body.authorized, false);
  assert.equal(body.expiresAt, null);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('test-client-secret'));
});

await check('GET /oauth/start 503s when unconfigured', async () => {
  clearXEnv();
  const app = createQuillHttpApp();
  const res = await app.request('/oauth/start');
  assert.equal(res.status, 503);
});

await check('GET /oauth/callback rejects unknown state', async () => {
  setXEnv();
  const app = createQuillHttpApp({ tokenPath: tmpPath() + '-y.json' });
  const res = await app.request('/oauth/callback?code=abc&state=nope');
  assert.equal(res.status, 400);
});

await check('OAuth roundtrip: start -> callback stores tokens', async () => {
  setXEnv();
  const m = mockFetch();
  m.respondWith(() => ({ json: TOKENS }));
  const path = tmpPath();
  const app = createQuillHttpApp({ fetchFn: m.fn, tokenPath: path });

  const start = await app.request('/oauth/start');
  assert.equal(start.status, 302);
  const location = start.headers.get('location')!;
  assert.ok(location.startsWith(X_AUTHORIZE_URL));
  const state = new URL(location).searchParams.get('state')!;
  assert.ok(state.length > 10);

  const cb = await app.request(
    `/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
  );
  assert.equal(cb.status, 200);
  assert.ok((await cb.text()).includes('Quill is connected'));

  const stored = loadStoredTokens(path)!;
  assert.equal(stored.access_token, 'AT-123');
  assert.equal(stored.refresh_token, 'RT-456');
  assert.ok(stored.expires_at_ms > Date.now());

  // Replaying the same state fails (single-use).
  const replay = await app.request(
    `/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
  );
  assert.equal(replay.status, 400);
});

await check('POST /post: 503 without tokens, dry-run default, real post shape', async () => {
  setXEnv();
  const m = mockFetch();
  const path = tmpPath();
  const app = createQuillHttpApp({ fetchFn: m.fn, tokenPath: path });

  // No tokens yet -> 503.
  let res = await app.request('/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'gm ink' }),
  });
  assert.equal(res.status, 503);

  // Seed valid tokens directly.
  saveStoredTokens(
    {
      access_token: 'AT-seed',
      refresh_token: 'RT-seed',
      expires_at_ms: Date.now() + 3600_000,
      obtained_at_ms: Date.now(),
    },
    path,
  );

  // Dry-run default: validated, nothing sent.
  res = await app.request('/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'gm ink' }),
  });
  assert.equal(res.status, 200);
  const dry = (await res.json()) as any;
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.posted, false);
  assert.equal(m.calls.length, 0);

  // Explicit dryRun: false -> real POST to X.
  m.respondWith(() => ({ json: { data: { id: 'tweet-1' } } }));
  res = await app.request('/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'gm ink', dryRun: false }),
  });
  assert.equal(res.status, 200);
  const live = (await res.json()) as any;
  assert.equal(live.posted, true);
  assert.equal(live.tweetId, 'tweet-1');
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, X_TWEETS_URL);
  assert.equal(m.calls[0].init.headers.authorization, 'Bearer AT-seed');
});

await check('POST /post: 400 on empty text and overlong text', async () => {
  setXEnv();
  const m = mockFetch();
  const path = tmpPath();
  saveStoredTokens(
    {
      access_token: 'AT-seed',
      refresh_token: 'RT-seed',
      expires_at_ms: Date.now() + 3600_000,
      obtained_at_ms: Date.now(),
    },
    path,
  );
  const app = createQuillHttpApp({ fetchFn: m.fn, tokenPath: path });
  const post = (body: any) =>
    app.request('/post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ text: '   ' })).status, 400);
  assert.equal((await post({ text: 'x'.repeat(281) })).status, 400);
  assert.equal(m.calls.length, 0);
});

await check('GET /status after auth: authorized, expiry, still no secrets', async () => {
  setXEnv();
  const path = tmpPath();
  saveStoredTokens(
    {
      access_token: 'AT-secret-value',
      refresh_token: 'RT-secret-value',
      expires_at_ms: Date.now() + 3600_000,
      obtained_at_ms: Date.now(),
    },
    path,
  );
  const app = createQuillHttpApp({ tokenPath: path });
  const res = await app.request('/status');
  const body = (await res.json()) as any;
  assert.equal(body.configured, true);
  assert.equal(body.authorized, true);
  assert.ok(body.expiresInSec > 3500);
  assert.ok(!JSON.stringify(body).includes('AT-secret-value'));
  assert.ok(!JSON.stringify(body).includes('RT-secret-value'));
});

// Restore the environment the way we found it.
if (savedEnv.id !== undefined) process.env.QUILL_X_CLIENT_ID = savedEnv.id;
else delete process.env.QUILL_X_CLIENT_ID;
if (savedEnv.secret !== undefined) process.env.QUILL_X_CLIENT_SECRET = savedEnv.secret;
else delete process.env.QUILL_X_CLIENT_SECRET;
if (savedEnv.uri !== undefined) process.env.QUILL_X_REDIRECT_URI = savedEnv.uri;
else delete process.env.QUILL_X_REDIRECT_URI;

console.log(`\nquill: ${passed} checks passed`);
