# 402 — Invoices + x402 Facilitator + Escrow

Agent-to-agent payments in **native USDC on Ink** (chain 57073).

- **Phase 1 — Invoices:** EIP-712 signed invoices, offchain. No smart contracts.
- **Phase 2 — Facilitator:** x402 v2 facilitator (`POST /verify`, `POST /settle`,
  `GET /supported`) for the `exact` scheme on EVM, settling via EIP-3009
  `transferWithAuthorization`. Plus a demo paid endpoint.
- **Phase 3 — Escrow:** `AgentEscrow.sol` + `Reputation.sol` (Foundry).
  Onchain escrow for agent jobs with delivery risk, arbiter dispute resolution,
  and a lightweight v0 reputation ledger.

## Layout

```
src/
  invoice.ts        # EIP-712 invoice library: sign, verify, hash, JSON round-trip
  constants.ts      # chain + verified USDC address (0x2D27…EAEd)
  settle.ts         # USDC transfer ABI + Transfer log scanning
  facilitator/
    types.ts        # x402 v2 wire types (payloads, requirements, responses)
    chains.ts       # chain registry: RPC, USDC, EIP-712 domain per chain
    eip3009.ts      # EIP-3009 domain/types/ABI, signature split, sign helper
    nonces.ts       # in-memory replay protection (v0 limitation, see below)
    verify.ts       # /verify core: signature + policy checks, no RPC
    settle.ts       # /settle core: verify -> onchain checks -> broadcast
    config.ts       # env-only config (keys never in code/args)
    server.ts       # Hono app: /supported, /verify, /settle, /demo/data, /health
  cli/
    issue.ts        # issue_invoice  (implicit approval)
    pay.ts          # pay_invoice    (explicit approval; dry-run by default)
    status.ts       # invoice_status (read-only)
    facilitator.ts  # run the facilitator server
test/
  selftest.ts       # Phase 1: 10 offline checks
  facilitator.test.ts  # Phase 2: 32 tests (verify matrix + dry-run settle + HTTP + settle auth)
  sol/
    AgentEscrow.t.sol  # Phase 3: Foundry tests (escrow lifecycle, pull payments,
                     # arbiter rotation, grace window, reentrancy, reputation)
    AgentEscrowFuzz.t.sol  # fuzz properties + stateful invariants
contracts/
  AgentEscrow.sol   # USDC job escrow: fund → deliver → release (pull-payment
                    # claims), disputes, grace-window refunds, timelocked arbiter rotation
  Reputation.sol    # v0 reputation ledger (escrow-recorded completions/losses)
script/
  Deploy.s.sol      # founder-run forge deploy script (NOT run by agents)
foundry.toml        # Foundry config (src=contracts, test=test/sol)
skill/
  SKILL.md          # the Muse skill (symlinked to ~/workspace/skills/402)
```

## Quickstart — invoices

```bash
cd ~/workspace/402
npm install

# Issue (needs FOUR02_ISSUER_KEY in env — founder holds keys)
npx tsx src/cli/issue.ts --issuer 0xISSUER --amount 1.50 \
  --description "10k embeddings API calls" --terms "full terms text…" \
  --out invoice.json

# Check (read-only)
npx tsx src/cli/status.ts --invoice invoice.json

# Pay: dry run first (needs FOUR02_PAYER_KEY in env)
npx tsx src/cli/pay.ts --invoice invoice.json
# …after the founder approves that exact payment in chat:
npx tsx src/cli/pay.ts --invoice invoice.json --broadcast
```

## Quickstart — facilitator

```bash
cd ~/workspace/402

# Safe local mode: no key needed for /verify, /supported, /demo/data.
# /settle refuses (503) without a settler key.
FOUR02_DEMO_PAYTO=0xYourAddress npx tsx src/cli/facilitator.ts

# Full mode (founder only — settler key pays gas and broadcasts):
FOUR02_SETTLER_KEY=0x... FOUR02_SETTLE_API_KEYS=key1,key2 \
  FOUR02_DRY_RUN=false FOUR02_DEMO_PAYTO=0x... \
  npx tsx src/cli/facilitator.ts
```

