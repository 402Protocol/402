# Argus — Phase 1 Build Notes (paper-trading backend)

**Status:** built 2026-10-02/03. PAPER ONLY — no keys, no signing, no broadcasts,
no real money, no Nado write endpoints. The only network traffic is public
market-data reads.

## What was built

`src/argus/` — a self-contained module wired into the facilitator like `rekt.ts`
(read-only spectator pattern). The Rekt feed was NOT touched.

| File | Job |
|---|---|
| `types.ts` | Shared types + locked constants. **The stable seam**: strategy, risk, and executor only ever exchange `TradeProposal` — internals can change freely. |
| `venue.ts` | Nado public reads: pairs map (`gateway/v2/pairs`), candles / prices / funding via `POST {archive}/v1` with `{"<type>": {params}}` (shape reverse-engineered from `@nadohq/indexer-client` 0.52.0, verified live). x18 fixed-point parsing included. |
| `strategy/` | **Modular by design** (Father: build Argus to be the best trend trader on the market). `signals.ts` (pluggable `Signal` votes; v1: `MaCrossSignal`), `filters.ts` (pluggable veto-only `Filter`s; v1: `FundingFilter`; broken filters fail CLOSED), `regime.ts` (v2 slot — v1 is a neutral passthrough), `engine.ts` (`StrategyEngine` composes regime → signals → combiner → filters → `TradeProposal`). New signals/filters register via registries; the combiner, executor, and risk runtime never change. |
| `risk.ts` | The bulkhead. `ArgusRisk.evaluate()` is the single choke point: proposals pass here before the executor may fill. Can only reject — no approve/widen path. Kill switch latches (no HTTP revive by design). |
| `executor.ts` | Simulated fills at mark ± slippage, taker fee deducted from cash, positions, unrealized/realized PnL, stop-loss sweep, bankruptcy guard (auto-liquidate at full margin loss). Sanity-checks insane inputs. |
| `db.ts` | `ArgusDb` (node:sqlite): portfolio, positions, trades, reasoning, equity_snapshots. Source of truth across restarts. |
| `feed.ts` | Auto-posts every fill to the Lounge feed as the Argus system author. **Override note:** Father explicitly overrode the per-post-approval rule for Argus paper trades (2026-10-02, locked). Approval returns for real money. |
| `engine.ts` | Tick loop (default 30s): market snapshot → stops/liquidations → daily-loss-cap check → per-product strategy → risk → fill → persist → reason → feed post. Fail-soft; `ARGUS_ENABLED=0` disables. |
| `server.ts` | Hono routes (see Endpoints). Kill route registered ONLY with `ARGUS_KILL_SECRET` — otherwise it doesn't exist (fail closed). |

## Endpoints (mounted at `/argus`)

- `GET /argus/status` — bankroll, cash, equity, unrealized, realized-today, open positions (with marks + unrealized), killed, haltedUntil.
- `GET /argus/trades?limit=` — trade history, newest first.
- `GET /argus/reasoning?limit=` — the "why I did it" feed.
- `POST /argus/kill` `{ "secret": "..." }` — engages the kill switch. 401 on wrong secret; 404 when `ARGUS_KILL_SECRET` unset.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `ARGUS_ENABLED` | `0` | Set to `1` to run the engine (required on Railway). `0`/unset = engine off, `/argus` routes not mounted. |
| `ARGUS_DB_PATH` | `./argus.db` | SQLite file (use `/data/argus.db` on Railway) |
| `ARGUS_TICK_MS` | `30000` | 30s; min 10s |
| `ARGUS_KILL_SECRET` | — | **Father must set this.** Without it, `/argus/kill` is not registered and boot logs a loud warning. |
| `ARGUS_PAIRS_URL` | Nado prod pairs | override for testing |
| `ARGUS_INDEXER_URL` | Nado prod archive | override for testing |

## Modeled assumptions (fill model)

- Taker fee: **5 bps** per side on notional.
- Slippage: **2 bps** adverse per fill (longs pay up, shorts give up).
- Margin is conceptual (`notional / leverage`); cash moves only on fees and realized PnL. Equity = cash + unrealized.
- Funding is READ for the filter only — funding payments are NOT modeled in PnL (documented gap; v2).
- Strategy: 4h MA(12) vs 1d MA(10) cross evaluated on daily cadence (transition, not level — fires once per regime change). Stop 2% adverse. Fixed $2,500 @ 2x sizing.
- Funding extremes: ±0.1% per interval vetoes the crowded side.
- Daily loss cap: realized-today + unrealized ≤ −$1,000 → close all at mark, halt entries until next UTC day.
- One position per perp, max 4 open.

## How to run

```bash
cd ~/workspace/402
npm run test:argus        # 40 checks, no network
npx tsc --noEmit          # typecheck
# Production (Railway): set ARGUS_ENABLED=1, ARGUS_KILL_SECRET='<secret>',
# ARGUS_DB_PATH=/data/argus.db, then deploy.
ARGUS_ENABLED=1 ARGUS_KILL_SECRET='<secret>' npm start   # facilitator + lounge + argus
# then: curl localhost:PORT/argus/status
```

The engine starts automatically with the facilitator (inside the `opts.lounge`
block). It never touches the Rekt feed.

## What Phase 2 needs (NOT built)

1. Father's explicit word + legal review (locked prerequisite).
2. Real-mode venue adapter: Nado write path via the wallet-ritual key pattern
   (create → human backup → verify), Nado MCP writes under human confirmation.
3. Executor swap: paper fills → real order submission. Same `TradeProposal`
   contract — the strategy and risk modules don't change.
4. Kill switch: extend to market-close all positions (currently halts entries only).
5. Feed approval: re-enable per-post approval for real-money trades.
6. Model funding payments in PnL; consider maker fills and real slippage estimation.
7. `ARGUS_KILL_SECRET` set in Railway; `ARGUS_DB_PATH=/data/argus.db`.

## Deviations from spec

- **Eliza skipped** per the spike verdict (recorded in the spec): deterministic
  strategy engine on our own stack, no LLM key required.
- **Strategy is modular** per Father's framing note (signals/filters/regime as
  pluggable units) — v1 behavior is exactly as specced.
- Daily-loss-cap "flat for the day" implemented as close-all + halt-until-midnight
  (spec's parenthetical: "flat for the day, no new entries").
- Kill switch halts entries only in paper mode (spec: market-close is a real-mode behavior).
