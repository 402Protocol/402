# 402 Reputation Registry — design doc (2026-09-25)

## Why this exists

Ink's canonical ERC-8004 ReputationRegistry (`0x8004BAa1...`) is the 8004
team's unupgraded placeholder — no real implementation, no writes possible.
Identity, by contrast, works today via the live `IdentityRegistryUpgradeable`
at `0x7274e874CA62410a93Bd8bf61c69d8045E399c02`.

Rather than wait on (or fork-and-pray over) the canonical reputation
registry, 402 ships its own, purpose-built for an agent commerce economy:

- **Reputation from behavior, not opinions.** Stock 8004 reputation lets
  anyone except the agent leave feedback — review-bombing and sybil reviews
  are inherent. Ours only records verifiable onchain commerce events
  (invoices, escrows, disputes, arbitration) written by 402 protocol
  contracts.
- **No dependency on the vanity placeholder.** Fresh deploy on Ink; we never
  touch `0x8004BAa1...` (someone else's upgrade key).

Contract: `contracts/Four02ReputationRegistry.sol`
Tests: `test/sol/Four02ReputationRegistry.t.sol` (29 tests, green)

## Decisions (all approved 2026-09-25)

1. **Single write path.** `recordCommerceEvent(agentId, eventType, value,
   refId, counterparty)` — callable only by allowlisted writer contracts.
   Owner manages the allowlist (`addWriter`/`removeWriter`, events emitted).
   Allowlist starts empty; the invoice registry, escrow vault, and
   arbitration contracts are added as they ship. Writers are trusted to
   report truthfully and in causal order.
2. **Append-only raw log.** `CommerceEvent{eventType, value, timestamp,
   refId, writer, counterparty}` per agentId. Nothing is ever edited or
   revoked — a `DisputeWithdrawn` is a separate event, not a deletion.
3. **Scores are derived views.** `reliability`, `disputeRate`,
   `arbitrationRecord`, `summary` compute over the raw log. Weights and the
   decay window are owner-tunable state — retuning takes effect immediately,
   no history migration.
4. **Decay.** Headline scores decay linearly to zero over `decayWindow`
   (default 365 days). Raw history is permanent. A withdrawn dispute is
   neutral on the score (it cancels its `DisputeOpened` via matching
   `refId`); a *resolved* dispute still counts — it happened.
5. **Privacy.** All data public onchain, by design. Reputation is a
   sunlight system.
6. **Keyed to 8004 agentId.** Survives wallet rotation. The registry never
   consults an identity registry and knows nothing about TRACES — TRACES
   reads it, not the other way around.
7. **Non-upgradeable, Ownable.** Same posture as AgentEscrow/TracesLicense.
8. **ERC-8004 read interface preserved.** `getLastIndex`, `readFeedback`,
   `getSummary`, `readAllFeedback`, `getResponseCount`, `getClients`,
   `getIdentityRegistry`, `getVersion` — same names, params, return shapes
   as the reference `ReputationRegistryUpgradeable` (MIT, erc-8004-contracts),
   so existing 8004 tooling can query us. The open write functions
   (`giveFeedback`, `revokeFeedback`, `appendResponse`) are deliberately NOT
   implemented. Mapping notes:
   - 8004 "client" = authorized writer contract.
   - `readFeedback` value = USDC amount (6 decimals); tag1 = event type
     (e.g. `invoice_paid_on_time`); tag2 = `402:commerce`; `isRevoked`
     always false.
   - `getResponseCount` always returns 0 (no responses in this model).
   - `getIdentityRegistry` returns `address(0)` (no identity dependency,
     by design).
9. **Compiler.** `via_ir = true` in foundry.toml — the 8004 reference itself
   requires via-IR for the 7-array `readAllFeedback` return; legacy codegen
   cannot compile that shape.

## Scoring math

- **reliability** (0–100): `100 * (onTimeW*onTimeVal + lateW*lateVal) /
  totalInvoiceVal`, value- and decay-weighted. Defaults: on-time 100%,
  late 50%. No (undecayed) invoice history → 0.
- **disputeRate** (basis points): decay-weighted active disputes /
  decay-weighted completed commerce (escrows + paid invoices). No completed
  commerce → 0.
- **arbitrationRecord**: lifetime (wins, losses), no decay.
- **summary**: one view → reliability, disputeRateBps, wins, losses,
  totalEvents, lastEventTimestamp.

## Deploy notes

- Constructor takes `initialOwner` — **deploy with a timelock + multisig.**
  The owner controls the writer allowlist and score weights; a lone EOA
  owner would let one key rewrite who counts as a reputable writer and how
  scores are computed, which guts the trust story.
- Writer onboarding order: deploy registry → deploy invoice registry /
  escrow vault / arbitration → `addWriter` each. Allowlist starts empty, so
  nothing can record before the protocol contracts exist.
- No proxy, no init function. Verify source on the Ink explorer at deploy.
- If the canonical 8004 reputation placeholder ever gets a real
  implementation: ignore it for now; a bridge/mirror is a future decision,
  not a launch requirement.

## Open / future

- Counterparty-scoped views (reputation *with a specific counterparty*).
- Amount-privacy (hashed commitments) if commercial agents push back on
  public values — v2 problem, current call is public.
- TRACES burn/governance gates reading `reliability`/`disputeRate` —
  the seam is ready (TRACES reads this registry).

## Deploy config (2026-09-25, founder decision)
- Deploy transactions are sent FROM the treasury wallet
  `0x1795adb30465b6f77e65f42695668617b6e34ac4` (0.00205 ETH on Ink;
  both contracts cost ~0.0004 ETH at current fees).
- `initialOwner` (TRACES and Four02ReputationRegistry) is set TO the fresh
  wallet `0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf` — ownership only, it
  never pays gas and needs no funding.
- Long-term: move ownership to timelock+multisig (standing recommendation).

## Deployment (2026-09-25)
- Live on Ink mainnet: `0x33E2c56035C059553a37a3A56199B5b5b3DA3365`
- Deploy tx: `0x9d9efbbbd21f1573258c982735e15724c9630b13dde0b4ed418fe940b5877d1f`
- Owner: `0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf` (verified onchain).
- Source verified on https://explorer.inkonchain.com.
- Next: owner calls addWriter() for each 402 protocol contract as they deploy.
