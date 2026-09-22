# 402 MVP — Security Audit Report

**Date:** 2026-09-22
**Scope:** full MVP stack in `~/workspace/402`
- `contracts/AgentEscrow.sol` + `contracts/Reputation.sol` (+ `script/Deploy.s.sol`)
- `src/facilitator/` (x402 facilitator: verify/settle/supported/demo)
- `src/invoice.ts`, `src/settle.ts`, `src/cli/*`, `skill/SKILL.md`
**Method:** line-by-line manual review, live exploit tests against a local facilitator instance, Foundry fuzzing (stateful invariants, 512 runs × 12 properties, ~24.5k calls), concrete exploit attempts on local anvil (8 attacks), Slither 0.11.6, independent re-verification of the EIP-712 domain against the live Ink USDC contract.
**Auditors:** 402 Manager (facilitator + TS stack) + dedicated contracts reviewer (Solidity).
**Rules observed:** local anvil only, throwaway keys, nothing broadcast beyond anvil, no real keys touched, no secrets anywhere. No source files were modified — only test files added under `test/sol/`.

> **This is an AI-assisted internal review. It does NOT replace a professional audit before mainnet handles meaningful volume.**

## Executive summary

**5 High, 4 Medium, 5 Low, 9 Informational. No Critical (no direct fund-theft primitive found).**

The two most urgent items are both in the facilitator and both break core functionality/security assumptions:
1. `POST /verify` then `POST /settle` on the same payment **always fails** — the standard x402 flow is impossible (demonstrated live).
2. `NonceStore` **mass-evicts its entire replay-protection memory** the moment it reaches 10,000 entries (demonstrated live) — spent authorizations become reusable.

On the contracts side, the headline risks are all trust-assumption / token-quirk shaped: a blocklisted counterparty permanently bricks escrowed funds, the immutable arbiter is a single point of liveness failure, and deploying with the wrong token address creates pure accounting fiction.

---

## HIGH severity

### H1 — `/verify` then `/settle` on the same payment always fails (facilitator core flow broken)
**Where:** `src/facilitator/server.ts` (`POST /verify` handler), `src/facilitator/settle.ts` (`settleExactPayment`)
**What's wrong:** The `/verify` HTTP handler calls `verifyExactPayment` with `markUsed: true`, consuming the EIP-3009 nonce on success. `settleExactPayment` then calls verify with `markUsed: false` but explicitly rejects any already-consumed nonce with `nonce_replay`. The two endpoints are mutually exclusive for a single payment — the standard x402 resource-server flow (verify → settle) can never complete.
**Demonstrated live** (local server, throwaway keys):
```
POST /verify -> 200 {"isValid":true,...}
POST /settle (same payment) -> 200 {"success":false,"errorReason":"nonce_replay"}
```
The README documents this contradictory design as intentional ("Nonce is consumed at /verify time… /settle re-verifies without consuming"), and the demo endpoint only works because it bypasses the HTTP `/verify` and calls the internal function with `markUsed: false`.
**Exploit/failure scenario:** Any standard x402 client (resource server verifying, then asking the facilitator to settle) gets a permanent `nonce_replay` on every settlement. The facilitator cannot perform its primary job. Secondary griefing: a payer can call `/verify` on their own authorization (consuming the nonce) and hand the payload to a resource server whose `/settle` will then always fail.
**Fix:** `/verify` must not consume the nonce (it is a read-only check); only `/settle` consumes, after broadcast confirmation / passed simulation. If "verified but not yet settled" state is desired, model it explicitly (e.g. `verified` vs `settled` sets) rather than overloading one consumed-set.

### H2 — `NonceStore.sweep()` mass-evicts all replay protection at 10,000 entries
**Where:** `src/facilitator/nonces.ts:44-56`
**What's wrong:** `mark()` calls `this.sweep(Number(expiresAtSec))` — it passes the *new entry's expiry* (`validBefore`, a future timestamp) as the sweep's "now". The sweep deletes every entry with `expiry <= nowSec`. Since all live entries expire in the future at or before the new entry's `validBefore`, the sweep wipes nearly the whole store. Worse: the trigger is `size >= 10_000`, so the store **deterministically self-destructs the moment it reaches exactly 10,000 entries**, no attacker-crafted expiry needed.
**Demonstrated live:**
```
after 10k marks, size = 0          // store wiped itself
nonce #0 still blocked? false      // consumed nonces reusable again
```
After the wipe, every previously-consumed nonce passes `/verify` again. The onchain `authorizationState` backstop only protects `/settle`, not `/verify`-gated resource access — and the demo endpoint in dry-run mode grants data on `/verify` alone. An attacker can additionally drive this on demand by submitting 10,000 self-signed valid authorizations (free, offchain), then replaying all spent ones.
**Fix:** sweep with the actual current time (`Math.floor(Date.now()/1000)`), not the entry's expiry. One-line change.

