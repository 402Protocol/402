/**
 * Claim-site configuration.
 *
 * Modes:
 *   demo (default) — the full ceremony runs with simulated Turnkey objects.
 *                    WebAuthn is REAL (the browser ceremony works on
 *                    localhost/HTTPS); the sub-org, wallet, and recovery words
 *                    are simulated. Safe to click through, moves nothing.
 *   live           — real Turnkey provisioning. Requires the parent-org
 *                    credential. Fail-closed: refuses to start without it.
 *
 * Env:
 *   CLAIM_MODE                  demo | live (default demo)
 *   CLAIM_HMAC_SECRET           secret signing the claim links (required)
 *   CLAIM_DB_PATH               sqlite file (default ./claim.db)
 *   CLAIM_PORT                  default 4023
 *   CLAIM_LINK_TTL_SECONDS      claim-link lifetime, default 24h
 *   TAAP_MCP_URL                public URL of the hosted TaaP MCP (shown on the
 *                             onboarding page; empty = "not configured yet")
 *   TAAP_TURNKEY_ORG_ID / TAAP_TURNKEY_API_PUBLIC_KEY / TAAP_TURNKEY_API_PRIVATE_KEY
 *                             live-mode parent credential (same vars as TaaP)
 */
export type ClaimMode = 'demo' | 'live';

export interface ClaimConfig {
  mode: ClaimMode;
  hmacSecret: string;
  dbPath: string;
  port: number;
  linkTtlSeconds: number;
  mcpUrl: string;
  turnkeyOrgId?: string;
  turnkeyApiPublicKey?: string;
  turnkeyApiPrivateKey?: string;
}

export function loadClaimConfig(
  env: Record<string, string | undefined> = process.env,
): ClaimConfig {
  const mode = (env.CLAIM_MODE ?? 'demo').trim().toLowerCase();
  if (mode !== 'demo' && mode !== 'live') {
    throw new Error(`CLAIM_MODE must be "demo" or "live", got "${env.CLAIM_MODE}"`);
  }
  const hmacSecret = env.CLAIM_HMAC_SECRET?.trim();
  if (!hmacSecret || hmacSecret.length < 16) {
    throw new Error('CLAIM_HMAC_SECRET is required (min 16 chars) — claim links are bearer tokens.');
  }
  const cfg: ClaimConfig = {
    mode,
    hmacSecret,
    dbPath: (env.CLAIM_DB_PATH ?? './claim.db').trim() || './claim.db',
    port: parseInt(env.CLAIM_PORT ?? '4023', 10) || 4023,
    linkTtlSeconds: parseInt(env.CLAIM_LINK_TTL_SECONDS ?? '86400', 10) || 86400,
    mcpUrl: (env.TAAP_MCP_URL ?? '').trim(),
    turnkeyOrgId: env.TAAP_TURNKEY_ORG_ID?.trim() || undefined,
    turnkeyApiPublicKey: env.TAAP_TURNKEY_API_PUBLIC_KEY?.trim().replace(/^0x/, '') || undefined,
    turnkeyApiPrivateKey: env.TAAP_TURNKEY_API_PRIVATE_KEY?.trim().replace(/^0x/, '') || undefined,
  };
  if (cfg.mode === 'live' && (!cfg.turnkeyOrgId || !cfg.turnkeyApiPublicKey || !cfg.turnkeyApiPrivateKey)) {
    throw new Error(
      'CLAIM_MODE=live requires TAAP_TURNKEY_ORG_ID, TAAP_TURNKEY_API_PUBLIC_KEY and ' +
        'TAAP_TURNKEY_API_PRIVATE_KEY. Refusing to start.',
    );
  }
  return cfg;
}
