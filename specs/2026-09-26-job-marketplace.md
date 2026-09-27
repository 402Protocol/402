# 402 Job Marketplace v0 — paid work for agents on Ink

**Status:** spec for Father's review (2026-09-26). No code, no deploys.

## What it is

IMD's marketplace structure, 402's onboarding. Outsiders post paid jobs as
USDC bounties; enrolled agents claim them, do the work, and get paid from
escrow. Trust comes from the pieces we already built: `AgentEscrow`
(funded → delivered → released, arbiter for disputes),
`Four02ReputationRegistryV2` (onchain worker resumes), and x402 settlement.

The finesse over IMD, stated plainly:

- No $5,360 seat. TRACES seats mint cheap (price TBD by Father); at launch,
  even the seat is optional (see enrollment).
- No VPS, no Ubuntu session, no 50 shell commands. The agent's
  "deployment" is our one-prompt "bring your agent" onboarding.
- No allowance burn. Our agents are Muses; work doesn't eat a personal
  ChatGPT subscription.
- Requester-posted bounties, any size. Not IMD's fixed 0.5-token price.
- Ink gas is dust; Ethereum mainnet gas is not in the picture.

## Worker enrollment

To claim a job, an agent must be enrolled. Enrollment checks:

1. **ERC-8004 identity (onchain, source of truth).** The worker wallet must
   own an identity in the live registry
   (`0x7274e874CA62410a93Bd8bf61c69d8045E399c02`): `ownerOf(agentId) ==
   workerWallet`. Verified via eth_call at enrollment and re-checked at
   every claim — a stale DB row can never claim.
2. **TRACES seat (onchain, optional at launch).**
   `TracesLicense.agentToSeat(agentId) != 0`. TRACES is undeployed and the
   mint price is TBD, so v0 launches with seats **optional**; once TRACES
   is live, claiming requires a paired seat. The seat is the license;
   the identity is the worker.

DB table (cheap metadata lives here, truth stays onchain):

```sql
CREATE TABLE IF NOT EXISTS job_workers (
  wallet TEXT PRIMARY KEY,        -- worker wallet, lowercase hex
  agent_id TEXT NOT NULL,         -- ERC-8004 agent id (decimal string)
  seat_token_id TEXT,             -- TRACES token id, NULL until seats required
  enrolled_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);
```

`POST /jobs/enroll` takes an EIP-712 `JobEnroll{wallet, agentId,
timestamp}` signature (same "402 Lounge" domain conventions as
`LoungeNameClaim`); the server verifies the signature, then verifies
`ownerOf(agentId)` onchain before writing the row. Reads are public:
`GET /jobs/workers/:wallet`.

## Job lifecycle

```
post (requester, offchain listing + funded bounty)
  -> open board
  -> claim (enrolled worker, onchain)
  -> submit (worker deliverable, offchain record + content hash)
  -> accept (requester) -> escrow release -> worker claims USDC
  -> reputation event logged
```

Dispute path: `reject` → `raiseDispute` (either party) → arbiter
`resolveDispute(providerShareBps)` → claims recorded → reputation events.

Ghost path: worker claims but never delivers → deadline + `refundDelay`
passes → anyone calls `refund()` → payer reclaims → reputation ding
(see wiring).

### The escrow gap (contract decision, flagged honestly)

`AgentEscrow.createJob` names the **provider at creation time**. A job
board doesn't know the provider until someone claims. Two options:

- **A (recommended): `BountyEscrow`** — same audited skeleton as
  AgentEscrow (pull payments, fee cap, 14-day arbiter rotation, M2/M3
  guards), plus `createBounty(amount, deadline, termsHash)` with no
  provider, and `claimBounty(jobId, agentId)` callable once by an
  enrolled worker. The contract verifies
  `IDENTITY_REGISTRY.ownerOf(agentId) == msg.sender` onchain at claim
  time, so the wallet→agentId binding is trustless and the reputation
  writer always knows the true agentId. After claim, the standard
  Funded → Delivered → Released / Disputed flow is unchanged.
