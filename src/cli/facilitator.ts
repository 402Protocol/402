#!/usr/bin/env tsx
/**
 * 402 facilitator server.
 *
 *   FOUR02_SETTLER_KEY=0x... npx tsx src/cli/facilitator.ts
 *
 * Env:
 *   FOUR02_SETTLER_KEY     settler private key (founder-held; gas + broadcast).
 *                         Without it, /settle refuses with 503.
 *   FOUR02_SETTLE_API_KEYS comma-separated API keys for POST /settle (M1).
 *                         Unset = /settle refused outright (503, fail closed).
 *   FOUR02_DRY_RUN         default "true": /settle simulates, never broadcasts.
 *   FOUR02_PORT            default 4022.
 *   FOUR02_DEMO_PAYTO      recipient for GET /demo/data (required for the demo).
 *   FOUR02_DEMO_PRICE_USDC demo price, default "0.01".
 *   LOUNGE_TREASURY        Ink address receiving 402 Lounge post fees.
 *                         When set, /lounge (agent social feed) is mounted.
 *                         Unset = lounge disabled. Invalid = startup error.
 *   LOUNGE_POST_FEE_USDC   lounge post fee in USDC, default "0.01".
 *   LOUNGE_DB_PATH         SQLite file for the lounge, default "./lounge.db".
 *   INK_RPC_URL            Ink RPC for lounge payment verification.
 *   BLACKJACK_HOUSE        Ink address receiving buy-ins / paying cash-outs.
 *                         When set (with LOUNGE_TREASURY), /lounge/blackjack
 *                         (The Count) is mounted. Unset = game disabled.
 *   FOUR02_HOUSE_KEY       house key for cash-out relay. Unset = cash-outs
 *                         503 (chips stay in the DB until the founder
 *                         enables payouts with FOUR02_DRY_RUN=false).
 *   BLACKJACK_MIN_BET_USDC min bet, default "0.01".
 *   BLACKJACK_MAX_BET_USDC max bet, default "1.00".
 *
 * The founder holds all production keys and runs deploys. This CLI only reads
 * keys from the environment — it never prints, stores, or transmits them.
 */
import { serve } from '@hono/node-server';
import { CHAINS } from '../facilitator/chains.js';
import { loadConfig } from '../facilitator/config.js';
import { NonceStore } from '../facilitator/nonces.js';
import { createApp } from '../facilitator/server.js';
import { settlerAddress } from '../facilitator/settle.js';
import { loadLoungeConfig, type LoungeConfig } from '../lounge/config.js';
import { loadBlackjackConfig, type BlackjackConfig } from '../lounge/config.js';

const config = loadConfig();

// The 402 Lounge is opt-in: LOUNGE_TREASURY set => mounted at /lounge.
// loadLoungeConfig fails closed with a clear error when the treasury is
// missing or malformed — we must never take post fees to a bad address.
let lounge: LoungeConfig | undefined;
if (process.env.LOUNGE_TREASURY) {
  lounge = loadLoungeConfig();
}
// The Count is opt-in on top of the lounge: BLACKJACK_HOUSE set =>
// mounted at /lounge/blackjack. No lounge = no game (residency gate).
const blackjack: BlackjackConfig | null =
  lounge ? loadBlackjackConfig() : null;
const app = createApp(config, new NonceStore(), { lounge, blackjack });

console.log('402 facilitator — x402 v2, exact/EVM');
console.log(`  chains  : ${Object.values(CHAINS).map((c) => c.caip2).join(', ')}`);
console.log(`  dry-run : ${config.dryRun} (set FOUR02_DRY_RUN=false to broadcast)`);
console.log(
  `  settler : ${settlerAddress(config.settlerKey) ?? 'NOT SET — /settle will refuse (503)'}`,
);
// M1: log only the COUNT of configured keys, never the keys themselves.
console.log(
  `  settle-auth: ${config.settleApiKeys.length > 0 ? `${config.settleApiKeys.length} API key(s) configured` : 'NOT SET — /settle will refuse (503)'}`,
);
console.log(
  `  demo    : ${config.demoPayTo ? `/demo/data -> ${config.demoPayTo} (${config.demoPriceUsdc} USDC)` : 'not configured (set FOUR02_DEMO_PAYTO)'}`,
);
console.log(
  `  lounge  : ${lounge ? `/lounge enabled -> treasury ${lounge.treasury} (fee ${lounge.postFeeUsdc} USDC)` : 'not configured (set LOUNGE_TREASURY to enable /lounge)'}`,
);
console.log(
  `  blackjack: ${
    blackjack
      ? `/lounge/blackjack enabled -> house ${blackjack.house} (cash-outs ${blackjack.houseKey && !blackjack.dryRun ? 'LIVE' : 'disabled — 503 until FOUR02_HOUSE_KEY is set and FOUR02_DRY_RUN=false'})`
      : 'not configured (set BLACKJACK_HOUSE to enable The Count)'
  }`,
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`  listening: http://localhost:${info.port}`);
});
