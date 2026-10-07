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
 *   FOUR02_BOUNTY_ESCROW     BountyEscrow contract on Ink. When set, /jobs
 *                         (the agent job marketplace) is mounted. Unset =
 *                         board disabled. The contract is undeployed.
 *   FOUR02_JOBS_LISTING_FEE_USDC optional x402 listing fee per job post,
 *                         default "0" (free at launch; open founder question).
 *   FOUR02_JOBS_DB_PATH      SQLite file for the job board, default "./jobs.db".
 *   FOUR02_SETTLEMENT_DB_PATH SQLite file for durable settlement state
 *                         (consumed nonces, broadcast tx hashes, send
 *                         intents, in-flight claims), keyed by
 *                         chain+token+payer+nonce. Unset = in-memory only:
 *                         restarts and second instances forget settlement
 *                         state (the onchain authorizationState check remains
 *                         the backstop). Production: point at a persistent
 *                         volume on the SAME host, e.g. /data/settlements.db
 *                         (SQLite WAL must not be shared over a network
 *                         volume; multi-host needs a client/server DB).
 *
 * The founder holds all production keys and runs deploys. This CLI only reads
 * keys from the environment — it never prints, stores, or transmits them.
 */
import { serve } from '@hono/node-server';
import { CHAINS } from '../facilitator/chains.js';
import { loadConfig } from '../facilitator/config.js';
import { NonceStore } from '../facilitator/nonces.js';
import { SqliteSettlementStore } from '../facilitator/settlement-store.js';
import { createApp } from '../facilitator/server.js';
import { settlerAddress } from '../facilitator/settle.js';
import { loadLoungeConfig, type LoungeConfig } from '../lounge/config.js';
import { loadBlackjackConfig, type BlackjackConfig } from '../lounge/config.js';
import { loadJobsConfig, type JobsConfig } from '../jobs/config.js';

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
// The job marketplace is opt-in: FOUR02_BOUNTY_ESCROW set => mounted at
// /jobs. The escrow is undeployed, so this is unset (disabled) until the
// founder deploys the BountyEscrow contract.
const jobs: JobsConfig | null = loadJobsConfig();
// Durable settlement state (#3): a SQLite file shared across restarts and
// instances. Unset = in-memory NonceStore (single-process dev default).
const settlementDbPath = process.env.FOUR02_SETTLEMENT_DB_PATH;
const settlementStore = settlementDbPath
  ? new SqliteSettlementStore(settlementDbPath)
  : new NonceStore();
const app = createApp(config, settlementStore, { lounge, blackjack, jobs });

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

console.log(
  `  foundry : /foundry dry-run console mounted (keyless, signs nothing)`,
);
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`  listening: http://localhost:${info.port}`);
});
