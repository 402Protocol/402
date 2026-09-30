/**
 * Claim-link tokens. A claim link is a bearer token: whoever opens it first
 * can claim the wallet. Mitigations (spec): the wallet is empty and reveals
 * no deposit address until backup is confirmed, so a stolen link buys the
 * attacker an empty wallet — the owner just provisions a fresh one.
 *
 * Token format: base64url(payload) + "." + base64url(hmac_sha256(payload)).
 * Payload JSON: { sid, exp } where sid is the session id.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ClaimPayload {
  sid: string;
  exp: number; // unix seconds
}

export function issueClaimToken(secret: string, sid: string, ttlSeconds: number): string {
  const payload: ClaimPayload = { sid, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Returns the payload, or null when the token is forged, malformed, or expired. */
export function verifyClaimToken(secret: string, token: string): ClaimPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: ClaimPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.sid !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