### H3 — Blocklisted counterparty permanently bricks escrowed funds (no recovery path)
**Where:** `contracts/AgentEscrow.sol` — `release` (~L180), `resolveDispute` (~L216), `refund` (~L244); FiatTokenV2 semantics
**What's wrong:** Native USDC reverts any transfer touching a blocklisted address:
- Provider blocklisted mid-job → `release`'s payout leg reverts → funds stuck indefinitely. **Demonstrated on anvil**: `release` reverted, 40 USDC stuck.
- Payer blocklisted → `refund` and the payer leg of `resolveDispute` revert → stuck.
- `feeRecipient` blocklisted → **every** `release` reverts on the fee leg → protocol-wide payout DoS. **Demonstrated** via passing fuzz test `testFuzz_BlocklistedFeeRecipientBricksAllReleases`.
- Nuance found on anvil: the arbiter can unstick a dispute involving a blocklisted provider only by awarding the provider **0%** — any non-zero share reverts, so a blocklisted provider can never be paid.
**Fix options:** (a) pull-payment pattern — a permissionless `claim(jobId)` letting each party withdraw only their own settled share, so one blocklisted party can't brick the other; (b) accept the risk explicitly with monitoring/alerting on USDC `AddedBlacklister`/`RemovedBlacklister` events involving escrow counterparties. At minimum, never let the fee leg brick the provider leg: pay the provider first, and make the fee transfer failure non-fatal (or pull-based).

### H4 — Immutable arbiter with no rotation: lost key bricks all `Disputed` funds
**Where:** `contracts/AgentEscrow.sol:91` (`address public immutable arbiter`)
**What's wrong:** Deliberate v0 choice, but the liveness cost is total: if the arbiter key is lost (or compromised and abandoned), every job sitting in `Disputed` is frozen forever — no fallback, no timelock, no rotation.
**Fix:** at minimum deploy the arbiter as a multisig. Consider a timelocked arbiter-rotation path or a dead-man's escape (e.g., after N days in `Disputed`, permissionless 50/50 split or payer refund). Document the tradeoff explicitly.

### H5 — Deploy footgun: no contract-code check on `token`; wrong-chain deploy = accounting fiction
**Where:** `contracts/AgentEscrow.sol:117-128` (constructor); `script/Deploy.s.sol:33` (`TOKEN` constant)
**What's wrong:** The constructor never checks `token_` is a contract. The stated expansion target is Robinhood Chain — deploying there without editing `TOKEN` points at an address with no code, and OZ `SafeERC20` treats empty returndata as success, so `createJob`/`release` would "succeed" while moving **zero** tokens: jobs backed by nothing, releases paying nothing, all events and reputation recording fiction.
**Fix:** `require(token_.code.length > 0)` in the constructor; add a `block.chainid` assertion (or per-chain config check) in the deploy script/runbook.

---

## MEDIUM severity

### M1 — Unauthenticated `/settle` lets anyone burn the operator's gas (facilitator)
**Where:** `src/facilitator/server.ts` (`POST /settle`), `src/facilitator/settle.ts`
**What's wrong:** `/settle` is fully public. Every call with a valid authorization triggers RPC calls (`authorizationState`, `balanceOf`, `simulateContract`) and — in production mode — a broadcast paid for by the settler key. With the facilitator fee at 0 bps, settlement is a public good funded by the operator: an attacker can spam valid micro-authorizations (they can mint unlimited self-signed ones) to drain the settler's gas wallet and burn RPC quota. Additionally, concurrent duplicate `/settle` submissions for the same auth can both pass the `authorizationState` read before either mines → N-1 reverted onchain txs, operator pays gas for all of them.
**Fix:** restrict `/settle` to known resource servers (API key / allowlist), add rate limiting, and/or introduce a facilitator fee so settlement isn't a free public good. Consider a per-request gas cap.

### M2 — Reputation farming via `payer == provider` self-dealing
**Where:** `contracts/AgentEscrow.sol:139-161` (`createJob` allows `provider == msg.sender`)
**What's wrong:** Anyone can fund a self-job, "deliver", release, and mint `completedJobs` at the cost of the fee. **Demonstrated on anvil**: one self-deal → `completedJobs(payer)=1`, `score=10000`. Worse than the documented "sybil-vulnerable" caveat implies: with dust amounts (e.g. `amount=1`), the fee rounds to **zero** (`(1*75)/10000 = 0`), so reputation farming costs only gas.
**Fix:** `revert` when `provider == msg.sender` in `createJob` (or skip reputation recording for self-jobs), and consider a minimum job amount so dust farming isn't free.

