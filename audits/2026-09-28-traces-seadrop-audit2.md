# TRACES SeaDrop — Adversarial Mechanism-Design Audit (Audit 2)

**Date:** 2026-09-28
**Auditor role:** adversarial mechanism-design (game theory + economic incentives)
**Target:** `contracts/TracesLicenseSeaDrop.sol` + vendored SeaDrop interfaces in `contracts/seadrop/`
**Target commit:** `0af1737` (see note below — the target changed mid-audit)
**PoCs:** `test/sol/TracesSeaDropAudit2.t.sol` — 14 runnable forge tests, all green
**Scope note:** this audit attacks LICENSE ECONOMICS (rotation, cooldown laundering, whitelist integrity, owner levers, job-board invariants). Code-level vulnerabilities (reentrancy, access control bugs) are the other auditor's lane.

> **Mid-audit target change.** This audit began against `94ae7de`. While it was in progress, the parallel security track's fixes were committed as `0af1737` ("10k hard supply ceiling + clearStalePairing"). Two of this audit's findings were directly affected:
> - The M-3a supply-inflation lever is now **closed** — retained below as a fix-regression PoC (`testPOC_M3a_FIXREG_SupplyCeilingEnforced`).
> - The M-2 agent-desync now has a permissionless cleanup path (`clearStalePairing`) — assessed in the new PoC `testPOC_M2b_ClearStalePairing`; M-2 is downgraded to Low.
> All PoCs were re-run green against `0af1737`.

---

## Verdict: SHIP (with explicit conditions)

No finding gives an **untrusted** party a way to mint beyond caps, pair beyond the cooldown, launder the cooldown, or steal licenses. The license economics hold against outsiders:

- Rotation is hard-bounded at **10 agent-licenses per seat per 30 days** (PoC M-1).
- The 72h pairing clock **cannot be laundered** by transfer or self-transfer (PoC S-1).
- WL mint → transfer → re-mint is blocked by the cumulative `_seaDropMinted` counter (PoC S-2).
- `pairSeat`/`repairSeat` share one clock; no fast-switch path exists (PoC S-3).
- No third-party griefing vector via transfer: only the seat owner can transfer, and a mid-job sale bricks the *seller's own* pairing (PoC M-7).

The findings below are **bounds, parameters, and owner-trust items** — not outsider exploits. They are ship-conditions, not ship-blockers, provided Father explicitly signs off on each:

1. **(M-1)** Accept 72h as a *rate parameter* (10 licenses/seat/month), not a hard "one seat = one worker" guarantee. The job board MUST enforce per-seat active-job accounting — it is the real enforcement layer for concurrent multiplexing.
2. **(M-2, now Low)** The job board MUST still implement the same-wallet seat+agent ownership check at assignment AND payout. `clearStalePairing` gives the agent owner an incentivized cleanup path, but the stale window persists until someone calls it.
3. **(M-5)** Review the SeaDrop drop config before going live: stage caps are lifetime-cumulative, so the effective per-wallet cap is `max(WL cap, public cap)`; overlapping/misconfigured stages can void WL scarcity.
4. **(M-3)** Owner key remains full-trust (standing recommendation: timelock/multisig). The supply lever is now closed by the 10k ceiling; the remaining sharp edge is `updateAllowedSeaDrop`, which amplifies key compromise from "100 free team seats" to "unbounded free mint of the whole supply" — consider revoking it after final drop config.

---

## Findings

### M-1 (Medium): License multiplexing is rate-limited, not prevented — 10 agent-licenses/seat/month

**Mechanism:** `pairSeat`/`repairSeat` share a 72h per-seat cooldown (`lastPairAt`, never reset on transfer). A seat holder can serially license a new agent every 72h via `repairSeat` — no transfer needed.

**PoC:** `testPOC_M1_RotationBoundQuantified` — pairs agent₁ (free), repairs to agent₂ at t+72h, to agent₃ at t+144h; a 4th rotation in-window reverts `PairCooldown`. Extrapolated bound: `30d / 72h = 10` distinct agents per seat per 30 days.

