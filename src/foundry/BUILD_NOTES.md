# Foundry Phase 1 — build notes

Built overnight 2026-10-02/03. The safety wrapper: an MCP server (`foundry`)
that sits between agents and the hookit launch MCP, adding the confirmation
gates the underlying launcher lacks.

## What was built

- `src/foundry/db.ts` — `FoundryDb` (node:sqlite, DatabaseSync, sync API).
  Tables: `approvals` (id, kind, erc8004_id, params_json, summary, status
  pending|approved|rejected|executed|failed, created_at, decided_at) and
  `launches` (id, erc8004_id, token_name, token_symbol, preset, modules_json,
  pair, snipe_tax_pct, hook_tax_pct, dev_buy_pct, launch_tx, launched_at).
  CREATE TABLE IF NOT EXISTS.
- `src/foundry/service.ts` — the safety logic, UI-free so tests drive it
  directly:
  - Passthrough: list_presets / list_modules / list_pairs / wallet_status /
    prepare_launch (FORCES dryRun:true; the caller cannot switch it off).
  - Gated: request_launch / request_claim_fees / request_send_eth — each
    requires an ERC-8004 id, validates params, writes a pending approval row,
    and returns a plain-words summary. They never execute.
  - `approve(id)` — the ONLY path to a real transaction: flips pending→
    approved, calls the executor, then executed/failed. Approved launches
    write a reputation row to `launches`, bound to the ERC-8004 id.
  - `reject(id)` — flips pending→rejected; the executor is never touched.
  - Decisions are single-shot: double approve/reject throws.
  - Executor injection: tests pass a mock; production uses
    `defaultHookitExecutor`, which speaks MCP stdio to `npx -y hookit-mcp`
    and refuses to run unless HOOKIT_PRIVATE_KEY is set in env.
- `src/foundry/wrapper.ts` — the `foundry` MCP server (stdio, zod schemas,
  same envelope style as the 402 MCP server). 12 tools: 5 passthrough,
  3 gated requests, approve/reject, and 2 reads (foundry_approvals audit
  trail, foundry_launches reputation trail).
- `src/foundry/STANDARDS.md` — the launch standards doc (identity gate,
  dryRun-first, human approval, capped wallets + backup ritual, disclosure
  rule).
- `test/foundry.test.ts` — 16 checks, all deterministic: no network, no
  keys, nothing signed.

## How to run

```bash
npx tsx test/foundry.test.ts   # or: npm run test:foundry
npx tsc --noEmit               # typecheck
npx tsx src/foundry/wrapper.ts # serve the MCP over stdio (reads FOUNDRY_DB_PATH)
```

## What is stubbed / left for later

- **Live execution**: `defaultHookitExecutor` is real code (MCP stdio client
  to `npx -y hookit-mcp`) but has never run against live Ink — Phase 1
  approves nothing real. First live run needs HOOKIT_PRIVATE_KEY in env and
  a funded launch-only wallet.
- **On-chain ERC-8004 verification**: the gate records the id and rejects
  empty/malformed values, but does not yet verify onchain that the id is
  registered and owned by the requesting wallet. Phase 2 work.
- **launch_tx extraction**: best-effort recursive search of the executor
  result for a tx hash (launcher-defined shape). May come back null on
  unfamiliar result shapes — the approval row still records the execution.
- **Snipe-tax value**: the launch row records the DISCLOSED snipe tax from
  the request params, not an on-chain read of the preset's actual opening
  tax. Reconcile against the dry-run output before Phase 2.
- **No HTTP surface yet**: Phase 1 is the MCP only. A coin-desk HTTP API
  (Argus-desk pattern) and Lounge town events are Phase 2/3.