Env vars:

| Var | Default | Purpose |
|---|---|---|
| `FOUR02_SETTLER_KEY` | — | Settler private key. **Founder-held.** Without it `/settle` → 503 `missing_settler_key`. Never a CLI arg, never in code. |
| `FOUR02_SETTLE_API_KEYS` | — | **Comma-separated API keys for `POST /settle`** (M1). `/settle` spends operator gas, so it requires a key via the `x-api-key` header, `Authorization: Bearer <key>`, or `?api_key=`. Missing/invalid → 401 `unauthorized`. **Unset = `/settle` refuses everything with 503** `settle_auth_not_configured` (fail closed, same posture as a missing settler key). Issue keys to known resource servers + the demo; rotate by changing the env. |
| `FOUR02_DRY_RUN` | `true` | `true` = `/settle` simulates via `eth_call` and never broadcasts. Set `false` to settle for real. |
| `FOUR02_PORT` | `4022` | Listen port. |
| `FOUR02_DEMO_PAYTO` | — | Recipient for `GET /demo/data`. Required for the demo. |
| `FOUR02_DEMO_PRICE_USDC` | `0.01` | Demo price in USDC. |

### Endpoints

- `GET /supported` → `{ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:57073" }], extensions: [], signers? }`
  (`signers` appears only when a settler key is configured.)
- `POST /verify` ← `{ paymentPayload, paymentRequirements }` →
  `{ isValid, invalidReason, payer? }`. Offchain: EIP-712 recovery of the
  `TransferWithAuthorization`, value == price, `to` == `payTo`, `validAfter ≤
  now < validBefore`, nonce unused. **Read-only: never consumes the nonce**
  (consuming here used to make every verify → settle flow fail — audit H1).
