# 402 — Audit fix design proposals (2026-09-22)

> **Status 2026-09-22 (evening):** the founder approved all recommendations
> ("Approve all recommendations"). Implemented the same day:
> **H3** full pull payments — `release`/`resolveDispute`/`refund` record
> claims, recipients withdraw via `claim(jobId)` (`contracts/AgentEscrow.sol`);
> **H4** guardian-proposed 14-day timelocked arbiter rotation, arbiter now
> deployable as a multisig; **M1** API-key allowlist on `POST /settle`
> (`FOUR02_SETTLE_API_KEYS`, fail-closed 503 when unset;
> `src/facilitator/config.ts`, `server.ts`); **M3** `refund` opens at
> `deadline + refundDelay` (default 24h); **M4** accepted risk recorded in
> `README.md` (no escape hatch); **L5** dispute bond deferred to v1,
> documented as a consideration. Deploy checklist (arbiter, guardian, fee
> recipient, fee, refund delay) in `README.md` + `script/Deploy.s.sol`.
> All suites green: 56/56 forge, tsc clean, 32/32 facilitator, 10/10
> self-tests. No contracts deployed, nothing broadcast.

These are the findings from the 2026-09-22 security audit that change
architecture or trust assumptions, so they are **not implemented** — the
founder decides. Each section states the problem plainly, lays out options
with trade-offs, and ends with a clear recommendation.

| Item | One-line recommendation |
|---|---|
| H3 blocklist bricking | Implement pull-payments before mainnet volume; minimum viable: make the fee leg pull-based so a blocklisted feeRecipient can't DoS the protocol. |
| H4 immutable arbiter | Deploy the arbiter as a multisig now (no code change); add guardian-proposed timelocked rotation in the v1 contract. |
| M1 gas-drain on /settle | API-key allowlist on /settle (`FOUR02_SETTLE_API_KEYS`) + keep the L3 rate limits as a second layer; defer the facilitator fee until real volume. |
| M3 refund race | Add a delivery-exclusivity grace window (`refund` opens at `deadline + 24h`); document the residual payer-hostage vector. |
| M4 USDC pause | Explicitly accept the risk and record it as a founder decision; do NOT add an escape hatch (it would be a custodian backdoor). |
| L5 dispute griefing | The M3 window formalizes late delivery; consider a dispute bond for v1 (needs founder approval — it changes economics). |

---

## H3 — Blocklisted counterparty permanently bricks escrowed funds

**The problem, plainly.** Native USDC lets Circle blocklist addresses, and any
transfer touching a blocklisted address reverts. The escrow *pushes* funds:
`release` pays the provider and the fee recipient in one transaction,
`resolveDispute` pays both parties, `refund` pays the payer. If anyone on the
receiving end of any leg is blocklisted, the whole transaction reverts and the
money is stuck. Three concrete ways this hurts:

1. Provider blocklisted mid-job → `release` reverts → job funds stuck (the
   arbiter can only unstick it by awarding the provider 0%).
2. Payer blocklisted → `refund` and the payer leg of dispute resolution stuck.
3. **Fee recipient blocklisted → every `release` in the protocol reverts.**
   One address getting blocklisted is a protocol-wide payout DoS — and the
   fee recipient is immutable, so it can't be rotated away.

**Option A — Pull payments (recommended for mainnet).** Stop pushing; record
who is owed what at terminal state and let each party withdraw their own
share with a `claim(jobId)` call. One blocklisted party can no longer brick
the other, because each claim is an independent transaction touching only the
claimant. The fee becomes just another payee in the same claims mapping, so
a blocklisted fee recipient only bricks its own fee, not everyone's payouts.
*Trade-offs:* + eliminates the whole class, including the protocol-wide DoS;
+ each party controls their own withdrawal timing. − Bigger state-machine
change (see below); − UX friction (recipients must send a claim tx instead of
being paid automatically); − unclaimed funds sit in the contract; − gas cost
shifts from the releaser to each recipient.

**Option B — Accepted risk + monitoring.** Keep push payments, document the
risk, and monitor USDC `AddedBlacklister` events for counterparties. This is
honest but weak: monitoring can't *fix* anything because the fee recipient
and arbiter are immutable — by the time the alert fires, the funds are
already stuck. Only viable as a conscious "we accept this" with eyes open.

**Option C — Hybrid minimum.** Make *only the fee leg* pull-based (or
non-reverting): pay the provider first, and let the fee recipient claim its
fee separately. This kills the protocol-wide DoS (the worst vector) with a
small change, while leaving per-job counterparty blocklist risk documented
and accepted.

**Recommendation:** Implement **Option A** before mainnet handles meaningful
volume — the protocol-wide DoS via an immutable fee recipient is not
acceptable for a payments protocol. If shipping speed matters more, do
**Option C** as the floor: never let the fee leg brick the provider leg.

**State-machine changes pull payments would require:**

- `release(jobId)` (payer-only, requires `Delivered`): no transfers. Sets
  state `Released`, records `claims[jobId][provider] = amount - fee` and
  `claims[jobId][feeRecipient] = fee`. Emits `JobReleased` as today.
