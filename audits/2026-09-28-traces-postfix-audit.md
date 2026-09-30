# TRACES Post-Fix Audit — 2026-09-28 (afternoon)

**Scope:** `contracts/TracesLicense.sol` at commit `7e2aa9b` (the P0-fixed version),
read-only. Two independent parallel audits: **Audit 3 (security)** and
**Audit 4 (mechanism/economics)**. Neither modified the contract; nothing
deployed; no mainnet touched.

**Test evidence:** 81/81 TRACES tests green (`forge test --match-contract "Traces"`),
including 19 new adversarial PoCs — `test/sol/TracesAudit3.t.sol` (11, security)
and `test/sol/TracesAudit4.t.sol` (8, mechanism).

---

## Headline: both auditors independently found the same High

The 72h `repairSeat` cooldown **does not achieve its goal**. `pairSeat` was never
gated, and the new auto-clear hands out a free unpair on every transfer:

> `pairSeat(a1)` → self-transfer (auto-clear) → `pairSeat(a2)` → self-transfer →
> `pairSeat(a3)` … — unlimited serial licenses in the same block, `lastRepairAt`
> never set, ~2 txs per rotation. A two-wallet ping-pong variant works without
> self-transfers.

The fixes cooled `repairSeat` but opened the transfer+`pairSeat` path. Pre-fix,
`repairSeat` was the *only* rotation path; post-fix, the bypass is arguably
easier than the original. "One seat = one worker" is **not enforced onchain**.

- Not Critical: no fund theft — it is license-terms enforcement, and an
  integration-layer mitigation exists (per-seat job accounting).
- Fix options: (a) extend the cooldown to `pairSeat` as well, no reset on
  transfer — strongest onchain; rare UX wart where a secondhand buyer waits up
  to 72h if the seller repaired just before selling; (b) reset the clock on
  genuine ownership change — **do not use alone**, two-wallet ping-pong defeats
  it; (c) per-seat (not per-agent) job accounting at the job board as the
  primary defense, cooldown as speed bump. Both auditors recommend (a)+(c), or
  explicit acceptance of the residual with (c) committed.

---

## Audit 3 — Security findings

**Verdict: not deployment-ready — A3-H1 blocks it.** No Criticals. Access
control sound on all 13 external functions; payment paths atomic and
reentrancy-clean (proven against a malicious USDC); merkle leaf construction
sound (double-hashed `abi.encode(wallet, terminalId)`, OZ sorted pairs);
clearing happens before the 721C validator call; supply/cap/team-cap math
airtight; every state-changing function emits an event.

### 🔴 A3-H1 (High) — cooldown bypass via transfer + `pairSeat` rotation
PoCs: `test_A3H1_CooldownBypassViaSelfTransferPairRotation`,
`test_A3H1_TwoWalletPingPongRotation`. See headline.

### 🟡 A3-L1 (Low) — constructor checks registry code, not payment-token code
Deploying with an EOA as `paymentToken` bricks all paid mints (reverts via
`SafeERC20FailedOperation`, not free mints — proven). Inconsistent validation;
deploy-time footgun. Fix: add `paymentToken_.code.length == 0` check.

### 🟡 A3-L2 (Low) — secondhand buyer inherits the seller's cooldown clock
`lastRepairAt` persists across transfers by design. PoC:
`test_A3L2_BuyerInheritsSellerCooldown`. Rare UX wart; flip side is it
strengthens anti-multiplexing.

### ℹ️ A3-I1 (Informational) — self-transfer wipes your own pairing
`transferFrom(alice, alice, 1)` clears the pairing though ownership is
unchanged. Documented tradeoff — and it doubles as the permissionless
`unpairSeat` the first audit noted was missing (A1-L5 partially mitigated).

### P0 fixes verified as holding (security)
- Merkle WL: non-member blocked, double-claim blocked, public mint blocked
  during WL, proofs can't replay across wallets, phase boundaries correct,
  reentrancy on `whitelistMint` blocked (nonReentrant + `terminalClaimed` set
  before the payment pull).
- Auto-clear on transfer: both mappings cleared, buyer's seat arrives clean.
- `repairSeat` cooldown: back-to-back `repairSeat` reverts; succeeds after 72h.

---

## Audit 4 — Mechanism/economics findings

**Verdict: not deployment-ready at the mechanism level.**

### 🔴 H-1 (High) — same cooldown bypass as A3-H1
PoC: `test_Audit4_CooldownBypassViaTransferPairLoop`. `test_Audit4_RepairCooldownSurvivesSelfTransfer`
proves the clock itself is per-token and tamper-proof — the hole is the
ungated `pairSeat` path, not the clock.