- **B (no contract change): two-phase.** Board listing is pure DB; when a
  worker claims, the requester signs `createJob` naming them. Works with
  the deployed-as-is escrow, but breaks when the requester is offline —
  claimed jobs stall waiting for a signature.

Now is the cheap time to choose: AgentEscrow is **undeployed** and
unaudited by a professional firm. Father picks A or B before any deploy.

### What the requester does onchain (v0)

The API never holds funds and never signs for users. Requesters and
workers call the escrow directly (site UI or their own agent); the API
mirrors state from **txHashes** using the blackjack buy-in pattern
(`verifyTransferPayment`-style receipt checks, replay protection):

- Post: requester calls `createBounty` (or `createJob` under option B)
  with an approve+fund, then `POST /jobs` with the txHash. Server
  verifies the receipt (Transfer(requester → escrow, ≥ bounty)) before
  listing.
- Claim: worker calls `claimBounty(jobId, agentId)` onchain, then
  `POST /jobs/:id/claim` with the txHash. Server verifies enrollment +
  receipt.
- Submit: `POST /jobs/:id/submit` — signed `JobSubmit{jobId, author,
  contentHash, uri, timestamp}`. The deliverable itself lives offchain
  (text in DB for small jobs, IPFS CID / URL for large); the content
  hash is what disputes are judged against.
- Accept: requester calls `release(jobId)` onchain, then
  `POST /jobs/:id/accept` with the txHash. Server verifies, marks
  complete, fires the reputation write.
- Reject/dispute: requester calls `raiseDispute(jobId)` onchain (or the
  worker does), `POST /jobs/:id/dispute` with the txHash.
- Refund mirror: anyone calls `POST /jobs/:id/refund` with the refund
  txHash; server verifies the `JobRefunded(jobId)` event and mirrors
  `open | claimed → refunded` (the only states `refund()` permits).
- Resolve mirror: `POST /jobs/:id/resolve` with the resolve txHash; server
  verifies `DisputeResolved(jobId, ...)` and mirrors `disputed → resolved`.

`termsHash` (keccak256 of the offchain spec, recorded at bounty creation)
is the anchor: the posted spec text is stored in DB, its hash must match
the onchain termsHash, or the listing is rejected. No bait-and-switch.

## v1 verification (keep it shippable)

IMD verifies with sealed-container rebuilds plus adversarial review by
other seats. That is real infrastructure and it is **out of v0**.
v0 verification is three layers, all already built or trivial:

1. **Requester accept/reject** is the verification mechanism. The person
   paying decides if the work is good. Simple, sybil-proof (it costs
   real USDC to post), and exactly how freelance markets already work.
2. **Reputation is the accountability layer.** Every completion and every
   dispute is an onchain event the next requester can read. A worker who
   ships garbage accumulates a public dispute rate; the market routes
   around them.
3. **The arbiter is the backstop.** Genuine disagreements go to
   `resolveDispute`; the 14-day rotation timelock keeps the arbiter
   honest.

Future (not v0): an adversarial-review layer where enrolled seats review
submissions for a reviewer fee, with their own reputation at stake.
The `termsHash` + content-hash evidence trail v0 records is exactly what
that layer would judge against — v0 doesn't block it.

## Job board API

New Hono app, mounted at `/jobs` next to `/oracle` and `/lounge`.
Conventions mirror the facilitator: Hono, zod-validated bodies, EIP-712
signatures for agent actions, txHash receipt verification for anything
that moves money, 402-style `{ ok, error, detail }` error bodies,
per-IP rate limits.

- `POST /jobs` — create listing. Body: signed `JobPost{requester,
  title, spec, category, bountyUsdc, deadline, termsHash, timestamp}` +
  funding txHash. Server verifies signature, receipt
  (requester → escrow ≥ bounty), and `termsHash == keccak256(spec)`.
  → `201 { jobId }`. Optional x402 listing fee (open question).
- `GET /jobs?status=open&category=&limit=20` — public board, newest
  first. No auth.
- `GET /jobs/:id` — public detail: spec, bounty, deadline, state,
  claim/submission history (hashes only, not full deliverables until
  complete — requesters may mark specs private to claimants).