**Quantified impact:**
- Marginal license cost via rotation at $12 public: **$12 / 10 = $1.20 per agent-month** — a 10-agent worker farm pays $12/month instead of $120/month for seats.
- Parallelized across S seats: 10·S licenses/month. The 100 team seats (M-1b) yield **1,000 agent-licenses/month at $0 license cost** (1% of total license capacity).
- This is license-*fee* arbitrage, not job-market distortion **iff** the job board caps active jobs per seat — 10 rotated agents cannot work concurrently through one seat's job slot. The onchain mechanism bounds the *rate* of license issuance; the job board bounds *concurrent* extraction.

**Recommendation:** Explicitly bless 72h as the chosen rate parameter (or lengthen it — 7d cooldown → ~4/month). Document that "one seat = one worker" is enforced by job-board per-seat accounting, not onchain.

### M-2 (Low, mitigated mid-audit): Agent transfer desyncs onchain pairing — now with incentivized permissionless cleanup

**Mechanism:** ERC-8004 identities are transferable ERC-721s. The token contract auto-clears pairings on *seat* transfer but cannot hook *agent* transfers (external registry). After an agent transfer, `seatToAgent`/`agentToSeat` still point at each other while the seat and agent have different owners.

**PoC:** `testPOC_M2_AgentTransferDesync` — Alice pairs seat 1 ↔ agent A (owns both), then transfers agent A to Bob. Onchain: `seatToAgent(1) == A`, `agentToSeat(A) == 1` (stale). Reality: Bob owns A, Alice owns 1. A job board checking only `agentToSeat(A) != 0` licenses **Bob's agent with zero seats held** — the exact A2-H2 residual from the prior double audit.

**Mid-audit mitigation (commit 0af1737):** new `clearStalePairing(agentId)` — callable only by the current agent owner when they do *not* own the paired seat (`PairingNotStale` reverts for the seat owner; `NotAgentOwner` for third parties). It does not touch the seat's 72h clock.

**PoC:** `testPOC_M2b_ClearStalePairing` verifies: Bob clears the stale pairing; the seat owner cannot abuse it as a free unpair; third parties cannot call it; clearing does not reset the cooldown (immediate re-pair still reverts `PairCooldown`).

**Why the incentives work:** the party who needs the stale state gone (Bob — he cannot pair the agent to his own seat while `agentToSeat[A] != 0`) is exactly the party permissioned to clear it. This is good mechanism design.

**Residual (why still Low, not closed):** the stale window persists between the agent transfer and someone calling clear — a Bob who never re-pairs leaves the lie onchain indefinitely, and naive readers are still fooled during the window. The same-wallet check at the job board remains load-bearing.

**Recommendation:** Keep the NatSpec warning. Checklist-gate every job-board deploy on the same-wallet invariant. Consider emitting a dedicated event on clear (currently reuses `SeatUnpaired`) if indexers need to distinguish cleanup from transfer-clears.

### M-3 (Medium): Owner economic levers — royalty diversion, evil-SeaDrop allowlisting, drop bricking (supply lever CLOSED mid-audit)

**Mechanism:** The owner retains unilateral control over every economic parameter. All paths are `onlyOwner`, so this is centralization risk, not an outsider exploit — but one lever materially *amplifies* owner-key compromise.