### 🟡 M-1 (Medium) — 10/wallet cap strands whitelist entitlements of large terminal holders
PoC: `test_Audit4_WalletCapStrandsLargeTerminalHolder`. The design promises 1:1
per terminal, but a wallet holding 11+ terminals at snapshot can claim only 10
— the 11th valid claim reverts `WalletCapExceeded` and the entitlement is
stranded forever (the leaf binds the snapshot wallet; nobody else can claim
that terminal). **Directly relevant: the founder holds 17 terminals — if in one
wallet, 7 entitlements die.** Fix: exempt `whitelistMint` from `MAX_PER_WALLET`
(the terminal count is the binding scarcity, not the wallet).

### 🟡 M-2 (Medium) — the merkle root is a trusted input; the contract cannot verify it
PoC: `test_Audit4_WhitelistRootIsTrustedInput`. A malicious/compromised snapshot
builder can insert leaves for addresses holding no terminals and print $10 WL
spots. Inherent to merkle drops — operational fix: publish the snapshot block +
full leaf list at launch so anyone can recompute the root independently.

### 🟡 M-3 (Medium) — public price rug after whitelist, no timelock
PoC: `test_Audit4_PublicPriceRugAfterWhitelist` ($120k USDC pulled for 10 seats
in the PoC). `setPrice` has no phase lock; the phased design widens the window
— the owner observes WL demand, then reprices the public phase. Accepted
residual under the standing timelock+multisig plan; quantified here.

### 🟡 M-4 (Medium) — `pairSeat` is the unthrottled activation path
PoC: `test_Audit4_PairSeatHasNoActivationThrottle`. 20 seats paired in one
block; the A2-M3 swarm capacity (100 free team seats → 100 "licensed" workers
for gas) is fully intact. The P0 narrative overstates what the cooldown covers
— it throttles only *changes*, never *activations*.

### 🟢 L-1 (Low) — owner can halt the whitelist mid-window
`setMintOpen(false)` freezes claims until reopened. Grief/delay only, no theft.
Trust residual.

### 🟢 L-2 (Low) — the $10/$12 spread is economically thin
20% discount, max $20/wallet capture. WL value is allocation certainty (no gas
war), not price. Don't market the discount as the incentive.

### ℹ️ Informational
- **I-1:** License rental is revocable by the seat holder at any time
  (self-transfer auto-clears). Rentals are trust-based and fragile — the job
  board must re-check eligibility at payout, not just at assignment.
- **I-2:** Secondhand-buyer UX improved — seat arrives clean, `pairSeat`
  directly, no `repairSeat` discovery step.
- **I-3:** The WL claim belongs to the *snapshot* holder, not the current
  terminal holder. Post-snapshot terminal buyers get no WL — document at launch.
- **I-4:** `whitelistMint` is `msg.sender`-only (no gifting/vaulting WL mints);
  failed claims don't consume the entitlement.

### P0 fixes verified as holding (mechanism)
| Fix | Status |
|---|---|
| Merkle WL + phases + rollover | ✅ Holds |
| Auto-clear pairings on transfer | ✅ Holds |
| 72h cooldown (repair path) | ✅ Holds narrowly |
| 72h cooldown (mechanism intent) | ❌ Bypassed — H-1 |
| `setBaseURI` + registry code check | ✅ Holds |

---

## Job-board eligibility check (spec, from Audit 4)

Evaluate **at assignment time AND at payout/claim time** — pairings change, never
cache across windows:

```solidity
function isEligibleForPaidWork(
    TracesLicense traces,
    IIdentityRegistry registry,
    uint256 agentId
) internal view returns (bool) {
    uint256 seatId = traces.agentToSeat(agentId);
    if (seatId == 0) return false;                            // (1) agent is paired
    if (traces.seatToAgent(seatId) != agentId) return false;   // (2) pairing is mutual
    // (3) the SAME wallet currently owns both the seat and the agent identity.
    //     Treat a revert from either ownerOf as ineligible.
    return traces.ownerOf(seatId) == registry.ownerOf(agentId);
}
```

Structural requirement (given H-1): **account jobs per seat, not per agent** —
a seat may hold/earn only one active job at a time, so multiplexed agents share
the seat's single slot. Per-agent gating alone is defeated by the transfer
loop. Never use `agentToSeat[agentId] != 0` alone (fails open on rental).
Custodial key-sharing is undetectable onchain — out of scope.

---

## What blocks deployment

1. **H-1 / A3-H1** — onchain license scarcity unenforced; pick a fix (extend
   cooldown to `pairSeat`, and/or commit to per-seat job accounting).
2. **M-1** — one-line fix: exempt `whitelistMint` from the wallet cap (breaks
   the 1:1 promise for the founder's own 17-terminal position otherwise).
3. **M-2 (operational)** — commit to publishing snapshot block + full leaf list
   at launch.

Plus the standing residuals: timelock+multisig for owner powers (M-3, A1-M1/M2),
wallet-cap Sybil-ability, voluntary royalties, public team-mint log.

**Deploy status: NOT authorized. No code changes made in this round — findings
held for Father's review.**