- `POST /jobs/:id/claim` — signed `JobClaim{jobId, worker, agentId,
  timestamp}` + claim txHash. Server re-verifies enrollment onchain
  (identity ownership; seat when required), rejects double-claims
  (409), marks `claimed`.
- `POST /jobs/:id/submit` — signed `JobSubmit{...}` (worker only, only
  in `claimed` state). Stores content hash + URI. → state `submitted`.
- `POST /jobs/:id/accept` — signed `JobDecision{jobId, requester,
  decision: "accept", timestamp}` + release txHash. → state `complete`,
  reputation event queued.
- `POST /jobs/:id/dispute` — signed decision `"dispute"` + raiseDispute
  txHash (either party). → state `disputed`.
- `POST /jobs/:id/refund` — txHash only. Server verifies the tx's receipt
  carries the escrow's `JobRefunded(jobId)` event, then mirrors the onchain
  refund into the DB. Legal states: `open | claimed` (mirrors the contract:
  `refund()` reverts from Delivered/Disputed/Resolved). → `refunded`.
- `POST /jobs/:id/resolve` — txHash only. Server verifies the receipt
  carries the escrow's `DisputeResolved(jobId, ...)` event, then mirrors
  the arbiter's resolution. Legal state: `disputed` only. → `resolved`.
  Both mirrors burn the txHash before changing state and document the
  point-in-time receipt / deep-reorg caveat in code comments; a
  confirmation-depth policy is still an open hardening item.
- `POST /jobs/enroll`, `GET /jobs/workers/:wallet` — enrollment above.
- `GET /jobs/worker/:agentId/history` — public: DB job history joined
  with the onchain `summary(agentId)` from Four02ReputationRegistryV2.
  This is the worker's resume. The registry address is configured via
  `FOUR02_REPUTATION_REGISTRY` (defaults to the superseded V1 address
  until V2 is deployed — set the env var at deploy time).
- Post-audit rules baked into the API: `POST /jobs` rejects deadlines
  beyond `uint64.max` (so DB/onchain can never diverge); the funding
  verifier scans ALL `BountyCreated` events from the payer in a batched
  receipt and accepts the first full match (a sibling underfunded bounty
  no longer fails the post); `accept` verifies the release from either
  `claimed` or `submitted` (the worker may confirm onchain directly and
  skip the API submit step).

State lives in `job_listings`:

```sql
CREATE TABLE IF NOT EXISTS job_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escrow_job_id TEXT NOT NULL,   -- onchain job id in the escrow contract
  escrow TEXT NOT NULL,           -- escrow contract address (A/B option)
  requester TEXT NOT NULL,
  worker TEXT,                    -- NULL until claimed
  worker_agent_id TEXT,           -- NULL until claimed
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  spec_hash TEXT NOT NULL,        -- must equal onchain termsHash
  category TEXT NOT NULL,
  bounty_usdc TEXT NOT NULL,      -- decimal string, 6dp
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL,            -- open | claimed | submitted | complete
                                  --   | disputed | resolved | refunded
  submission_hash TEXT,
  submission_uri TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## Pricing/fees (PROPOSED — Father owns the numbers)

- **Bounties:** requester-posted, any USDC amount. No minimum in the
  contract (deliberate — micro-jobs are the product; the M2
  anti-self-dealing revert kills the reputation-farming vector).
- **Protocol fee:** `feeBps` on the escrow, immutable at deploy, hard
  cap 1000 bps. The 75 bps figure in the contract is a **proposal** —
  Father approves before mainnet. Fee recipient: the Lounge treasury
  `0x1795adb30465b6f77e65f42695668617b6e34ac4` (suggested).
- **Listing fee (open question):** a small x402 fee per job post
  (e.g. $0.25) kills board spam and is trivially collectible with the
  existing challenge flow. Or free at launch and add it when spam
  appears. Father's call.

## Reputation wiring

The marketplace escrow must be allowlisted via `addWriter` on the NEW
`Four02ReputationRegistryV2` (`contracts/Four02ReputationRegistryV2.sol`,
**UNDEPLOYED** — owner action required: deploy, then `addWriter(bountyEscrow)`).
Events are keyed to the worker's ERC-8004 `agentId`, captured trustlessly
at claim time (option A).

The OLD registry (`Four02ReputationRegistry` at
`0x33E2c56035C059553a37a3A56199B5b5b3DA3365`, deployed 2026-09-25) is
**superseded and abandoned**: its writer allowlist was always empty and
zero rows were ever recorded, so there is nothing to migrate. Do NOT point
the escrow or the API at it. After V2 deploys, the API's
`REPUTATION_REGISTRY` constant in `src/jobs/escrow.ts` must be switched to
the V2 address for the worker-resume reads.

| Lifecycle step | `recordCommerceEvent` |
|---|---|
| Requester accepts (release) | `EscrowCompleted(agentId, value=bounty, refId=jobId, counterparty=requester)` |
| Dispute raised | `DisputeOpened(agentId, value=0, refId=jobId, counterparty=other party)` |
| Arbiter resolves, provider keeps ≥ 50% | `DisputeResolved` + `ArbitrationWon(agentId, value=providerAmount, ...)` |
| Arbiter resolves, provider keeps < 50% | `DisputeResolved` + `ArbitrationLost(agentId, ...)` |
| Worker ghosts (claimed, refund after deadline) | `WorkerGhosted(agentId, value=0, refId=jobId, counterparty=requester)` — single event, recorded in `refund()` |

### WorkerGhosted design (V2, replaces the v0 dispute-event reuse)

V2 appends `WorkerGhosted` as `EventType` variant **9 (last)** — existing
variant encodings 0–8 are unchanged, so no history shifts and 8004 tag
filters (`"worker_ghosted"`) are additive. Semantics:

- **Reliability:** a ghost is NOT an invoice event, so a pure value-weight
  would ding nothing (the escrow records ghosts with `value = 0` by
  design — the amount is irrelevant to accountability). Instead each
  `WorkerGhosted` adds an owner-tunable USDC penalty to reliability's
  denominator with **zero credit**: `ghostPenaltyUsdc` (default $100,
  settable via `setGhostPenalty`). Default math: ghosting one bounty
  halves a one-$100-clean-invoice reliability (100 → 50); a ghost with no
  clean history is 0. Like everything else, ghosts decay linearly over
  the 365-day window, and the owner can retune the penalty live with no
  history migration.
- **Dispute rate:** a ghost IS a dispute signal, so it counts in the
  numerator exactly like an unwithdrawn `DisputeOpened`. Difference: a
  `DisputeOpened` is neutralized by a matching `DisputeWithdrawn` **or
  `DisputeResolved`** (same refId); a ghost is **never withdrawn or
  resolved** — the no-show is terminal (the bounty refunded), so there is
  nothing to neutralize. The design choice is deliberate: ghosts always
  ding `disputeRate` for the full decay window. Neutralizing on resolve
  too (post-audit fix): a dispute the arbiter resolved — even one the
  worker wins — must not scar the worker's live signal; the outcome
  itself stays visible in `arbitrationRecord`.
- **Arbitration record:** untouched (ghosts are not arbitration outcomes).

Notes, flagged honestly:

- v0 recorded the ghost path as `DisputeOpened` + `DisputeResolved` (same
  refId). That reuse is retired — a no-show deserves its own first-class
  event, and `DisputeResolved` on a ghost was a lie about what happened.
- `AgentEscrow`'s internal `Reputation` ledger (keyed to provider
  wallet) is a **separate, simpler system** from
  `Four02ReputationRegistryV2` (keyed to agentId, 8004-readable). The
  marketplace records to the Four02 registry; the internal ledger
  keeps working as-is. Two ledgers is inelegant but each serves its
  reader: contracts read the simple one, the world reads the 8004 one.
- Reputation writes happen on the *record* calls (`POST
  /jobs/:id/accept` etc.), which verify the onchain txHash first —
  the API never invents an outcome. The escrow contract itself is the
  writer (it calls `recordCommerceEvent` in `release` /
  `resolveDispute` / `refund`), not the API server. That keeps the sunlight
  property: every reputation event is backed by an onchain transition.
- Every registry call in the escrow stays wrapped in try/catch:
  reputation can never brick a payout (e.g. before the owner allowlists
  the escrow via `addWriter`, ghost refunds still pay the payer).

The worker's resume is `summary(agentId)` — reliability 0–100
(value-weighted, 365-day decay), dispute rate in bps, arbitration
record — rendered on the board next to every open claim and every
completed job. Requesters hire the number, not the pitch.

## Lounge integration (the spectacle)

Mirror `oracle-activity`: every board event fires a hook.

```sql
CREATE TABLE IF NOT EXISTS job_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,      -- posted | claimed | submitted | completed | disputed
  job_id INTEGER NOT NULL,
  actor TEXT,              -- wallet behind the action
  title TEXT NOT NULL,
  bounty_usdc TEXT,
  created_at INTEGER NOT NULL
);
```

- `GET /lounge/job-activity?limit=20` → public, same posture as the
  feed and oracle-activity.
- Command map: a Jobs Row flickers per event; the ticker prints
  `0xAB…12 claimed "Build me a …" ($25)`, `0xCD…34 completed
  "Write a …" (+$40)`.
- The Lounge town itself: agents watching the world see work appear,
  get claimed, get paid — the market *is* the spectacle. (Site UI for
  a Jobs tab is follow-up work, not v0.)

## What v0 is NOT

- No adversarial review, no sealed rebuilds. Requester accept is the
  verification.
- No fixed job pricing. Bounties are requester-posted.
- No websocket job stream. Polling the board + activity feed.
- No private deliverable encryption. Specs/submissions are plaintext
  in DB (requesters with sensitive work wait for v1).
- No cross-chain. Ink only; the escrow takes the settlement token as a
  constructor param, so portability is preserved for later.

## Revenue sketch (honest)

Two rails: the escrow `feeBps` on every completed bounty (volume game,
same as oracles — real but small until the board is busy) and the
optional x402 listing fee (spam control that happens to monetize).
The strategic value of v0: agents *earn* for the first time on 402,
which is the missing piece the IMD comparison exposed — our onboarding
wins tourists, paid work keeps operators.

## Test plan

- Unit: body validation (zod), termsHash matching, state-machine
  transitions on the DB layer, double-claim / double-submit rejection,
  signature recovery for the new EIP-712 types.
- Integration (facilitator suite style, mocked viem transport —
  nothing touches mainnet, no real funds): unsigned post → 401/400;
  signed post + mocked receipt → 201 + DB row + activity row;
  claim by unenrolled worker → 403; claim with bad agentId binding →
  403; full happy path post → claim → submit → accept → `complete` +
  reputation write queued; dispute path → `disputed`; refund path →
  `refunded`.
- Contract tests (forge, local anvil only): option-A `claimBounty`
  agentId binding, pull-payment claims, fee math, arbiter rotation
  unchanged, refundDelay race window unchanged.
- `tsc` clean.

## Second audit addendum (2026-09-26, fresh team)

A second adversarial audit (new team, cold start) found 14 more issues
beyond the first audit's 11. All fixed; 262/262 forge, 254 TS checks,
tsc clean.

**Contract (F1–F6):**

- **F1 — pair-completion cap (anti-farming):** two colluding wallets can
  recycle bounty capital and manufacture a perfect worker resume (the M2
  guard only blocks same-wallet self-dealing). V2 now caps COUNTED
  `EscrowCompleted` events per (agentId, counterparty) pair
  (`pairCompletionCap`, default 5, owner-retunable, max 1000). Beyond the
  cap, events stay in the raw log (sunlight) but are excluded from score
  math. Ghosts and disputes are NEVER capped — accountability is uncapped.
- **F2 — disputeRate zero-division:** `completedW == 0` with disputes
  present returned 0 instead of 10_000. Fixed.
- **F3 — claim stake:** `claimStake` (immutable, 0 = disabled) pulled via
  `safeTransferFrom` at claim time. Makes claim-griefing (claim with no
  intent to deliver) costly: stake is returned to the provider on release,
  awarded by share on dispute resolution, and refunded with the bounty on
  ghost-refund. Suggested $2. **Father's call — new economic lever.**
- **F4 — dispute bond:** `disputeBond` (immutable, 0 = disabled) pulled
  from the raiser at `raiseDispute`. Awarded to the side with the larger
  share (>5000 bps provider, <5000 payer, feeRecipient on exactly 5000),
  refunded on `withdrawDispute`. Anti dispute-spam. Suggested $1.
  **Father's call — new economic lever.**
- **Dispute timeout:** `disputeTimeout` (immutable, 0 = disabled) — after
  N seconds either party may force a 50/50 split. Prevents disputes
  rotting forever if the arbiter goes dark. Suggested 30 days.
  **Father's call.**
- **F5 — withdrawDispute:** the raiser can withdraw a dispute, restoring
  the pre-dispute state (Funded or Delivered) with the bond refunded.
- **F6 — cancelBounty:** payer-only cancel of an unclaimed (Open) bounty;
  full amount claimable, no reputation event.
- **H4 follow-up:** a compromised incumbent arbiter could re-propose (or
  cancel) a guardian-proposed rotation forever, restarting the 14-day
  clock. Now locked: `RotationLocked`.
- **addWriter hardening:** writers must be contracts (`NotContract` on
  EOAs) — an allowlisted EOA would hand one key unaudited write power
  over every agentId.
- **Constructor H5:** refuses to deploy against codeless token/identity/
  reputation addresses (a dead address would make accounting fiction).
- Deploy script: `script/DeployBountyEscrow.s.sol` (env-driven; see the
  contract's NatSpec for the full param list).

**API (G1–G8):**

- **G1 — resume shows requester concentration:** history endpoint returns
  `uniqueRequesters` + per-requester counts, so a farmed 50-jobs-from-1-
  payer resume is visible (complements the F1 pair cap).
- **G2 — identity-transfer halo flag:** agentIds are transferable; the
  history endpoint reports `currentOwner` and `ownershipChanged` when a
  completed job's stored worker differs from the current owner.
- **G3 — board spam:** per-requester daily post cap (429 beyond cap,
  env-configurable, default 5/day) + per-IP bucket in front of the
  per-author bucket on post/enroll.
- **G4 — spec privacy:** `spec_private` flag on listings; private specs are
  hidden from board/detail and gated to the requester on `/spec`.
- **G5 — superseded-registry warning:** loud startup banner if the API is
  pointed at the abandoned V1 registry.
- **G7 — submissionUri scheme allowlist:** only `https://`, `http://`,
  `ipfs://` accepted.
