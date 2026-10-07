/**
 * Quill X poster HTTP surface.
 *
 * Routes (mounted at /quill in the facilitator):
 *   GET  /quill/oauth/start     redirect to X's authorize URL (PKCE + state)
 *   GET  /quill/oauth/callback  ?code=&state= → exchange, store tokens,
 *                                plain success page (never shows secrets)
 *   POST /quill/post            { text, dryRun, replyTo, quoteTweetId } — dryRun defaults
 *                                true; real posts need an explicit
 *                                dryRun: false; replyTo is an optional
 *                                tweet id to reply to
 *   GET  /quill/status          configured? authorized? expiry? (no secrets)
 *
 * Safety properties:
 *   - Tokens live in state/quill-tokens.json (gitignored, mode 0600) and are
 *     never logged or returned by any route.
 *   - /post refuses with 503 until the OAuth flow has completed once.
 *   - The OAuth `state` is validated against a server-side pending map, so a
 *     forged callback cannot inject an attacker's code.
 *   - Posting is dry-run-first: nothing reaches X unless the caller passes
 *     dryRun: false explicitly. Human approval of real posts lives here.
 */
import { Hono } from 'hono';
import {
  buildAuthorizeUrl,
  codeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateState,
  quillXConfigFromEnv,
  type QuillXConfig,
} from './oauth.js';
import {
  defaultTokenPath,
  getValidAccessToken,
  loadStoredTokens,
  saveStoredTokens,
  tokenSetToStored,
} from './tokens.js';
import {
  postTweet,
  TweetTooLongError,
  tweetLength,
} from './poster.js';

export interface QuillHttpOptions {
  fetchFn?: typeof fetch;
  /** Token file path (injectable for tests). Defaults to state/quill-tokens.json. */
  tokenPath?: string;
  /** Pending OAuth states live 10 minutes. */
  stateTtlMs?: number;
}

const DEFAULT_STATE_TTL_MS = 10 * 60_000;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createQuillHttpApp(opts: QuillHttpOptions = {}): Hono {
  const fetchFn = opts.fetchFn ?? fetch;
  const tokenPath = opts.tokenPath ?? defaultTokenPath();
  const stateTtlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  const app = new Hono();

  /** state -> { codeVerifier, createdAt }: proves the callback is ours. */
  const pending = new Map<string, { codeVerifier: string; createdAt: number }>();

  function prunePending(nowMs: number): void {
    for (const [state, entry] of pending) {
      if (nowMs - entry.createdAt > stateTtlMs) pending.delete(state);
    }
  }

  // Step 1 of OAuth: redirect the browser to X's authorize page.
  app.get('/oauth/start', (c) => {
    const config = quillXConfigFromEnv();
    if (!config) {
      return c.json(
        {
          ok: false,
          error:
            'not configured (set QUILL_X_CLIENT_ID and QUILL_X_CLIENT_SECRET)',
        },
        503,
      );
    }
    prunePending(Date.now());
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    pending.set(state, { codeVerifier, createdAt: Date.now() });
    const url = buildAuthorizeUrl({
      config,
      state,
      challenge: codeChallenge(codeVerifier),
    });
    return c.redirect(url);
  });

  // Step 2 of OAuth: X redirects here with ?code=&state=. Validate the state,
  // exchange the code, persist the tokens, show a plain confirmation page.
  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const entry = state ? pending.get(state) : undefined;
    if (state) pending.delete(state);
    if (!code || !entry) {
      return c.text(
        'OAuth failed: missing or unknown state. Start again at /quill/oauth/start.',
        400,
      );
    }
    let config: QuillXConfig | null = null;
    try {
      config = quillXConfigFromEnv();
      if (!config) throw new Error('server not configured');
      const tokens = await exchangeCodeForTokens({
        fetchFn,
        config,
        code,
        codeVerifier: entry.codeVerifier,
      });
      saveStoredTokens(tokenSetToStored(tokens, Date.now()), tokenPath);
    } catch (e) {
      // Never echo tokens or the client secret; the message is safe to show.
      return c.text(`OAuth failed: ${errMessage(e)}`, 502);
    }
    return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Quill connected</title></head>
<body style="font-family: monospace; background: #0a0a0a; color: #e8e8e8; padding: 48px;">
<h1>🪶 Quill is connected to X</h1>
<p>Tokens are stored server-side. You can close this tab.</p>
<p><a href="/quill/status" style="color: #39ff6a;">Check status</a></p>
</body></html>`);
  });

  // Post a tweet. Dry-run is the default: the payload is validated and
  // returned, nothing is sent to X. Pass dryRun: false for a real post.
  // Optional replyTo: tweet id to reply to. Optional quoteTweetId: tweet id
  // to quote tweet.
  app.post('/post', async (c) => {
    let body: { text?: unknown; dryRun?: unknown; replyTo?: unknown; quoteTweetId?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return c.json({ ok: false, error: 'text is required' }, 400);
    }
    const replyToTweetId =
      typeof body.replyTo === 'string' && body.replyTo.trim()
        ? body.replyTo.trim()
        : undefined;
    const quoteTweetId =
      typeof body.quoteTweetId === 'string' && body.quoteTweetId.trim()
        ? body.quoteTweetId.trim()
        : undefined;
    const dryRun = body.dryRun !== false;
    const config = quillXConfigFromEnv();
    if (!config) {
      return c.json(
        {
          ok: false,
          error:
            'not configured (set QUILL_X_CLIENT_ID and QUILL_X_CLIENT_SECRET)',
        },
        503,
      );
    }
    let accessToken: string | null;
    try {
      accessToken = await getValidAccessToken({ fetchFn, config, path: tokenPath });
    } catch (e) {
      return c.json({ ok: false, error: `token refresh failed: ${errMessage(e)}` }, 502);
    }
    if (!accessToken) {
      return c.json(
        { ok: false, error: 'not authorized (visit /quill/oauth/start)' },
        503,
      );
    }
    try {
      const result = await postTweet({ fetchFn, accessToken, text, dryRun, replyToTweetId, quoteTweetId });
      return c.json(result);
    } catch (e) {
      if (e instanceof TweetTooLongError) {
        return c.json(
          { ok: false, error: e.message, length: tweetLength(text) },
          400,
        );
      }
      return c.json({ ok: false, error: errMessage(e) }, 502);
    }
  });

  // Token presence + expiry. Never returns secret values.
  app.get('/status', (c) => {
    const configured = quillXConfigFromEnv() !== null;
    const stored = loadStoredTokens(tokenPath);
    const nowMs = Date.now();
    return c.json({
      ok: true,
      configured,
      authorized: stored !== null,
      expiresAt: stored ? new Date(stored.expires_at_ms).toISOString() : null,
      expiresInSec: stored
        ? Math.max(0, Math.round((stored.expires_at_ms - nowMs) / 1000))
        : null,
    });
  });

  return app;
}