### M3 — Deadline refund race griefs providers; no unilateral provider payout
**Where:** `contracts/AgentEscrow.sol:239-247` (`refund`); `confirmDelivery` has no deadline check
**What's wrong:** A provider's `confirmDelivery` can lose a mempool race to a permissionless `refund` the instant the deadline passes. **Demonstrated on anvil**: a stranger's `refund(7)` mined first, the provider's next-block `confirmDelivery` reverted, job terminally `Refunded` — work done, zero recourse. Symmetrically, a payer can hold funds hostage indefinitely (never release, never dispute); the provider's only recourse is raising a dispute themselves *before* the deadline.
**Fix:** document that providers must deliver/dispute well before the deadline; consider a delivery-exclusivity window (e.g. `confirmDelivery` within X of the deadline blocks `refund`, or refund only after `deadline + grace`).

### M4 — Global USDC pause bricks all fund movement, no contingency
**Where:** all fund-moving functions in `contracts/AgentEscrow.sol`
**What's wrong:** If Circle pauses USDC, every payout path reverts with no admin escape hatch. (A pause escape hatch conflicts with trust-minimization, so this is a founder decision — but it must be an *explicit* documented decision, not an accident.)
**Fix:** document as accepted risk; ensure monitoring for `Pause`/`Unpause` events.

---

## LOW severity

### L1 — Dry-run demo grants data on `/verify` alone with no nonce consumption
**Where:** `src/facilitator/server.ts` (`GET /demo/data`, dry-run branch)
**What's wrong:** In dry-run mode the demo verifies with `markUsed: false` and never marks the nonce anywhere — one signed authorization buys unlimited accesses. Fine for local testing (it says so), but the demo must never be publicly exposed in dry-run mode.
**Fix:** document the constraint; consider marking nonces even in dry-run demo mode.

### L2 — `parseSignedInvoice` throws uncaught on malformed input
**Where:** `src/invoice.ts` (`parseSignedInvoice`, `toBigInt`)
Garbage JSON, missing fields, or null fields → `SyntaxError`/`TypeError` instead of clean errors. Fail-closed in the CLIs (process crashes before any payment), but a robustness wart for library/server use.
**Fix:** validate shape and return structured errors.

### L3 — No rate limiting or body-size limits on the facilitator HTTP surface
**Where:** `src/facilitator/server.ts`
Each `/verify` costs an ecrecover, each `/settle` costs multiple RPC round-trips; unbounded JSON bodies are accepted. Mild CPU/RPC-quota DoS surface. **Fix:** reverse-proxy or in-app rate limits + body cap (ops hardening).

### L4 — Fee rounding dust direction (contracts)
**Where:** `contracts/AgentEscrow.sol` (`release`, `resolveDispute`)
`release` floors the fee → dust favors the provider; `resolveDispute` floors the provider share → dust favors the payer. Predictable, conserved, no loss. No action needed beyond awareness.

### L5 — `confirmDelivery` has no deadline check; dispute griefing (contracts)
A provider can deliver *after* the deadline if no refund landed yet (generous quirk, note for spec clarity). Either party can `raiseDispute` immediately after funding, locking the counterparty's capital until the arbiter acts (costs only gas). Both noted; no fund-theft vector.

---

## INFORMATIONAL

- **I1 — Offchain/onchain malleability policy mismatch (facilitator):** a high-s (EIP-2 malleated) variant of a valid authorization is *rejected* by `/verify` (viem enforces low-s — empirically confirmed fail-closed), while USDC's onchain `ecrecover` would accept it. No fund impact (replay protection is nonce-keyed), but a payer wallet producing high-s signatures would be unservable by the facilitator. Worth knowing, not fixing urgently.
- **I2 — No `maxFeePerGas` cap on settlement transactions:** gas spikes overcharge the settler wallet. Consider a cap + alerting.
- **I3 — `waitForTransactionReceipt` has no timeout:** a stuck transaction hangs the `/settle` HTTP request; connection-exhaustion DoS in the extreme.
- **I4 — `validBefore` not re-checked immediately pre-broadcast:** a tx mined after expiry reverts onchain; wasted gas only.
- **I5 — `pay.ts` doesn't check prior payment:** double-pay possible if the human approves twice; the skill instructs a `status` check first — process-level control, keep it.
- **I6 — `issue.ts` accepts negative `--expires-in`:** produces an immediately-expired invoice; `verifyInvoice` flags it. Trivial.
- **I7 — Nothing prevents `arbiter == feeRecipient` or the arbiter being a job party:** deploy runbook should require a neutral arbiter. (Verified on anvil that even a hostile arbiter cannot redirect funds outside the provider/payer split — see exploit A8.)
- **I8 — Timestamp dependence** (`block.timestamp` deadline checks): negligible sequencer influence on Ink (~seconds).
- **I9 — `reentrancy-events` lint** (events after external calls): state is updated first and `nonReentrant` guards reentry; not exploitable.

---

## Checked and found clean

