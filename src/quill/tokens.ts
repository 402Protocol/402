/**
 * Quill X token storage.
 *
 * Access + refresh tokens live in a single JSON file. The path is
 * QUILL_X_TOKEN_PATH when set, otherwise /data/quill-tokens.json when /data
 * exists (Railway: persists across deploys), otherwise
 * <cwd>/state/quill-tokens.json (local dev, gitignored). The file is
 * written with mode 0600. Secrets are never logged and never returned to
 * callers — getValidAccessToken hands out only the access token string
 * after refreshing it when needed.
 *
 * Shape on disk:
 *   { access_token, refresh_token, expires_at_ms, obtained_at_ms }
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  refreshAccessToken,
  type QuillXConfig,
  type TokenSet,
} from './oauth.js';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
  obtained_at_ms: number;
}

/** Refresh a little before the real expiry so a slow post never 401s. */
const REFRESH_SKEW_MS = 60_000;

export function defaultTokenPath(): string {
  const fromEnv = process.env.QUILL_X_TOKEN_PATH;
  if (fromEnv) return fromEnv;
  // /data persists across Railway deploys; the working directory does not.
  if (existsSync('/data')) return '/data/quill-tokens.json';
  return join(process.cwd(), 'state', 'quill-tokens.json');
}

/** Read stored tokens. Null when the file is missing or unparseable. */
export function loadStoredTokens(
  path: string = defaultTokenPath(),
): StoredTokens | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredTokens>;
    if (
      typeof parsed.access_token !== 'string' ||
      typeof parsed.refresh_token !== 'string' ||
      typeof parsed.expires_at_ms !== 'number'
    ) {
      return null;
    }
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at_ms: parsed.expires_at_ms,
      obtained_at_ms:
        typeof parsed.obtained_at_ms === 'number' ? parsed.obtained_at_ms : 0,
    };
  } catch {
    return null;
  }
}

/** Persist tokens. Directory is created; file mode is 0600. */
export function saveStoredTokens(
  tokens: StoredTokens,
  path: string = defaultTokenPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function tokenSetToStored(tokens: TokenSet, nowMs: number): StoredTokens {
  if (!tokens.refresh_token) {
    throw new Error('x token response missing refresh_token');
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at_ms: nowMs + tokens.expires_in * 1000,
    obtained_at_ms: nowMs,
  };
}

export interface ValidTokenArgs {
  fetchFn?: typeof fetch;
  config: QuillXConfig;
  path?: string;
  nowMs?: number;
}

/**
 * Return a usable access token, refreshing it first when it is expired or
 * within the refresh skew. Returns null when no tokens are stored. Throws
 * when the refresh itself fails (caller surfaces a 502, never the secret).
 */
export async function getValidAccessToken({
  fetchFn = fetch,
  config,
  path = defaultTokenPath(),
  nowMs = Date.now(),
}: ValidTokenArgs): Promise<string | null> {
  const stored = loadStoredTokens(path);
  if (!stored) return null;
  if (stored.expires_at_ms - REFRESH_SKEW_MS > nowMs) {
    return stored.access_token;
  }
  const fresh = await refreshAccessToken({
    fetchFn,
    config,
    refreshToken: stored.refresh_token,
  });
  const next = tokenSetToStored(fresh, nowMs);
  saveStoredTokens(next, path);
  return next.access_token;
}
