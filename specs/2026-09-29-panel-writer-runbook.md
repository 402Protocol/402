# Panel Writer Runbook — PanelBatchWriter + panel-keeper

Owner: Father. The writer contract is NOT deployed yet; this runbook covers
deploy day and everything after. Nothing here authorizes a deployment — that
is always his explicit per-deploy call.

## What this is

`contracts/PanelBatchWriter.sol` is the keeper-gated contract that writes
per-epoch reviewer-panel scores into the live `Four02ReputationRegistryV2`
as `EscrowCompleted` events carrying quorum-agreement basis points (NOT USDC).
`src/jobs/panel-keeper.ts` is the offchain cron that aggregates
`reviewer_stats` and submits the batches. Panels are advisory + reputation
only: nothing here moves funds, releases bounties, or settles disputes.

## Deploy checklist

1. Deploy `PanelBatchWriter` with constructor args:
   - `registry_` = `0x4fa146388ce351b2af71aa6841146c91a2f27494` (live V2 registry, Ink)
   - `keeper_` = the keeper bot address (EOA or hardware-signer-backed)
   - `initialOwner` = Father's fresh wallet `0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf`
   - Deploy FROM the treasury wallet per standing rule (`0x1795adb30465b6f77e65f42695668617b6e34ac4`)
2. Verify source on the Ink explorer.
3. As the registry owner, call `addWriter(<writer address>)` on the registry.
4. Fund the keeper with a dust of ETH for gas (a 70-entry batch costs ~20M gas).
5. Dry-run the keeper first: `npx tsx src/jobs/panel-keeper.ts --writer 0x...`
   (no `--broadcast`). Check the bundle file + bundle hash in the logs.
6. Adversarial review must be green before step 1 (standing rule).

## Bad-batch procedure

The registry is **append-only** — a bad batch cannot be deleted.

1. A bad batch is always superseded, never erased: the next epoch's snapshot
   overwrites the derived view (snapshots are lifetime agreement bps, not deltas).
2. If the bad batch is actively misleading (wrong reviewers, fabricated scores):
   - Run the keeper immediately for a corrective epoch with the right data.
   - Announce the correction publicly with both bundle hashes (bad + corrective).
3. If the keeper itself is submitting garbage on purpose, treat as keeper
   compromise (below) — the registry will keep accepting its writes until
   `removeWriter` lands.

## Keeper-compromise procedure

1. **Immediately**, as the registry owner: call `removeWriter(<writer>)` on
   `Four02ReputationRegistryV2`. Past events stay onchain (sunlight); new
   writes stop.
2. Deploy a fresh `PanelBatchWriter` (new address = new writer identity).
3. Owner calls `addWriter(<new writer>)` on the registry.
4. Rotate the keeper key: `proposeKeeper(<new>)` then `acceptKeeper()` from
   the new address. Investigate how the old key leaked before reusing any
   infrastructure it touched.
5. Resume the keeper cron against the new writer address.

## Monitoring (alert on all of these)

- Any `BatchSubmitted` event NOT from a scheduled keeper run (unexpected
  epoch, unexpected hour, unknown sender).
- Any `KeeperProposed` event (rotation should only happen in a planned window).
- Keeper cron exit code **2** = paging alarm: a chunk was submitted onchain
  but is not in the local ledger. A human investigates before the next run;
  the chunk is never silently retried.
- Keeper cron exit code **1** = refusal/fatal (not allowlisted, wrong key,
  low ETH, tx reverted). Fix the cause, do not just rerun.
- Bundle-hash drift: the bundle file's per-chunk `batchHash` must equal the
  `batchHash` in the onchain `BatchSubmitted` event. Mismatch = the keeper
  binary and the chain disagree — stop the cron and investigate.

## Keeper key guidance

- Long-term the keeper key lives on a hardware signer or KMS — never a raw
  hex in env on a cron box. `FOUR02_PANEL_KEEPER_KEY` in env is bootstrap
  only.
- The keeper key is low-privilege by design: it can only call `submitBatch`
  on the writer contract. It cannot move funds, cannot change the keeper
  (two-step rotation is owner-proposed), cannot touch the registry directly.
- If the keeper box is ever in doubt, the owner revokes at the registry
  level (`removeWriter`) — no key rotation needed to stop the bleeding.

## Integrator guidance (8004 consumers)

- Tag1 `escrow_completed` now mixes two things: real escrow completions and
  panel-review snapshots. **Scope every query by the `writer` field.**
  Panel events are written by the PanelBatchWriter address; their `value` is
  agreement-bps (0–10000), NOT USDC.
- `readFeedback` does not expose `refId`. Consumers that need the
  panel-vs-escrow disambiguation must read the public `events` mapping
  directly: panel events carry
  `refId = keccak256("402:panel-review/v1" ‖ epochId ‖ agentId)`.
- Do not sum panel `value` fields as revenue. Ever.

## Steady-state note (honest)

The registry's `pairCompletionCap` (currently 5) stops counting
`(agentId, address(0))` pairs after ~5 epochs per reviewer. After that, new
batches still land onchain (the event log keeps growing — sunlight), but the
derived `disputeRate`/`summary` views stop moving for that reviewer. In
steady state the writer is a **commitment log**, not a score engine: the
live signal is the latest snapshot plus the attestation bundle, not the
cumulative onchain math. If per-epoch movement matters long-term, that is
what a registry V3 with a dedicated `PanelReviewed` variant (10) is for.
