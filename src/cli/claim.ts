#!/usr/bin/env tsx
/**
 * Claim-site server.
 *
 *   CLAIM_HMAC_SECRET=... npm run claim            # demo mode
 *   CLAIM_MODE=live CLAIM_HMAC_SECRET=... CLAIM_ADMIN_KEY=... npm run claim
 *
 * Demo: full ceremony, simulated Turnkey objects, real WebAuthn.
 * Live:  real provisioning (needs the parent credential + CLAIM_ADMIN_KEY).
 */
import { serve } from '@hono/node-server';
import { loadClaimConfig } from '../claim/config.js';
import { buildClaimDeps } from '../claim/server.js';

const config = loadClaimConfig();
const { app } = buildClaimDeps(config);

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`402 claim site listening on http://localhost:${config.port} [${config.mode}]`);
  if (config.mode === 'demo') {
    console.log('demo mode: open / to mint a demo claim link and walk the ceremony.');
  }
});
