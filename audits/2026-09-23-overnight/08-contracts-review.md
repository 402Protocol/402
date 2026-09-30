# Workstream 8 — Smart contract re-verification (overnight audit)

**Date:** 2026-09-23
**Scope (read-only):** `contracts/AgentEscrow.sol`, `contracts/Reputation.sol`, `script/Deploy.s.sol`
**Method:** source read against `audits/2026-09-22-security-audit.md` and `audits/2026-09-22-fix-designs.md`. No forge runs, no deploys, no broadcasts, no wallet access.

**Verdict: all audit remediation holds. No drift detected.** Contracts remain undeployed (deploy script still refuses to run without founder-set parameters).

---

## 1. Pull-payment claims — HOLDS

Terminal transitions record claims; nobody is pushed funds:

- `release()` — `contracts/AgentEscrow.sol:246-266`: sets state `Released`, records
  `claims[jobId][job.provider] += providerAmount` (L260) and
  `claims[jobId][feeRecipient] += fee` (L262). **No token transfer.** Uses `+=`
  with an explicit comment covering the `feeRecipient == provider` slot-overlap case.
- `resolveDispute()` — `contracts/AgentEscrow.sol:286-307`: sets state `Resolved`,
  records provider/payer split via `+=` (L300, L303). **No token transfer.**
  Reverts if `providerShareBps > 10_000` (L293) so splits can't over-record.
- `refund()` — `contracts/AgentEscrow.sol:323-331`: sets state `Refunded`, records
  `claims[jobId][job.payer] += job.amount` (L329). **No token transfer.**
  Gated to `Funded` state and `block.timestamp >= deadline + refundDelay` (L325-326).
- `claim()` — `contracts/AgentEscrow.sol:339-345`: permissionless caller but
  payee-keyed (`msg.sender`), reverts on zero with `NothingToClaim()` (L341),
  **zeroes the entry before transferring** (L342, checks-effects-interactions),
  `nonReentrant`, emits `Claimed` (L344).
- `claimable()` view — `contracts/AgentEscrow.sol:399-401`.

Grep over both contracts confirms the only outbound token movements in the
whole system are `safeTransferFrom` in `createJob` (L227, funding) and
`safeTransfer` in `claim` (L343). No `.transfer`/`.send`/low-level call pushing
funds anywhere else — the blocklist-bricking class (H3) is eliminated at the
pattern level.

## 2. Timelocked arbiter rotation — HOLDS

- `ROTATION_DELAY = 14 days` — `contracts/AgentEscrow.sol:38` (`uint256 public constant`).
- `guardian` — `contracts/AgentEscrow.sol:111` (`address public immutable`), set
  once in the constructor (L190), no setter. NatSpec confirms: founder-controlled
  EOA, can propose rotation, **cannot touch funds** (L105-110).
- `arbiter` — `contracts/AgentEscrow.sol:118` mutable storage; the only writer
  is `confirmRotation()`, so rotation is the exclusive mutation path.
- `proposeRotation(address)` — L357-364: callable by arbiter **or** guardian only
  (`NotProposer()` otherwise, L358); sets `pendingArbiter` + `rotationReadyAt =
  block.timestamp + ROTATION_DELAY` (L360-361); re-proposing overwrites and
  restarts the clock (documented in NatSpec).
- `confirmRotation()` — L367-377: permissionless, requires pending proposal
  (`NoRotationPending()`, L369) and elapsed timelock (`RotationTooEarly()`, L370);
  clears pending state on execution.
- `cancelRotation()` — L380-388: arbiter/guardian may cancel a pending proposal
  (compromised-guardian mitigation). This function was not named in the fix
  design doc but is a benign, well-scoped addition — noted under observations.

## 3. Immutable refundDelay (24h default) — HOLDS

- `uint64 public immutable refundDelay` — `contracts/AgentEscrow.sol:104`.
- Assigned exactly once in the constructor (L189: `refundDelay = refundDelay_;`);
  no setter, no other writer in the file.
- Deploy preset: `REFUND_DELAY = 1 days` — `script/Deploy.s.sol:50` (24h default,
  marked `// <-- REVIEW THIS`).