- `resolveDispute(jobId, providerShareBps)` (arbiter-only): no transfers.
  Sets state `Resolved`, records `claims[jobId][provider]` /
  `claims[jobId][payer]` per the split. Reputation recording unchanged.
- `refund(jobId)`: no transfer. Sets state `Refunded`, records
  `claims[jobId][payer] = amount`. (Uniform pull keeps it simple, though a
  single-leg refund could stay push — decide in implementation.)
- New `claim(uint256 jobId)`: permissionless. Reads
  `claims[jobId][msg.sender]`; reverts if zero; zeroes it *before*
  transferring (checks-effects-interactions); `nonReentrant`; emits
  `Claimed(jobId, msg.sender, amount)`.
- New view `claimable(uint256 jobId, address account)`.
- Invariants to fuzz: sum of claims + claimed == job amount (conservation);
  a claim never pays more than recorded; double-claim impossible (zeroed
  first); blocklisted claimant doesn't affect other claimants' claims.

---

## H4 — Immutable arbiter with no fallback

**The problem, plainly.** The arbiter address is set once at construction and
can never change. If that key is lost (or compromised and abandoned), every
job sitting in `Disputed` is frozen forever. There is no rotation, no timelock,
no dead-man's switch. This was a deliberate v0 simplification, but the
liveness cost of a lost key is total.

**Option A — Multisig arbiter (minimum, no code change).** Deploy with the
arbiter set to a founder-controlled multisig (e.g. 2-of-3) instead of a bare
EOA. *Trade-offs:* + zero contract changes, do it regardless; + raises the
bar from "lose one key" to "lose quorum". − Still a single logical arbiter;
quorum loss or quorum collusion bricks/disposes funds the same way.

**Option B — Timelocked arbiter rotation (recommended for v1).** Add
`proposeRotation(newArbiter)` callable by the current arbiter *or* a
designated `guardian` (founder EOA, set at construction), then
`confirmRotation()` callable by anyone after `ROTATION_DELAY` (e.g. 14 days).
The public delay lets everyone see a malicious rotation coming and stop using
the escrow. *Trade-offs:* + recovers from a lost arbiter key (guardian
proposes, delay passes, new arbiter resolves old disputes); + no new fund-
movement power — the guardian can only *rotate* after a public wait, never
touch funds. − More code and a new trust role; − a compromised guardian can
install a malicious arbiter, but only after 14 days of public visibility.

**Option C — Dead-man's escape hatch.** If a job sits in `Disputed` longer
than N days (e.g. 90) with no arbiter action, anyone may trigger a fallback
(50/50 split or full payer refund). *Trade-offs:* + liveness guaranteed
without trusting anyone new. − Gameable: a party that expects to lose the
arbitration is incentivized to stall toward the fallback; − the fallback
ratio is arbitrary and becomes the Schelling point for every dispute.

**Recommendation:** Do **Option A unconditionally at deploy** — it's free.
Build **Option B into the v1 contract** (it must be in at deployment since
there are no upgrades). Defer **Option C**: its stall-to-fallback griefing
outweighs the benefit while the arbiter is the founder's own multisig and
volumes are small. Document the residual risk: if the multisig quorum is lost
*and* the guardian key is lost, disputed funds still brick — key management
is the real fix, the contract can only raise the bar.

---

## M1 — Unauthenticated `/settle` lets anyone burn the operator's gas

**The problem, plainly.** `POST /settle` is fully public, and every call with
a valid authorization costs the operator RPC round-trips plus — in production
— a broadcast paid by the settler key. Anyone can mint unlimited self-signed
authorizations for free and point them at the facilitator, draining the
settler's gas wallet and RPC quota. Concurrent duplicate submissions can also
both pass the `authorizationState` check before either mines, producing
N-1 reverted transactions the operator pays for. The L3 rate limits now in
place blunt this but don't stop a distributed attacker.

**Option A — API-key allowlist (recommended).** Gate `/settle` on a static
bearer key: `FOUR02_SETTLE_API_KEYS` (comma-separated), checked against the
`Authorization: Bearer` / `X-API-Key` header; 401 without a valid key. Keys
are issued to known resource servers and the demo. *Trade-offs:* + simple,
kills anonymous spam dead; + no protocol changes. − Key issuance/rotation is
operational overhead; − a key-holding resource server can still spam (needs
the rate limits + per-key quotas as well); − the facilitator is no longer
fully permissionless — but settlement was never permissionless: it spends the
operator's gas, so gating it is honest.

**Option B — Per-IP rate limits only.** Already implemented (L3): 30
req/min/IP on `/settle`. *Trade-offs:* + zero config. − Trivially bypassed
with a botnet or rotating proxies; insufficient alone.

**Option C — Facilitator fee on settle.** Charge for settlement (e.g. 25 bps)
so spamming the operator costs the attacker and the gas wallet funds itself.
*Trade-offs:* + economic self-defense. − Real protocol work: an `exact`-scheme
EIP-3009 authorization moves an exact amount to an exact recipient — the
facilitator cannot skim a fee off it. A fee needs the `upto` scheme or a
second fee authorization, i.e. a protocol change, not a config change. − Also
changes the "0 bps" positioning, which is a product decision.

