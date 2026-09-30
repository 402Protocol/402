# Four02ValidationRegistry: staked validation for the 8004 agent stack

**Status:** spec for Father's review (2026-09-27). No code, no deploys.

## What it is

A general-purpose validation primitive for the 8004 agent economy on Ink — not just
a dispute module for our marketplace. Anyone can request validation of any agent's
work: permissionless validators stake USDC, score the work 0-100 through commit-reveal,
and the median score becomes a staked, onchain, Schelling-backed attestation anyone in
the stack can read — marketplaces, reputation systems, agent directories, other agents
deciding who to hire.

The 402 marketplace is the first consumer: disputed bounties become validation cases,
and the median score settles the dispute on BountyEscrow. But the registry doesn't
know or care about escrow — it validates work, full stop.

Positioning, stated plainly: this is **our** validator, not the 8004 team's. Their
ValidationRegistry spec is still in revision with no mainnet deployment anywhere
(testnets only). We are not squatting their vanity address or claiming canonical
status. The record schema mirrors their draft shape so our attestations stay portable
if/when they finalize — a contribution to the stack, not a land grab.

## Design goals

1. **General first, marketplace second.** The core is `requestValidation(agentId,
   evidenceURI)` → staked median score. Dispute settlement is one consumer of that
   primitive, wired through the escrow's arbiter role.
2. **No escrow changes.** Marketplace integration is purely through appointing the
   registry as BountyEscrow's arbiter (existing 14-day timelocked rotation). If the
   validator system ever fails, rotate the arbiter back — the escrow doesn't care.
3. **Schelling, not voting.** Validators don't vote their opinion; they guess the
   median. Commit-reveal kills herding. The median is manipulation-resistant.
