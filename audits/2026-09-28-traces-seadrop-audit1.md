# TRACES SeaDrop Audit 1 — 2026-09-28

**Target:** `contracts/TracesLicenseSeaDrop.sol` (commit `94ae7de`) + vendored
SeaDrop interfaces in `contracts/seadrop/`
**Method:** adversarial review + 22 runnable forge PoCs in
`test/sol/TracesSeaDropAudit1.t.sol` (all passing). The target contract was
**not modified**. Nothing committed or pushed.
**Threat model:** owner key trusted-but-compromisable (single EOA today,
timelock+multisig planned); SeaDrop canonical contract trusted; ERC-8004
registry trusted at deploy (it is upgradeable — see I-5); minters arbitrary.

## Verdict: SHIP WITH CONDITIONS

No Criticals. No Highs. One Medium that breaks an explicit product promise
(the fixed 10,000 supply) and needs an explicit decision before deploy —
it is inherent to the SeaDrop metadata interface, so "fixing" it means a
policy/owner-structure decision, not a code patch. Three Lows, all in the
owner-trust bucket or targeted-grief class. Details below.

**Conditions before deploy:**
1. Disposition M-1: either hard-ceiling `maxSupply` at 10,000 in code, or
   accept raisability under timelock+multisig (standing plan) with an
   explicit owner attestation. Do not ship with a single EOA able to
   silently dilute.
2. Acknowledge L-3 (agent-side stale pairing has no permissionless clear);
   optionally add an agent-owner-initiated `clearStalePairing`.
3. Standard residuals stand: timelock+multisig for owner powers, professional
   audit before meaningful volume.

---

## Findings

### M-1 — `setMaxSupply` is raisable without bound; the 10k fixed supply is owner-mutable (Medium)

The product invariant is "10,000 seats, fixed." `setMaxSupply` only rejects
`newMaxSupply < totalSupply()` — the owner can raise it to 1,000,000 and keep
minting through SeaDrop, silently diluting every holder. This is
canonical-faithful (OpenSea's own `ERC721SeaDrop` behaves identically, and the
`ISeaDropTokenContractMetadata` interface *requires* the setter), so it cannot
be "patched out" without deviating from the SeaDrop token standard. It is a
governance decision, not a code bug — but it is the one owner power that
directly breaks the collection's core economic promise, unlike royalty/URI
changes which are visible and market-priced.

- PoC: `test_B2_ownerCanRaiseMaxSupply` — raises to 1,000,000, then
  demonstrates the enforcement follows the *current* cap (3 → mint 3 →
  raise to 6 → mint 3 more, which would have reverted pre-raise).
- Recommendation: hard ceiling (`require(newMaxSupply <= INITIAL_MAX_SUPPLY)`)
  or timelock+multisig with public attestation. Do not leave this on a
  single EOA at deploy.

### L-1 — `updateAllowedSeaDrop` accepts EOAs and codeless addresses (Low)

No code check on the allowlist. The owner can add an arbitrary EOA, which can
then call `mintSeaDrop` directly — free mints with no SeaDrop stage, no
payment, no wallet caps.

- PoC: `test_B1_eoaInAllowlistBypassesSeaDrop` — owner adds attacker EOA;
  attacker mints 5 tokens directly. **Works.**
- Severity is Low, not higher: exploiting it requires the owner to add the
  attacker, and a malicious owner can deploy a 5-line minter contract to the
  same effect — no privilege escalation beyond the owner-trust boundary.
- Recommendation: hygiene `code.length > 0` check in `_updateAllowedSeaDrop`
  (mirrors the existing `RegistryNotContract` / validator checks).

### L-2 — Owner-set transfer validator can brick all transfers while mints continue (Low)

`setTransferValidator` is owner-only (correct), but a malicious/compromised
owner can install a validator whose `validateTransfer` always reverts. All
secondary transfers brick; `mintSeaDrop`/`teamMint` keep working (mints skip
validation by reference semantics), so the owner could keep selling into a
frozen market.

- PoC: `test_B3_ownerValidatorCanBrickTransfers` — brick validator installed,
  `transferFrom` reverts `"bricked"`; owner disabling it (zero address)
  un-bricks. **Works.**
- Low: strictly inside the owner-trust boundary. Mitigated by the same
  timelock+multisig as all owner powers.

### L-3 — Stale `agentToSeat` after the 8004 *agent* transfers bricks that agent's future pairing (Low)

Seat-side transfers self-heal (auto-clear), but the pairing has a second
half: if the **agent** (ERC-8004 NFT) is transferred while the seat stays
put, `agentToSeat[agentId]` still points at the old seat. The new agent owner
cannot pair the agent to any seat (`AgentAlreadyPaired`), and **no
permissionless path exists to clear it** — only the seat holder (possibly an
uncooperative attacker) can `repairSeat`/`transfer`.

- PoC: `test_B5_staleAgentPairingBricksAgent` — attacker pairs seat→agent,
  transfers the agent to the victim; victim owns a seat and the agent but
  `pairSeat` reverts. **Works**, with the honest registry.
- Attack shape: targeted grief (brick a specific high-reputation agent's
  licensability). Cost is one seat + gas; no profit motive; victim can ignore
  the gifted agent. Hence Low, not Medium.
- Recommendation: add `clearStalePairing(tokenId)` callable by the *current
  agent owner* when agent-owner ≠ seat-owner (ownership divergence proves
  staleness, since `pairSeat` requires same-wallet ownership of both at pair
  time). Asymmetry note: the seat side never has this problem.

### I-1 — Cooldown inheritance is remainder-only, not a fresh 72h (Info)

