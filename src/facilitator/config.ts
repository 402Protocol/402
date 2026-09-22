/**
 * 402 Phase 2 — facilitator configuration. Env only, never CLI args or code.
 *
 * Key ownership: the founder (Israel) holds ALL production keys — deployer,
 * arbiter, settler. This code only ever reads them from the environment at
 * runtime. Nothing here writes keys anywhere.
 */
import { type Address, type Hex, getAddress, isAddress } from 'viem';

export interface FacilitatorConfig {
  port: number;
  /**
   * Safe default: true. In dry-run mode /settle simulates via eth_call and
   * never broadcasts. Set FOUR02_DRY_RUN=false to settle for real.
   */
  dryRun: boolean;
  /** Settler key: pays gas and submits transferWithAuthorization. */
  settlerKey?: Hex;
  /**
   * API keys allowed to call POST /settle. M1: /settle spends operator gas,
   * so it is gated on this allowlist. Empty (env unset) = /settle is refused
   * outright with 503 — fail closed, same posture as a missing settler key.
   */
  settleApiKeys: string[];
  /** Recipient for the demo paid endpoint. */
  demoPayTo?: Address;
  /** Demo price in USDC, e.g. "0.01". */
  demoPriceUsdc: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): FacilitatorConfig {
  const settlerKey = env.FOUR02_SETTLER_KEY;
  if (settlerKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(settlerKey)) {
    throw new Error(
      'FOUR02_SETTLER_KEY is set but is not a 0x-prefixed 32-byte hex key',
    );
  }
  const demoPayTo = env.FOUR02_DEMO_PAYTO;
  if (demoPayTo !== undefined && !isAddress(demoPayTo)) {
    throw new Error('FOUR02_DEMO_PAYTO is not a valid address');
  }
  const price = env.FOUR02_DEMO_PRICE_USDC ?? '0.01';
  if (!/^\d+(\.\d{1,6})?$/.test(price)) {
    throw new Error(
      'FOUR02_DEMO_PRICE_USDC must be a decimal like "0.01" (max 6 decimals)',
    );
  }
  const port = parseInt(env.FOUR02_PORT ?? '4022', 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('FOUR02_PORT must be a valid TCP port');
  }
  // M1: comma-separated allowlist for POST /settle. Empty = fail closed.
  const settleApiKeys = (env.FOUR02_SETTLE_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return {
    port,
    dryRun: (env.FOUR02_DRY_RUN ?? 'true').toLowerCase() !== 'false',
    settlerKey: settlerKey as Hex | undefined,
    settleApiKeys,
    demoPayTo: demoPayTo ? getAddress(demoPayTo) : undefined,
    demoPriceUsdc: price,
  };
}