**PoCs:**
- `testPOC_M3a_FIXREG_SupplyCeilingEnforced` — **FIXED mid-audit (0af1737):** `setMaxSupply` above `MAX_SUPPLY_CEILING` (10,000) now reverts `MaxSupplyExceedsCeiling`. The old inflation PoC is retained as a regression test proving the attack fails; lowering the cap still works.
- `testPOC_M3a_RoyaltyLeverRemains` — `setRoyaltyInfo` still redirects the 5% royalty to an arbitrary receiver at arbitrary bps. The 5% is a configuration, not a rule.
- `testPOC_M3b_EvilSeaDropUnboundedMint` — owner allowlists a malicious SeaDrop; it calls `mintSeaDrop` directly (the token enforces **no** caps/prices itself — all sale invariants live in SeaDrop). **5,000 seats (50% of supply) minted for $0 in one tx.** Side effect: the legitimate SeaDrop is simultaneously bricked (`OnlyAllowedSeaDrop`).
- `updateCreatorPayoutAddress` / `updatePublicDrop` / `updateAllowList` allow mid-sale price changes, cap changes, and fund diversion (verified by existing forwarder tests + mock).

**Impact:** Without `updateAllowedSeaDrop`, a compromised owner key can mint 100 team seats. *With* it, the same key can mint the entire 10,000 supply for free and brick the real drop. The function turns a bounded privilege into an unbounded one.

**Recommendation:** (Standing) move ownership to timelock+multisig. Additionally: after the drop config is final and the sale is over, call `updateAllowedSeaDrop([])` or renounce ownership to permanently close the evil-SeaDrop path. Publish the team-mint log (100 seats, `TeamMint` events already emitted).

### M-4 (Low): Secondhand buyer inherits the seller's remaining pairing cooldown (up to ~72h dead time)

**Mechanism:** `lastPairAt` is deliberately not reset on transfer (else self-transfer would launder the cooldown — correctly rejected). A buyer therefore inherits `72h − (time since seller's last pairing)` of activation delay.

**PoC:** `testPOC_M4_BuyerInheritsCooldownQuantified` — seller pairs 1 second before selling (maximal grief); buyer's `pairSeat` reverts until t+72h. Control: a never-paired ("virgin") seat pairs instantly for the buyer.

**Impact:** Bounded activation friction (≤72h of lost job-earning opportunity). Market-microstructure consequence: virgin seats trade at a premium; freshly-paired seats at a discount; sellers can impose up to ~71h59m of dead time on buyers. Minor buyer-experience issue, worth one line in the mint/buy FAQ.

### M-5 (Low): Stage caps are lifetime-cumulative — effective per-wallet cap = max(WL cap, public cap)

**Mechanism (source-verified against canonical SeaDrop.sol `_checkMintQuantity`, L652–684):** every stage (`mintPublic`, `mintAllowList`) checks `quantity + minterNumMinted > stage.maxTotalMintableByWallet`, where `minterNumMinted` is the *cumulative* per-wallet count from the token's `getMintStats`. Caps are therefore **not additive across stages** — and the allowlist leaf `keccak256(abi.encode(minter, mintParams))` (SeaDrop.sol L308) binds the minter *and* their full params, so proofs can't be replayed or re-parameterized.

**PoC:** `testPOC_M5_StageCapInteraction` —
- 17-terminal whale (WL cap 17, public cap 10): mints 17 in WL, then public mint reverts (`17+1 > 10`) — **locked out of public**, total 17. (Confirm this is the intended economics.)
- Ordinary wallet: 10 public OK, 11th reverts.
- Footgun: owner configures public cap 1000 with overlapping stages → a non-WL wallet mints **100 seats**, voiding the "1:1 per terminal" scarcity narrative.

**Impact:** The `_seaDropMinted` counter is exactly right for canonical semantics (good). The risk is purely configurational: whoever sets the SeaDrop stages must understand that the public cap dominates whenever it exceeds a wallet's WL cap. Recommend the drop config be reviewed and published (not changed mid-sale) before launch.

### M-6 (Low/Info): Team mint is SeaDrop-invisible — 100 cap-free seats, stackable with stage caps

**PoC:** `testPOC_M6_TeamMintBypassesSeaDropCaps` — owner `teamMint`s 100 to a wallet; the wallet then mints a full 10-seat public cap on top. `getMintStats` reports 10; the wallet holds 110.