A secondhand buyer waits out the *remainder* of the seller's 72h pairing
clock — the documented anti-rotation tradeoff, and the milder variant of it.

- PoC: `test_B4_buyerInheritsRemainingCooldown` — seller pairs at T, sells at
  T+71h; buyer blocked at T+71h, succeeds at T+72h+1.

### I-2 — Self-transfer clears the caller's own pairing (Info)

`transferFrom(alice, alice, id)` triggers auto-clear (from≠0, to≠0) but does
**not** reset `lastPairAt` — so it is not a cooldown bypass, just a
permissionless self-unpair. Harmless (only deactivates your own license).

- PoC: `test_A7_selfTransferDoesNotResetCooldown`.

### I-3 — `CannotExceedMaxSupplyOfUint64` declared but never enforced (Info)

The vendored metadata interface documents the uint64 ceiling; the
implementation's `setMaxSupply` does not check it. Harmless (uint256 supply
is fine for this collection), but a deviation from the interface's
documented contract.

### I-4 — Single-step `Ownable.transferOwnership` (Info)

Standard OZ behavior; a fat-fingered transfer bricks owner control
permanently. Consider `Ownable2Step` if the owner key stays an EOA.

### I-5 — Pairing integrity inherits the 8004 registry's upgrade trust (Info)

`IDENTITY_REGISTRY` is immutable, but the canonical registry itself is
`IdentityRegistryUpgradeable`. A rogue upgrade could misattribute
`ownerOf` and squat/pollute `agentToSeat`. Third-party trust assumption —
worth naming explicitly since pairing is the license.

### I-6 — `teamMint` consumes public supply (Info, intended)

Team mints count toward `maxSupply` and `totalSupply()`, so 100 team mints
leave 9,900 sellable through SeaDrop. Matches the documented design; flagging
so drop configuration accounts for it.

---

## Verified SAFE (failed exploits / proven properties)

| # | Property | PoC |
|---|----------|-----|
| A1 | Only allowed SeaDrop can call `mintSeaDrop` — EOAs **and even the owner** revert `OnlyAllowedSeaDrop` | `test_A1_nonSeaDropCannotMint` |
| A2 | Reentrancy via `_safeMint` receiver callback blocked — `nonReentrant` + state-before-mint; legitimate mint completes, exactly 1 token, accounting exact | `test_A2_reentrantMintBlocked` |
| A3 | Cross-SeaDrop-impl reentrancy (the exact scenario the SeaDrop NatSpec warns about) blocked by the same guard | `test_A3_crossImplReentrantMintBlocked` |
| A4 | Neither SeaDrop mints nor `teamMint` can exceed `maxSupply`; shared `nextTokenId` prevents ID gaps/doubles | `test_A4_cannotExceedMaxSupply` |
| A5 | Zero-quantity mints revert `EmptyBatch` | `test_A5_zeroQuantityReverts` |
| A6 | **H-1 rotation killed:** pair → transfer → pair in the *same block* reverts `PairCooldown`; buyer pairs fine after 72h | `test_A6_rotationAttackBlockedSameBlock` |
| A7 | Self-transfer does not reset the cooldown clock | `test_A7_selfTransferDoesNotResetCooldown` |
| A8 | Double-pairing blocked in both directions (`SeatAlreadyPaired`, `AgentAlreadyPaired`) | `test_A8_doublePairingBlocked` |
| A9/A10 | Cannot pair someone else's agent; non-seat-owner cannot pair | `test_A9/A10` |
| A11 | Pairings auto-clear on **every** transfer path (`transferFrom`, `safeTransferFrom`, `safeTransferFrom(bytes)`) | `test_A11_autoClearAllTransferPaths` |
| A12 | Default 721C validator has no code on Ink → transfers unrestricted, cannot be bricked by absence | `test_A12_defaultValidatorDoesNotBrick` |
| A13 | `setTransferValidator` rejects codeless non-zero addresses | `test_A13_codelessValidatorRejected` |
| C1 | `getMintStats` is cumulative per wallet (ERC721A `_numberMinted` semantics) — transfers do **not** reset SeaDrop wallet caps | `test_C1_mintStatsSurviveTransfers` |
| C2/C3 | `repairSeat` no-op reverts; repair correctly clears the old agent's reverse mapping | `test_C2/C3` |
| C4 | `RoyaltyInfo` adaptation is selector-identical to canonical SeaDrop (`setRoyaltyInfo((address,uint96))`) — interface IDs unaffected | `test_C4_royaltyInfoSelectorIsCanonical` |
| — | `INonFungibleSeaDropToken` ERC-165 ID accepted by the **live** Ink SeaDrop (pre-existing fork test `TracesSeaDropForkTest`) | fork vs `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` |

**Vendored interfaces:** `INonFungibleSeaDropToken`, `ISeaDropTokenContractMetadata`,
`ISeaDropConfig`, `SeaDropStructs` are verbatim against OpenSea's `main`
(modulo pragma/import paths) except the `RoyaltyInfo` relocation, which is
proven selector-identical (C4) and does not alter either interface ID. The
live-SeaDrop fork test is the empirical proof for the mint-path interface.

## Out of scope / not re-verified here

- SeaDrop's own bytecode (canonical, audited by OpenSea).
- OpenSea Studio UI acceptance of the custom contract on Ink (operational check).
- Job-board same-wallet invariant (offchain integration rule, documented in-contract).
- Full-suite regression: this audit added one test file only and did not touch
  the contract; sibling SeaDrop suites (28 unit + 1 fork) re-ran green.