**Recommendation:** **A + B together**, config-based, before any production
settler key is funded:

- `FOUR02_SETTLE_API_KEYS` allowlist on `/settle` (401 otherwise);
- keep the L3 per-IP rate limits as the second layer;
- add per-key daily settle quotas and a settler-wallet low-balance alert as
  operational follow-ups;
- defer **Option C** until there is real volume to justify the protocol work
  — and note the fee level itself is a founder product decision.

---

## M3 — Deadline refund race griefs providers

**The problem, plainly.** `refund` is permissionless and opens the instant
`block.timestamp >= deadline`. A provider's `confirmDelivery` can lose a
mempool race to a stranger's (or the payer's) `refund` in the very block the
deadline passes: work done, job terminally `Refunded`, zero recourse.
Symmetrically, a payer can hold funds hostage forever by never releasing and
never disputing — the provider's only recourse is to dispute *before* the
deadline.

**Option A — Delivery-exclusivity grace window (recommended).** `refund` opens
at `deadline + GRACE_PERIOD` (e.g. 24h, a constructor/constant). During
`[deadline, deadline + GRACE]`, only `confirmDelivery` (provider) and
`raiseDispute` (either party) can move the job. *Trade-offs:* + kills the race
deterministically with a ~3-line change; + formalizes today's "late delivery
works if no refund landed yet" quirk (L5) into spec'd behavior. − A payer
whose provider clearly ghosted waits an extra 24h for their refund; − does
not fix the hostage vector (payer never releasing — the provider must still
dispute before the deadline).

**Option B — Restrict who can refund.** Make `refund` payer-only instead of
permissionless. *Trade-offs:* barely helps — the payer themselves can still
race the provider's delivery, which is the most likely griefing shape anyway.

**Option C — Documented guidance only.** "Providers: deliver or dispute well
before the deadline." *Trade-offs:* + zero code. − Relies on every agent
reading the docs; the race remains possible.

**Recommendation:** **Option A** with a 24h grace window — deterministic,
tiny, and it absorbs L5's late-delivery quirk into the spec. Document the
residual hostage vector honestly: a payer who never releases and never
disputes forces the provider to dispute before the deadline. A v1
consideration (not recommended now): let the provider claim funds after
`deadline + GRACE` if they delivered — but that strips the payer's right to
withhold payment for bad work, which is a product decision, not a bugfix.

---

## M4 — Global USDC pause bricks all fund movement

**The problem, plainly.** If Circle pauses the USDC contract, every fund-
moving function in the escrow reverts. There is no admin escape hatch, so
escrowed funds sit frozen until Circle unpauses.

**Option A — Pause-aware escape hatch.** Add an admin/arbiter function that can
move funds when USDC is paused (e.g. release in an alternative token, or
force-release). *Trade-offs:* − This is a custodian backdoor by another name:
anyone who can move user funds "during a pause" can move user funds, period —
the trigger condition is observable but the *power* is unconditional. It
destroys the trust-minimization story that justifies the escrow's existence.
+ Liveness during a pause.

**Option B — Explicit accepted risk (recommended).** Document as a founder
decision: "If Circle pauses USDC, escrowed funds are frozen until unpause.
This is accepted — the alternative (an admin escape hatch) would make the
escrow custodial." Add offchain monitoring/alerting for USDC `Pause`/`Unpause`
events so the team knows it's happening. *Trade-offs:* + keeps the trust
model clean and honest; − funds illiquid during a pause. In practice Circle
pauses are rare and short, and a world where USDC is paused has bigger
problems than escrowed job funds.

**Recommendation:** **Option B.** What matters is that it's a *recorded
decision*, not an accident — write it into the README's limitations section
(the audit already flags it; the follow-up is one paragraph plus a monitoring
note). Revisit only if escrowed value ever grows large enough that pause-
illiquidity becomes its own systemic risk.

---

## L5 — confirmDelivery-after-deadline grief vector (note)

Two quirks, neither a fund-theft vector: (1) a provider can `confirmDelivery`
*after* the deadline if no refund landed yet — generous, currently unspec'd;
(2) either party can `raiseDispute` immediately after funding, locking the
counterparty's capital until the arbiter acts, at the cost of only gas.

**Does the M3 window cover it?** Mostly. The recommended
`[deadline, deadline + GRACE]` delivery/dispute exclusivity window turns quirk
(1) from "generous accident" into specified behavior: late delivery is legal
inside the window, refunds aren't. Quirk (2) — instant-dispute capital
locking — is inherent to any escrow with arbitration and no dispute cost. If
it becomes a real griefing pattern, the v1 lever is a **dispute bond**: the
party raising a dispute posts a bond, forfeited to the counterparty if the
arbiter rules against them. That changes the economics of disputing (a product
decision needing founder approval), so it's noted here, not recommended now.
Mitigation today: arbiter responsiveness.