- `POST /settle` ← same body → `{ success, transaction?, network?, payer?,
  errorReason? }`. Re-verifies, checks onchain `authorizationState` +
  payer balance, then broadcasts `transferWithAuthorization` (payer →
  recipient directly; the facilitator never custodies funds). Consumes the
  nonce only after broadcast confirmation or a passed dry-run simulation.
  **Requires an API key** (`x-api-key` header, `Authorization: Bearer`, or
  `?api_key=`; 401 `unauthorized` without one) and refuses with 503
  `settle_auth_not_configured` when `FOUR02_SETTLE_API_KEYS` is unset (M1 —
  every call can spend operator gas, so anonymous callers can't trigger it).
- `GET /demo/data` — the x402 loop in one route: no `PAYMENT-SIGNATURE`
  header → `402` + `PAYMENT-REQUIRED` header (base64 `PaymentRequired`); valid
  signed payload → settlement → `200` + data + `PAYMENT-RESPONSE` header.
  In dry-run mode it serves the data after successful *verification* with
  `dryRun: true` (nothing settles; the header says so honestly) **and
  consumes the authorization nonce — one signature buys one access, even in
  dry-run** (audit L1).
- `GET /health` → `{ ok: true, dryRun, time }`.

HTTP hardening (audit L3): JSON bodies are capped at 64 KiB (413
`body_too_large` beyond that), and a per-IP fixed-window rate limiter guards
every route — 600 req/min globally, 30 req/min on `/settle` (429
`rate_limited` with `Retry-After`). Both are per-process in v0; put a real
limiter at the edge for multi-instance deploys. `/settle` should additionally
be allowlisted before production (audit M1 — design proposal in
`audits/2026-09-22-fix-designs.md`).

### invalidReason / errorReason codes

`invalid_request`, `unsupported_version` (only x402 v2), `unsupported_scheme`
(only `exact`), `invalid_network`, `invalid_asset`, `invalid_amount`,
`invalid_pay_to`, `invalid_exact_evm_payload`,
`invalid_exact_evm_payload_signature`, `requirements_mismatch` (payload's
`accepted` ≠ the requirements), `amount_mismatch`, `recipient_mismatch`,
`authorization_not_yet_valid`, `authorization_expired`, `nonce_replay`,
`authorization_already_used`, `insufficient_funds`, `missing_settler_key`,
`dry_run_mode`, `settlement_failed`.

### Spec interpretations (ours, where x402 is ambiguous)

- **EIP-712 domain for Ink USDC is `name: "USDC"`, `version: "2"`** — verified
  against the live contract's `DOMAIN_SEPARATOR` (Ink's `name()` returns
  `"USDC"`, unlike mainnet's `"USD Coin"`). Getting this wrong silently breaks
  every signature check.
- `/verify` is fully offchain (no balance check); `/settle` checks
  `authorizationState` + `balanceOf` onchain before broadcasting.
- `validBefore` is exclusive (`now < validBefore`); `validAfter` inclusive.
- Nonce lifecycle (audit H1/H2): `/verify` never consumes; `/settle`
  consumes only after broadcast confirmation or a passed dry-run simulation;
  `/demo/data` consumes on grant (even in dry-run). A *failed* simulation
  leaves the nonce free so the payer can fund and retry. The in-memory store
  sweeps against the real clock — it used to wipe itself at 10k entries.
- We do not enforce `maxTimeoutSeconds` against `validBefore`; the
  authorization's own time bounds are the policy.
- Dry-run `/settle` returns `success: false, errorReason: "dry_run_mode"` —
  honest about no funds moving, with the simulation outcome in `detail`.

### v0 limitations

- **Nonce store is per-process memory.** A restart (or a second instance)
  forgets consumed nonces. The onchain `authorizationState` check backstops
  `/settle`, but `/verify` alone can't catch cross-restart replays. Production
  wants a shared store (Redis/D1/DynamoDB).
- **One chain** (Ink 57073). Adding a chain = one entry in
  `src/facilitator/chains.ts` (RPC, USDC address, EIP-712 name/version) —
  no Ink-specific code paths anywhere else. Robinhood Chain (4663) is next.
- Only the `exact` scheme; no `upto`/Permit2, no Solana.

## Approval posture

| Action | Approval |
|---|---|
| `issue_invoice` | implicit (creates a request, spends nothing) |
| `pay_invoice` / `--broadcast` | **explicit user approval of that exact payment** |
| `invoice_status`, `GET /supported`, `POST /verify` | none (read-only) |
| `POST /settle` | payer pre-authorized by signing the EIP-3009 authorization; the **operator** (founder) authorizes gas spend by configuring `FOUR02_SETTLER_KEY` + `FOUR02_SETTLE_API_KEYS` + `FOUR02_DRY_RUN=false`. No silent spending: dry-run is the default, and without an API-key allowlist `/settle` refuses outright (503). |

Agents propose, humans approve. The facilitator moves only payer-authorized
funds and never custodies them; its only cost is gas, gated behind the
founder-held settler key.

## Key ownership

**Israel (founder) holds all production keys** — deployer, arbiter,
issuer/payer, and the facilitator settler key — and runs all deploys. This repo
reads keys from the environment at runtime only. Tests generate throwaway keys
in-process; nothing is broadcast during tests.

## Verified constants (2026-09-22)

- Ink chain ID: **57073** (`https://rpc-gel.inkonchain.com`)
- Native USDC: **`0x2D270e6886d130D724215A266106e6832161EAEd`**, 6 decimals,
  Circle FiatTokenV2 (EIP-3009 supported). Announced on Circle's blog; confirmed
  via live RPC + Blockscout. Not the bridged deployment.
- EIP-712 domain for EIP-3009 on Ink USDC: name `"USDC"`, version `"2"`,
  chainId 57073 — confirmed against onchain `DOMAIN_SEPARATOR`.

## What's next (Phase 3)

`AgentEscrow.sol` + onchain reputation — **done, see below**. Facilitator
settlement stays as the fast path for pay-per-call; escrow covers jobs with
delivery risk.

---

## Phase 3 — AgentEscrow.sol + Reputation v0

Onchain escrow for agent jobs where delivery risk matters. Built with Foundry
(forge 1.8.3, solc 0.8.28) on OpenZeppelin v5 contracts. **No chain-specific
code anywhere** — the settlement token is a constructor param, so the same
bytecode deploys on Ink, Robinhood Chain (4663), or any EVM chain.

### State machine

Terminal transitions **record claims** (H3 pull payments) — they never push
tokens. Each payee withdraws their own share with `claim(jobId)`
(permissionless to call; only the recorded payee's entry moves; zeroed
before the transfer). A blocklisted payee's revert touches only their own
claim transaction.

```
                  ┌──────────────┐
                  │    Funded    │◄── createJob (payer locks USDC via transferFrom)
                  └──────┬───────┘
            ┌────────────┼─────────────────────────────┐
            │            │                             │
     confirmDelivery  raiseDispute          refund (deadline + refundDelay
     (provider)     (payer/provider)        passed; anyone; records payer claim)
            │            │                             │
            ▼            ▼                             ▼
     ┌────────────┐ ┌──────────┐                ┌──────────┐
     │ Delivered  │ │ Disputed │                │ Refunded │
     └─────┬──────┘ └────┬─────┘                └────┬─────┘
           │  raiseDispute│ resolveDispute           │
      release│            │ (arbiter only)           │
      (payer)│            │ records split            │
           │      ┌───────┴──────┐                   │
           ▼      │   Resolved   │                   │
     ┌──────────┐ └──────────────┘                   │
     │ Released │                                    │
     └────┬─────┘  records:                          │
          │  provider ← amount − fee                  │
          │  feeRecipient ← fee                       │
          └──────────────┬────────────────────────────┘
                         │
              claim(jobId): each payee withdraws their own recorded
              share. Unclaimed funds sit in the contract; recipients
              must send a claim transaction (gas cost is theirs).
```

Refund grace window (M3): `refund` opens at `deadline + refundDelay`
(default 24h), not at the deadline. During `[deadline, deadline +
refundDelay]` only `confirmDelivery` (provider) and `raiseDispute` (either
party) can move the job — a provider's delivery can't lose a mempool race
to a refund in the deadline block, and late delivery inside the window is
specified behavior.

### Contracts

- **`contracts/AgentEscrow.sol`** — the escrow. Roles: **payer** (per-job,
  the caller of `createJob`), **provider** (per-job), **arbiter** (global,
  rotatable via timelocked proposal — see below), **guardian** (founder EOA,
  can only *propose* rotations, never touch funds). `ReentrancyGuard` on
  every fund-moving function, checks-effects-interactions throughout (claims
  are zeroed *before* any token transfer), custom errors, and an event for
  every transition.
  **Pull payments (H3):** `release` / `resolveDispute` / `refund` record
  claims instead of pushing tokens; each payee withdraws via `claim(jobId)`.
  One blocklisted party can no longer brick anyone else's payout — each
  claim is an independent transaction touching only the claimant. The fee
  is just another claim, so a blocklisted fee recipient bricks only its own
  fee, never the protocol.
  **Arbiter rotation (H4):** `proposeRotation(newArbiter)` by the arbiter or
  guardian, then `confirmRotation()` by anyone after a 14-day public
  timelock (`ROTATION_DELAY`); `cancelRotation()` by arbiter/guardian.
  The constructor deploys the paired `Reputation` ledger (only the escrow
  can record to it).
- **`contracts/Reputation.sol`** — v0 ledger. Tracks per-provider
  `completedJobs` and `lostDisputes`. `score(provider)` returns
  `completed * 10_000 / (completed + lost)` (bps); **0 when the provider has
  no history** — "unknown", not "untrusted". `stats()` returns the full
  line. Known limits, by design: sybil-vulnerable (a fresh address starts
  clean), unweighted by job value, and dispute outcomes are binary (a 90/10
  split counts the same as 51/49).

Audit hardening (2026-09-22): `createJob` reverts on self-dealing
(`provider == payer` — one self-job used to mint a perfect reputation score
at dust cost, since the fee rounds to zero on tiny amounts). Deliberately
**no minimum job amount** — legit micro-jobs are the product; the revert
kills the farming vector (farming now needs a second colluding party, which
is the documented sybil caveat, not a free mint). The constructor also
reverts if the token address has no contract code (`NotContract`), so a
wrong-chain deploy can't silently create jobs backed by zero tokens.

### Constructor params — the founder decides these at deploy

| Param | What it is | Default in `script/Deploy.s.sol` |
|---|---|---|
| `token_` | Settlement token address | Ink native USDC `0x2D27…EAEd` (change per chain) |
| `arbiter_` | Dispute resolver: **your EOA or your multisig** (rotatable later via the timelocked mechanism) | `address(0)` — **you must set this** |
| `feeRecipient_` | Where protocol fees go (an address you control) | `address(0)` — **you must set this** |
| `feeBps_` | Protocol fee in bps (75 = 0.75%) | `75` — **proposed, NOT final; needs your approval** |
| `refundDelay_` | Grace window after the deadline before `refund` opens (seconds) | `1 days` (86400) — review this |
| `guardian_` | Rotation guardian: **your EOA**. Can propose arbiter rotations; **cannot touch funds**. Recovery path if the arbiter key is lost | `address(0)` — **you must set this** |

Onchain guardrails: fee is capped at `MAX_FEE_BPS = 1000` (10%) — anything
higher reverts at construction. The token address must have contract code
(`NotContract`) — a wrong-chain deploy reverts instead of silently creating
jobs backed by zero tokens, and `script/Deploy.s.sol` additionally refuses
to run on any chain other than its `EXPECTED_CHAIN_ID`. No fee is taken on
dispute resolutions (MVP choice: the protocol didn't facilitate a clean
settlement). The arbiter is **rotatable, not immutable**: `proposeRotation`
(arbiter or guardian) → 14-day public timelock → `confirmRotation` (anyone);
deploy it as your multisig regardless — rotation is the fallback, not the
plan. The guardian can never move funds, only rotate the arbiter after the
public delay.

### Test

```bash
cd ~/workspace/402
forge test            # escrow lifecycle, disputes, refunds, pull-payment
                      # claims, arbiter rotation, grace window, access control,
                      # reentrancy attack, reputation math + fuzz/invariants
```

Covers: happy path with exact fee math (100 USDC → 0.75 fee, 99.25 to
provider — recorded as claims, withdrawn via `claim()`), dispute won by
payer (full claim recorded, lost-dispute recorded), dispute split 70/30,
refund after deadline + grace window (permissionless trigger, payer claims),
refund reverts before deadline / during the grace window / for delivered
jobs, delivery and dispute allowed during the grace window, arbiter
rotation happy path (guardian proposes → anyone confirms after 14 days →
new arbiter resolves, old cannot), premature confirm / non-proposer /
no-proposal / cancel / re-propose-restarts-clock rotation cases,
non-arbiter / non-payer / non-provider / third-party reverts,
double-release and double-claim reverts, zero amount / past deadline / zero
provider reverts, fee cap, share > 100% reverts, a live reentrancy attack
via a malicious token whose contract is the claimant (blocked, paid exactly
once), reputation-only-escrow access, plus fuzz properties (fee math across
the fee range, dispute conservation, refund boundary, blocklisted-claimant
isolation) and stateful invariants (fund conservation, exact per-account
balances, state-machine integrity, claim accounting, fee cap).

### Deploy — founder runs this, with founder keys

```bash
# 1. Edit script/Deploy.s.sol: set ARBITER, FEE_RECIPIENT, GUARDIAN
#    (and TOKEN for non-Ink chains); review FEE_BPS and REFUND_DELAY.
# 2. Run:
forge script script/Deploy.s.sol \
  --rpc-url <YOUR_RPC> --private-key <YOUR_DEPLOYER_KEY> --broadcast
```

The agents that built this code **never deploy** — not to mainnet, not to
testnet. Local `anvil` only. The deploy script refuses to run until
`ARBITER`, `FEE_RECIPIENT` and `GUARDIAN` are set, and refuses to run on any
chain other than `EXPECTED_CHAIN_ID`.

### Deploy checklist (founder)

1. `ARBITER` — your multisig (recommended) or EOA. Rotatable later via the
   14-day timelock, but deploy it right the first time.
2. `GUARDIAN` — your EOA for proposing rotations. Fund it, back it up, keep
   it offline-ish: it's the recovery path if the arbiter key is lost.
3. `FEE_RECIPIENT` — an address you control for protocol fees.
4. `FEE_BPS` — **75 bps is proposed, not approved.** Set the real number.
5. `REFUND_DELAY` — default 24h; longer = safer providers, slower payer refunds.
6. `TOKEN` / `EXPECTED_CHAIN_ID` — preset for Ink native USDC; change both
   together for another chain.

### v0 limitations (read before mainnet)

- **No upgrade mechanism.** Deliberate for the MVP: the code is the final
  word. A bug means deploying a new escrow, not patching this one.
- **Trusted arbiter.** The arbiter can split any disputed job's funds
  arbitrarily, and rotation takes 14 days. Until the arbiter is a multisig
  or a decentralized mechanism, this is a trust assumption on whoever holds
  the key.
- **Fee economics unapproved.** 75 bps is the founder's proposal, still
  awaiting sign-off. It's a parameter, not a promise.
- **Legal review pending** before the escrow handles meaningful mainnet
  volume.
- Reputation is gameable (see "Known limits" above) — a hiring *signal*,
  not a security boundary.
- **Dispute bond: v1 consideration (L5).** Raising a dispute currently costs
  only gas, so either party can grief-lock the counterparty's capital until
  the arbiter acts. The v1 lever is a dispute bond — the disputer posts a
  bond, forfeited to the counterparty if the arbiter rules against them.
  **Not implemented:** it changes the economics of disputing, which is a
  founder product decision.

### Accepted risks (founder decisions, recorded 2026-09-22)

These are conscious trade-offs, not oversights. Each was a design proposal
in `audits/2026-09-22-fix-designs.md` and was explicitly approved.

- **USDC pause freezes everything (M4).** If Circle pauses USDC, all fund
  movement reverts with no escape hatch. Accepted by design: an admin
  function that can move user funds "during a pause" can move user funds,
  period — it would make the escrow custodial and destroy the
  trust-minimization story. Monitor `Pause`/`Unpause` events offchain;
  revisit only if escrowed value grows large enough that pause-illiquidity
  becomes its own systemic risk.
- **Payer hostage, residual (M3).** A payer who never releases and never
  disputes forces the provider to `raiseDispute` before the deadline —
  there is no provider self-release. Documented; the dispute bond above is
  the v1 lever if this becomes a real pattern.
- **Unclaimed pull payments (H3 trade-off).** Claims never expire and never
  auto-pay; recipients must send a `claim()` transaction, and the gas cost
  shifts from the releaser to each recipient. Unclaimed funds sit in the
  contract indefinitely.
- **Arbiter + guardian key loss (H4 residual).** If the multisig quorum AND
  the guardian key are both lost, disputed funds brick — the contract can
  only raise the bar (multisig at deploy, timelocked rotation as fallback).
  Key management is the real fix.