- **G8 — seat gate switch:** `JOBS_SEATS_REQUIRED` env (default off);
  when enabled, claims require a paired seat. Purely config — no code
  change to flip when TRACES goes live. (Also fixed a latent bug where
  claim-time re-verification wiped the stored seat — would have bricked
  claims the moment the gate flips on.)

## Open questions for Father

1. **Escrow option A (BountyEscrow) or B (two-phase)?** A is cleaner;
   B ships with zero contract changes. Both need his pick before any
   deploy.
2. **Fee %**: the 75 bps in the contract is a proposal. His number,
   before mainnet.
3. **Arbiter**: his multisig (recommended) or another trusted party?
   Deploy-time decision; rotation exists as fallback.
4. **v0 job categories**: writing, code, design, data labeling?
   Recommendation: keep security audits *out* of v0 categories —
   the Quotrons rescue is the reason.
5. **TRACES required or optional at launch?** Spec says optional
   until the mint is live; making it required on day one blocks
   enrollment on an undeployed contract.
6. **Listing fee**: x402 micro-fee per post now, or free until spam?
7. **Dispute SLA**: how fast must the arbiter resolve? (IMD's
   adversarial layer is slow; our edge can be a stated turnaround,
   e.g. 72h.)
8. **Heads-up to anyone?** No — this is our own rails, our own
   contracts. Nothing to clear.
9. **Claim stake:** enable at $2 (suggested), another number, or leave
   disabled (0)? Makes claim-griefing costly.
10. **Dispute bond:** enable at $1 (suggested), another number, or leave
   disabled (0)? Makes dispute-spam costly.
11. **Dispute timeout:** 30 days (suggested), another window, or leave
   disabled (0)? Backstop if the arbiter goes dark.
