/**
 * Quill X OAuth 2.0 (Authorization Code Flow with PKCE).
 *
 * Pure helpers for the @quill_fourzero automation. No secrets are hardcoded:
 * client id/secret come from the environment (QUILL_X_CLIENT_ID,
 * QUILL_X_CLIENT_SECRET); the founder puts them in the Secure Vault.
 *
 * Flow:
 *   1. GET /quill/oauth/start builds an authorize URL (buildAuthorizeUrl)
 *      with a fresh PKCE verifier + challenge and a random state.
 *   2. X redirects back to /quill/oauth/callback?code=...&state=...
 *   3. exchangeCodeForTokens swaps the code for access + refresh tokens.
 *   4. refreshAccessToken rotates an expired access token (offline.access).
 *
 * Endpoints (X API v2):
 *   authorize: https://x.com/i/oauth2/authorize
 *   token:     https://api.x.com/2/oauth2/token
 */
import { createHash, randomBytes } from 'node:crypto';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/** Scopes Quill needs: read own data, post, keep a refresh token, upload media. */
export const QUILL_X_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access',
  'media.write',
] as const;

/** Default redirect URI — register exactly this in the X developer portal. */
export const DEFAULT_REDIRECT_URI =
  'https://402-production.up.railway.app/quill/oauth/callback';

export interface QuillXConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Read the X app config from the environment. Returns null when the client
 * id/secret are missing — callers must 503, never proceed unauthenticated.
 */
export function quillXConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): QuillXConfig | null {
  const clientId = (env.QUILL_X_CLIENT_ID ?? '').trim();
  const clientSecret = (env.QUILL_X_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    (env.QUILL_X_REDIRECT_URI ?? '').trim() || DEFAULT_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri };
}

/** PKCE code verifier: 43-128 URL-safe chars (64 random bytes => ~86 chars). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(64));
}

/** S256 code challenge: base64url(sha256(verifier)). */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Opaque OAuth state for CSRF protection. */
export function generateState(): string {
  return base64url(randomBytes(32));
}

function base64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface AuthorizeUrlArgs {
  config: QuillXConfig;
  state: string;
  challenge: string;
}

/** Build the X authorize URL the user is redirected to. */
export function buildAuthorizeUrl({
  config,
  state,
  challenge,
}: AuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: [...QUILL_X_SCOPES].join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${X_AUTHORIZE_URL}?${params.toString()}`;
}

export interface TokenSet {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

type FetchFn = typeof fetch;

export interface ExchangeArgs {
  fetchFn?: FetchFn;
  config: QuillXConfig;
  code: string;
  codeVerifier: string;
}

function basicAuth(config: QuillXConfig): string {
  return (
    'Basic ' +
    Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
  );
}

async function postTokenForm(
  fetchFn: FetchFn,
  config: QuillXConfig,
  params: Record<string, string>,
): Promise<TokenSet> {
  const res = await fetchFn(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(config),
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `x token endpoint: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }
  return (await res.json()) as TokenSet;
}

/** Swap an authorization code for access + refresh tokens. */
export async function exchangeCodeForTokens({
  fetchFn = fetch,
  config,
  code,
  codeVerifier,
}: ExchangeArgs): Promise<TokenSet> {
  return postTokenForm(fetchFn, config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
    client_id: config.clientId,
  });
}

export interface RefreshArgs {
  fetchFn?: FetchFn;
  config: QuillXConfig;
  refreshToken: string;
}

/** Rotate an expired access token using the stored refresh token. */
export async function refreshAccessToken({
  fetchFn = fetch,
  config,
  refreshToken,
}: RefreshArgs): Promise<TokenSet> {
  return postTokenForm(fetchFn, config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
}