- Enforcement: `refund()` reverts `TooEarly()` unless
  `block.timestamp >= deadline + refundDelay` (L326). `confirmDelivery` remains
  callable during the grace window (L235-241), so the M3 race fix is intact.

## 4. Fee hard-cap of 10% enforced onchain — HOLDS

- `MAX_FEE_BPS = 1_000` (10%) — `contracts/AgentEscrow.sol:33` (`public constant`).
- Constructor enforcement: `if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();` —
  `contracts/AgentEscrow.sol:184`.
- `feeBps` itself is `uint256 public immutable` (L100), snapshot at construction;
  no setter. Fee math in `release()` floors (`(amount * feeBps) / BPS_DENOMINATOR`,
  L257) — dust direction unchanged (favors provider), conserved, as documented
  in the audit (L4).

## 5. Deploy script founder parameters — HOLDS (still unset / founder-owned)

`script/Deploy.s.sol`:

| Param | Line | Status |
|---|---|---|
| `TOKEN` | L25 | Preset to `0x2D270e6886d130D724215A266106e6832161EAEd` — matches the verified native Ink USDC (6-decimal FiatTokenV2, EIP-3009). Correct. |
| `ARBITER` | L30 | `address(0)` — `// <-- SET THIS`. Founder must fill in. |
| `FEE_RECIPIENT` | L33 | `address(0)` — `// <-- SET THIS`. Founder must fill in. |
| `FEE_BPS` | L38 | `75` — explicitly "PROPOSED economics — NOT final. Founder approval required before mainnet." |
| `EXPECTED_CHAIN_ID` | L43 | `57073` (Ink); `run()` reverts on any other chain (H5 footgun guard, L66-69). |
| `REFUND_DELAY` | L50 | `1 days` — marked `// <-- REVIEW THIS`. |
| `GUARDIAN` | L57 | `address(0)` — `// <-- SET THIS`. Founder must fill in. |

Additional hardening intact: `run()` reverts with clear messages if ARBITER /
FEE_RECIPIENT / GUARDIAN are unset (L63-65), asserts the chain id (H5, L66-69),
and the constructor's `NotContract()` token code-length check (L183) means a
wrong-token deploy reverts rather than creating accounting fiction.

---

## 6. Drift / new observations

1. **No drift.** Working tree matches the post-remediation state described in
   `2026-09-22-fix-designs.md` (approved + implemented 2026-09-22 evening).
   `git log` shows only the single squashed initial commit (`fb4ab23`),
   unmodified since.
2. **`cancelRotation()` (L380-388)** is new relative to the fix design doc
   (which specified propose + confirm only). Benign and sensible: lets the
   arbiter or guardian cancel a pending proposal, e.g. one made by a
   compromised guardian. No new fund-movement power.
3. **`guardian` is a single EOA by design** (fix doc: "founder EOA, set at
   construction"; contract NatSpec L105-110 agrees). Residual noted in the
   design: guardian compromise ⇒ 14-day-visible malicious rotation. Arbiter
   itself should still be the founder multisig at deploy (recommendation
   unchanged; contract takes whatever address is passed).
4. **M2 self-dealing revert intact** (`revert SelfDealing()`, L212) — not in
   this workstream's numbered items but verified while reading; the
   reputation-farming vector stays closed.
5. **Contracts still undeployed** — nothing in the sources suggests otherwise;
   the deploy script's fail-closed requires plus `address(0)` placeholders
   mean it cannot run successfully as-is. Confirms the audit-era "nothing
   deployed, nothing broadcast" state is unchanged.
6. **Out of scope but observed:** the `FOUR02_SETTLE_API_KEYS` allowlist
   (M1-facilitator) lives in the TS facilitator, not the contracts — deferred
   to the facilitator workstream.

## Bottom line

All five numbered remediation items **hold** in current source with exact
file:line references above. No regressions, no drift, no new issues found in
the contracts themselves. Remaining pre-mainnet actions are unchanged from the
audit: founder sets ARBITER / FEE_RECIPIENT / GUARDIAN / confirms FEE_BPS (75
still proposed-not-approved) / reviews REFUND_DELAY (24h), deploys arbiter as
multisig, and a professional audit before mainnet volume.