**Impact:** 1% supply dilution, fully within the disclosed 100-seat allocation; `TeamMint` events give the public log the earlier audit recommended. Not a bypass of anything the team didn't grant itself — noted for completeness so the 100 seats aren't double-counted as "out of the 10k" (they count against `maxSupply`, correctly).

### M-7 (Info): Mid-job seat transfer bricks the seller's own pairing — no third-party grief vector

**PoC:** `testPOC_M7_MidJobTransferSelfGrief` — worker pairs seat↔agent, sells the seat mid-job; pairing auto-clears, the worker's agent is unlicensed, and the payout-time same-wallet check can no longer pass for the worker.

**Assessment:** The only party that can trigger a transfer is the seat owner (or their approved operator — their own delegation). The seller internalizes the full cost (lost payout eligibility + buyer's inherited cooldown). There is **no** griefing primitive here for a third party. Residual requester-side stall risk (worker sells mid-job) belongs to the job board's stake/slash design, not this contract.

---

## Verified SOUND (with PoC)

- **S-1 — Cooldown laundering impossible.** `testPOC_S1_CooldownLaunderingFails`: pair → transfer to fresh wallet → immediate pair reverts `PairCooldown`; self-transfer → same revert; honest pairing after 72h succeeds. `lastPairAt` is never written on transfer, only on pairing actions.
- **S-2 — WL mint → transfer → re-mint blocked.** `testPOC_S2_WLRemintBlockedAfterTransfer`: after minting a 2-cap and transferring both away, `getMintStats` still reports 2 and further WL mints revert. Extra mints extractable: **0**.
- **S-3 — No fast-switch path between pairSeat/repairSeat.** `testPOC_S3_NoFastPairPath`: both functions enforce the same 72h clock; `repairSeat` on a virgin seat is exactly `pairSeat` (sets `lastPairAt` identically).
- **S-4 — Allowlist leaf integrity (source-verified).** Canonical SeaDrop.sol L308: leaf = `keccak256(abi.encode(minter, mintParams))` — a minter cannot use another wallet's proof (minter-bound) nor present different caps/prices (params-bound). Per-wallet `maxTotalMintableByWallet` is enforced natively.
- **S-5 — Nonexistent/agentId=0 cannot pair.** `_checkPairing` requires `IDENTITY_REGISTRY.ownerOf(agentId) == caller`; a reverting registry (canonical behavior) or a zero-address return both fail the check.
- **S-6 — Supply and team caps.** `INITIAL_MAX_SUPPLY = 10_000` enforced in `mintSeaDrop`/`teamMint`; `TEAM_SUPPLY = 100` enforced in `teamMint`; sequential IDs from 1 (covered by existing suite + fork test vs live SeaDrop).
- **S-7 — Supply ceiling hard (fix-regression).** `testPOC_M3a_FIXREG_SupplyCeilingEnforced`: `setMaxSupply` above 10,000 reverts `MaxSupplyExceedsCeiling`; the owner can only lower the cap. The unilateral-dilution lever is closed.
- **S-8 — Stale-pairing cleanup without cooldown bypass.** `testPOC_M2b_ClearStalePairing`: `clearStalePairing` is restricted to the agent owner in genuine desync (`PairingNotStale`/`NotAgentOwner` otherwise) and does not reset the seat's 72h clock.

## Out of scope / not re-audited here

Code-level security (reentrancy, OZ integration, ERC-721C validator behavior) — the parallel security auditor's lane. The `_seaDropMinted` accounting, `nonReentrant` on `mintSeaDrop`, and state-before-`_safeMint` ordering were noted as sound but not fuzzed here.

## Files

- PoCs: `~/workspace/402/test/sol/TracesSeaDropAudit2.t.sol` (14/14 green)
- This report: `~/workspace/402/audits/2026-09-28-traces-seadrop-audit2.md`
- Target contract modified mid-audit by the parallel track (commit `0af1737`); this audit's PoCs were updated and re-run green against it. This audit itself modified nothing outside its test file and report.
- Nothing committed, nothing pushed by this auditor.