4. **Liveness over perfection.** Quorum failure escalates (disputes: human backstop,
   then the escrow's 30-day 50/50 timeout). Funds and requests never rot because
   validators went quiet.
5. **Same hardening bar as the marketplace:** no upgrades by design, ReentrancyGuard,
   pull-payments for all validator payouts, two adversarial audits before deploy,
   professional audit before meaningful volume.

## Contracts

One contract: `Four02ValidationRegistry`.

External references (all immutable at deploy):
- `escrow` — BountyEscrow (`0xdf319a060eaa361aa906855c64ccbc941159c01c`)
- `token` — Ink USDC (`0x2D270e6886d130D724215A266106e6832161EAEd`)
- `identityRegistry` — `0x7274e874CA62410a93Bd8bf61c69d8045E399c02` (optional agent binding)
- `humanFallback` — Father's fresh wallet (quorum-failure backstop only)

## Validator lifecycle

**`stake(uint256 amount, uint256 agentId)`** — permissionless, **agents only**.
`agentId` is required (nonzero) and the registry checks
`identityRegistry.ownerOf(agentId) == msg.sender` — you can only validate as an
agent you own, same fail-closed binding as `claimBounty`. The identity is the
admission ticket; the stake is the ongoing bond. Ownership is checked at stake
time (a later transfer doesn't touch the position — the slashable stake does the
real work). One stake position per address (subsequent `stake()` calls top up).

**`requestUnstake()` / `withdrawUnstake()`** — two-step with `UNSTAKE_DELAY` (suggested 7 days).
A validator with an open commitment (unrevealed) or an unresolved request they voted in
cannot complete withdrawal until the request resolves — no vote-and-run.

**Slashing** — `SLASH_BPS` (suggested 1000 = 10%) of stake for a revealed score outside
the honest band. Slashed funds go to the honest validators of that case, pro-rata by
commit-time stake snapshot. A validator who commits but never reveals forfeits
`VOTE_BOND` (suggested $5) into the reward pool on resolution — committing then
watching reveals and staying silent is no longer a free option. Bonds are refunded
in full when a request Fails or is Voided.

## Request lifecycle

Two request types share one validator set, one commit-reveal machine, and one
incentive scheme. Every request produces an onchain validation record anyone can read.

### General validation — `requestValidation(agentId, evidenceURI)`

Anyone may request validation of any agent's work: pass the agent's 8004 `agentId`
(must exist — `ownerOf` reverts otherwise) and an `evidenceURI` (IPFS hash of the
work, a submission link, whatever the requester wants judged). The requester pays
`CASE_FEE` (suggested $1 USDC), held for the honest validators. Commit → reveal →
median, exactly as below. The result is a permanent, staked attestation:
"on this date, staked validators scored agent N's work at X/100."

This is the 8004-stack primitive: a hiring agent can check a worker's validation
history before posting a bounty; a directory can rank agents by median validation
score; our own reputation registry can consume it in v2.

### Dispute validation — `openDisputeCase(jobId)`

The marketplace consumer. Anyone may call once the job is `Disputed` on the escrow
(read via `escrow.getJob(jobId)` — BountyEscrow exposes ONLY `getJob`; its `jobs`
mapping is private, and calling a non-existent `jobs()` selector reverts — revert
otherwise). The opener pays `CASE_FEE`.
Same commit → reveal → median, except the median also settles money: the registry
(as escrow arbiter) calls `escrow.resolveDispute(jobId, median * 100)`.

A withdrawn dispute voids its case (`voidCase`, callable by anyone once the job
leaves `Disputed` without registry resolution). Committed stakes unlock.

### Commit → reveal → resolve (shared)

1. **Commit phase** (`COMMIT_WINDOW`, suggested 3 days) — `commitVote(requestId, bytes32 commitment)`
   where `commitment = keccak256(score, salt)`, `score` in 0-100. One commit per
   validator per request; zero commitments rejected. Each commit locks `VOTE_BOND`
   (suggested $5 USDC, refunded on reveal) and snapshots the validator's stake for
   pro-rata rewards — topping up after committing cannot farm a larger share.
   Validators must hold at least `MIN_STAKE` (a validator slashed below minimum
   cannot vote until topping back up). On dispute cases, validators who are a party
   to the job (`payer`/`provider`) revert with `SelfValidation`; on general
   validations, a validator cannot score their own `agentId` (no manufacturing
   your own 100/100 record for $1).
2. **Reveal phase** (`REVEAL_WINDOW`, suggested 4 days) — `revealVote(requestId, uint8 score, bytes32 salt)`.
   Hash must match the commitment. The vote bond is refunded on reveal.
3. **Resolution** — after the reveal window, anyone calls `resolveRequest(requestId)`:
   - If `reveals >= QUORUM` (suggested 3, minimum 3 enforced): `median` of revealed scores
     via O(n) counting sort over the bounded 0-100 range (no quadratic storage sort).
     Honest = `|score - median| <= HONEST_BAND` (suggested 20, must be <= 100). Slash the dishonest
     (`SLASH_BPS` of stake → honest set), pay the honest (case fee + slash proceeds +
     forfeited bonds of non-revealers, pro-rata by commit-time stake snapshot, as
     pull-payment claims). The validation record is finalized
     onchain. On dispute cases, the registry then calls
     `escrow.resolveDispute(jobId, median * 100)`. Emits `RequestResolved`.
   - If quorum not reached: the request is marked `Failed`; bonds refunded; the case
     fee refunded. Dispute cases escalate
     to the human backstop (below); general validations simply record the failure
     (requester can re-request — paying the fee again).

**`resolveAsHuman(uint256 jobId, uint256 providerShareBps)`** — only `humanFallback`,
only when the case is `Failed`, only once. Forwards to `escrow.resolveDispute`.
The human can never touch a case that reached quorum — consensus is final.

**Liveness backstop:** if the human also never acts, the escrow's own 30-day
`resolveDisputeTimeout` still 50/50-splits the job. Three-deep fallback:
validators → human → timeout. Funds never rot.

## Scoring rule

Median of revealed scores (even count: average of the two middle scores, rounded down),
mapped to basis points by ×100. Rationale: the median is the Schelling point — the
score a thoughtful validator expects other thoughtful validators to give. It resists
outlier manipulation far better than the mean, and it produces natural partial splits
(70 → 7000 bps) for partial-delivery disputes without a second mechanism.

Binary disputes ("delivered or not") are just scores near 0 or 100 — no special case needed.

## Incentives

| Actor | Reward | Penalty |
|---|---|---|
| Honest validator (in band) | share of `CASE_FEE` + slash proceeds + forfeited bonds, pro-rata by commit-time stake snapshot | — |
| Dishonest validator (out of band) | — | `SLASH_BPS` of stake → honest set |
| Case opener | — | pays `CASE_FEE` (sunk; buys the vote) |
| Validation requester | a staked onchain attestation of the work | pays `CASE_FEE` (sunk) |
| Non-revealing committer | — | forfeits `VOTE_BOND` into the reward pool (refunded if Failed/Voided) |
| Dispute winner (party) | escrow split per median | unchanged escrow rules |

All validator payouts are **pull-payments** (`claimRewards()`), same posture as the
escrow's H3: a blocklisted validator can't brick anyone else's rewards.

## BountyEscrow integration (zero escrow changes)

1. Deploy `Four02ValidationRegistry` with `escrow`, `token`, `identityRegistry`,
   `humanFallback`, and the economic immutables below.
2. Father proposes an arbiter rotation on BountyEscrow: arbiter → registry address.
   The existing 14-day timelock + guardian rules apply unchanged.
3. After the timelock, the registry is the arbiter. `resolveDispute` can now only be
   reached through `resolveRequest` on a dispute case (validator consensus) or
   `resolveAsHuman` (quorum-failure backstop).
4. Rollback: the guardian rotation path still works — rotate back to the human wallet
   any time. The escrow never knows the difference.

Reputation: dispute resolution records the same `DisputeResolved` / `ArbitrationWon` /
`ArbitrationLost` events as today (the escrow does it; the registry just triggers it).
Validator-specific reputation (honest/slashed counts) is **v2** — it needs new event
types, which means a V3 reputation registry. The validator economics (stake/slash) are
fully onchain in v1; the resume layer follows.

## 8004 forward-compatibility

Every resolved request — general or dispute — is stored as a validation record shaped
like the 8004 draft:

```solidity
struct Validation {
    address validator;
    uint256 subjectAgentId;  // validated agent (disputes: the worker's agentId)
    uint8   score;           // 0-100
    string  responseURI;     // evidenceURI from the request
    uint64  validatedAt;
}
```

Exposed via `getValidation(requestId, validator)` and `getRequestResult(requestId)`
(median, reveal count, finalized-at). If the canonical ValidationRegistry finalizes
with this shape, our records are portable — and any 8004 tooling that learns to read
validation scores can read ours.

## Security considerations (audit checklist seed)

- **Herding:** commit-reveal is mandatory, not optional. No vote counts are visible
  during the commit phase (only commitment hashes).
- **Validator-party collusion / bribery:** `SelfValidation` blocks parties from voting on their
  own jobs — but only by address, not by sock-puppet. The load-bearing assumption is
  an honest majority of *voters*: a corrupted majority defines the median and is never
  slashed, so the cost to buy a dispute outcome is ~51% of voters × `MIN_STAKE` in
  temporarily-locked capital (~$500 at n=5), NOT slash risk. This does not scale with
  bounty size. **Consequence: do not rotate the escrow's arbiter to this registry
  until addressed** (sortition, value-bounding, or quorum scaling). Advisory mode
  (human arbiter follows medians by policy) is safe because the human sees the votes.
- **Lazy-50 equilibrium:** diligent review pays `CASE_FEE`/n per case (~$0.20), so
  blind 50-voting is the cheap Nash equilibrium and converges disputes to 50/50.
  Mitigations: `VOTE_BOND` makes blind voting risky (you must reveal into whatever
  median emerges), tighter `HONEST_BAND` punishes focal voting more often, higher
  `CASE_FEE` pays for diligence. Monitor post-launch median distributions for
  50-clustering. No clean onchain fix exists; documented as residual risk.
- **Registry-as-arbiter trust:** the registry can only pass a `providerShareBps`
  derived from a quorum median (or nothing, in the human path). It cannot move funds,
  mint claims, or call any other escrow function. Fund accounting stays in the escrow.
- **Human fallback scope:** `resolveAsHuman` reverts while a validator vote is live
  (`Open`), so consensus can never be overridden or front-run. It MAY resolve when
  no case was ever opened (liveness: a dispute nobody paid $1 to put to validators)
  or after a case Failed/Voided — the escrow itself enforces registry-is-arbiter.
  In advisory mode the human calls the escrow directly (no registry event fires).
- **Reentrancy:** `nonReentrant` on all state-changing functions; CEI ordering; the
  escrow call happens last in `resolveRequest` (dispute path).
- **Stale dispute cases:** a dispute withdrawn on the escrow voids the case (`voidCase`
  callable by anyone once the job leaves `Disputed` without resolution through the
  registry). Committed stakes unlock.
- **Griefing via request spam:** `CASE_FEE` makes each request cost $1; the requester pays it.
- **Under-quorum permanent stall:** covered by the three-deep fallback.
- **Upgradeability:** none, by design. Parameter changes need a new deployment +
  arbiter rotation.

## Economic parameters — Father's calls

| Parameter | Suggested | Notes |
|---|---|---|
| `MIN_STAKE` | $100 USDC | Sybil price per validator identity |
| `UNSTAKE_DELAY` | 7 days | |
| `COMMIT_WINDOW` | 3 days | |
| `REVEAL_WINDOW` | 4 days | |
| `QUORUM` | 3 reveals | |
| `HONEST_BAND` | ±20 points | |
| `SLASH_BPS` | 1000 (10%) | of stake, to the honest set |
| `CASE_FEE` | $1 USDC | from opener, to the honest set |
| `VOTE_BOND` | $5 USDC | per commit, refunded on reveal; forfeited by non-revealers |
| `humanFallback` | fresh wallet | quorum-failure only, never overrides consensus |

## Test plan (forge)

- Median rule: odd/even counts, rounding, all-identical, single outlier resistance.
- Commit-reveal: wrong salt reverts, double commit reverts, reveal outside window reverts.
- Quorum: 2 reveals → `Failed` → human path works (disputes); human path on a quorate
  request reverts.
- Slashing math: honest/dishonest split of fee + slash, pull-payment claims.
- Self-validation: payer/provider cannot commit on their own dispute case.
- General validation: `requestValidation` on a nonexistent agentId reverts; resolved
  record readable via `getRequestResult`.
- Integration (fork test against the deployed escrow): rotate arbiter → dispute →
  vote → `resolveRequest` → escrow `Resolved` with median split. Rollback rotation works.
- Adversarial: bribed minority cannot move the median; vote-and-run blocked by
  unstake lock; reentrancy attack test (same harness as the marketplace audit).

## Audit & deploy plan

Same bar as the marketplace: two adversarial AI audits, all findings fixed, suites
green, then Father's explicit deploy authorization. Professional audit before
meaningful volume. Deploy sender: treasury; initial owner: the fresh wallet (same
standing rule as all 402 contracts).

### Audit results, 2026-09-27 — both auditors: DO NOT SHIP (then fixed)

**Audit 1 (security/correctness):**
- **Critical — `jobs()` does not exist on BountyEscrow.** The interface declared
  `jobs(uint256)`; the real escrow's mapping is private and exposes only `getJob`.
  Every dispute function would have reverted on mainnet. The mock implemented the
  fictional interface, so 47 green tests concealed it. **Fixed:** `getJob` at all
  three call sites + fork test asserting the selector exists on the deployed escrow
  (`0xDF319a060EAA361AA906855c64CCbc941159C01C`).
- **Medium — O(n²) storage insertion sort** bricked `resolveRequest` past ~150 voters
  (~19M gas at 120 reveals), permanently locking committers' stakes. **Fixed:**
  O(n) counting sort over the bounded 0-100 range (9.4M gas at 200 voters, measured).
- **Medium — no self-validation check on General requests** (a validator could
  manufacture a 100/100 record on their own agentId for $1). **Fixed:** one-line
  `SelfValidation` check mirroring the dispute path.
- **Low — advisory-mode re-dispute permanently blocked** the registry for that job.
  **Fixed:** `CaseAlreadyOpen` only blocks a *live* case.
- Notes (accepted/documented): reveal optionality, reward dust, `requestUnstake`
  `nonReentrant` (added for uniformity), `humanFallback` immutability, agentId
  transfer mid-case.

**Audit 2 (game theory / mechanism design):**
- **Critical — 51%-of-voters capture.** A ~$500 Sybil majority (5 fresh agentIds ×
  $100 stake, committed in the last block) buys any dispute outcome risk-free: the
  majority defines the median and is never slashed; honest validators ARE slashed
  and their slash funds the attacker. Bribery costs O(n) regardless of bounty size.
  **Not fixable by parameter tuning** — see below. Blocks the binding arbiter
  rotation. Path: advisory deployment first (human arbiter, follows medians by
  policy), then sortition with VRF randomness and/or stake-weighted selection
  before any rotation. (Note: value caps do NOT fix this — the attacker's stake
  is refundable, so any bounty size is profitable to attack; caps only change
  which disputes are exposed, never the sign of the attacker's ROI.)
- **High — lazy-50 equilibrium** (diligence pays $0.20; blind 50-voting is the cheap
  Nash). **Mitigated:** `VOTE_BOND` makes blind voting risky; documented as residual.
- **High — selective-reveal free option.** **Fixed:** `VOTE_BOND` ($5, suggested)
  pulled at commit, refunded on reveal, forfeited to the pool by non-revealers.
- **Medium — equal reward split converges stakes to minimum.** **Fixed:** pro-rata
  by commit-time stake snapshot (top-ups after commit can't farm).
- **Low — constructor footguns** (`quorum < 3`, `honestBand > 100`), **zero-commitment
  DoS**. **Fixed:** `BadQuorum` / `BadHonestBand` guards, `bytes32(0)` rejected.

**Post-fix verification:** 59/59 validator tests (12 new regression tests incl. the
fork selector test), full repo suite green, `forge build` clean. Gas measured, not
estimated.

## Open questions

1. ~~Should validators be agents only, or may pure-capital stakers validate?~~
   **Decided 2026-09-27 (Father): agents only** — `agentId` required at stake time.
   Every validation is attributable to an agent, which also makes the v2
   validator-reputation integration natural.
2. v2: validator reputation events in a V3 registry (new EventType variants)?
3. v2: inactivity slash for commit-without-reveal?
4. Should the case fee scale with bounty size (e.g., 0.1% of bounty, min $1)?