**Facilitator / TS:**
- EIP-712 domain **independently re-verified**: recomputed `DOMAIN_SEPARATOR` locally (name `"USDC"`, version `"2"`, chainId 57073, verifyingContract `0x2D27…EAEd`) matches the live Ink USDC contract byte-for-byte.
- Signature binding: tampered value, wrong token, wrong chain, expired / not-yet-valid, corrupt signature, signer≠`from`, recipient mismatch, requirements mismatch, bad nonce format — all rejected (20 existing tests + live re-tests).
- Replay logic (apart from H2): the same authorization is correctly rejected on second `/verify` — confirmed live.
- Front-running the settler: the signed authorization is public, but it is bound to `(from, to, value, nonce)` — a front-runner can only settle the *same* payment to the *same* recipient. No theft vector.
- Domain confusion: CAIP-2 parsing is strict (`^eip155:(\d+)$`); `chainId` + `verifyingContract` in the domain make cross-chain replay impossible.
- Key handling: env-only, format-validated on load; startup banner prints the settler *address* only; `/settle` returns 503 with no key; dry-run defaults to true; repo-wide grep found **zero** private-key material.
- Invoice lib: ID is the EIP-712 digest (tamper-evident); token/chain/amount/expiry/nonce/description all enforced; signature must recover to `issuer`; JSON tampering breaks the signature (fail-closed).
- Slither 0.11.6 on contracts: no findings beyond informational (`timestamp` for deadline logic, `assembly` inside OZ libs, pragma/solc-version noise). `Reputation.sol`: zero findings.

**Contracts (reviewer):**
- Reentrancy: single `nonReentrant` guard on all fund-moving functions, checks-effects-interactions, existing `ReentrantUSDC` attack test passes.
- Access control on every state-changing function — fuzz-asserted caller legitimacy across ~24k ops; anvil attacks A1–A4 (non-arbiter resolve, double release, release-without-delivery, early refund) all reverted.
- Arbiter overreach: verified onchain — `resolveDispute` can only pay `job.provider`/`job.payer`; maximum latitude is the 0–10000 split (attack A8: hostile arbiter could not redirect funds).
- Fee math exact (100 USDC → 0.75 fee / 99.25 provider at 75 bps) and constructor-capped at 10% (fuzzed feeBps 0–1000).
- State machine: mirror-checked, terminal states terminal, no double payout.
- Reputation: `onlyEscrow`, no div-by-zero, scores bounded.

---

## Test results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Phase 1 self-tests | 10/10 pass |
| Phase 2 facilitator tests | 20/20 pass |
| `forge test` (existing) | 27/27 pass (24 escrow + 3 reputation) |
| New fuzz `test/sol/AgentEscrowFuzz.t.sol` | 7 property tests × 512 runs — all pass |
| New stateful invariants (same file) | 5 invariants × 512 runs, 24,576 calls — all pass (conservation of funds, exact actor balances, state-machine integrity, fee cap, reputation bounded) |
| Anvil exploit attempts | 8 attacks: A1–A4, A8 **blocked**; A5 (self-deal), A6 (blocklist bricking), A7 (refund race) **succeeded** (confirming M2/H3/M3) |
| Slither 0.11.6 | clean (informational only) |
| Live facilitator exploit tests | H1 and H2 **confirmed** against a local server |

Nothing was broadcast beyond local anvil; only throwaway keys were used.

## Recommended fix priority (before any mainnet volume)

1. **H1** (verify/settle mutual exclusion) and **H2** (nonce-store self-wipe) — both break the facilitator's core function; both are small code changes.
2. **H5** (`token.code.length` check) — one line, eliminates the worst deploy footgun.
3. **H3** (blocklist bricking) — decide: pull-payments redesign vs. explicitly accepted risk + monitoring.
4. **H4** (arbiter) — deploy the arbiter as a multisig at minimum; decide on rotation/escape policy.
5. **M1** (self-deal farming) — one-line `revert` + minimum job amount.
6. **M1-facilitator** (gas-drain) — allowlist/rate-limit `/settle` before mainnet.

## Explicitly NOT covered by this audit

- A professional third-party audit (required before mainnet escrow handles meaningful volume).
- Arbiter bribery/collusion game theory beyond the noted vectors (trust assumption by design).
- Economic analysis of fee levels or facilitator sustainability.
- Real mainnet USDC behavior vs. the `FlagUSDC` mock (mock approximates documented FiatTokenV2 pause/blocklist semantics).
- L2 sequencer trust assumptions (Ink) and gas-level DoS.
- The deploy script was read, not executed against any live chain.
- Formal proof of the fuzz harness's ghost accounting (test code, reviewed but not proven).
- The official website / article artifacts (out of scope).
- Key custody and server ops (founder-held per the ownership rule) — code only reads keys from env; custody itself was not audited.
