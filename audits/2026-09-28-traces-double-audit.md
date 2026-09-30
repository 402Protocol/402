# TRACES Double Audit — 2026-09-28 (overnight)

**Target:** `contracts/TracesLicense.sol` (+ `contracts/ERC721CCompat.sol`, its transfer-gating base)
**Commit audited:** `150bf98` (working tree clean)
**Method:** Two sequential adversarial audits. Audit 1 = smart-contract security. Audit 2 = economics + mechanism design (read Audit 1's findings first).
**No contract source was modified.** PoC tests were added as new files only:
`test/sol/TracesAudit1.t.sol`, `test/sol/TracesAudit2.t.sol`.
**Rule:** Do not deploy or fix until Father reviews this report.

## Test results

| Suite | Result |
|---|---|
| Existing `TracesLicense.t.sol` | 35/35 pass |
| Fork rehearsal on live Ink (`TracesForkRehearsal.t.sol`) | 1/1 pass |
| Audit 1 PoCs (`TracesAudit1.t.sol`) | 10/10 pass |
| Audit 2 mechanism demos (`TracesAudit2.t.sol`) | 4/4 pass |

**Verdict up front:** No Critical vulnerabilities. The contract is competently written — reentrancy posture is good, caps are airtight, payment flow is atomic. But there are **two Highs in each audit** that break documented invariants of the product design, and the biggest one is architectural: **the $10-whitelist / 1:1-terminal-holder / phased-drop design has zero onchain representation**, and **the seat↔agent pairing does not survive (or follow) transfers**, which undermines the "worker license" model the whole job board depends on.

---

# AUDIT 1 — Smart-contract security

## High

### A1-H1 — No onchain whitelist or phase enforcement (design gap)
**PoC:** `test_PoC2_NoWhitelistEnforcement` — a random address with no Quotrons terminals mints successfully the moment `mintOpen` is true.

The decided mint design ($10 whitelist / $12 public, whitelist = Quotrons **terminal NFT** holders 1:1, unclaimed WL rolls into public) exists nowhere in the contract. There is one `price`, one `mintOpen` boolean, and a permissionless `mint()`. Consequences:
- During any "whitelist phase," anyone can bypass OpenSea/the site and call the contract directly at `price`.
- There is no WL window, no public window, no rollover — "unclaimed whitelist rolls into public" cannot happen because phases don't exist.
- The 1:1-per-terminal rule is unenforceable (see A2-H3).

**Fix (pick one before deploy):** (a) add a merkle-root whitelist phase to the contract (WL price + WL window, then public price + public window); or (b) formally document that phases are enforced by OpenSea's drop stages and keep the contract's `mint` closed until the public phase — but then the WL sale needs its own mint path (it can't be this contract's `mint`, which is closed).

### A1-H2 — Stale pairing survives transfer: the license does NOT follow the token holder
**PoC:** `test_PoC1_StalePairingAfterTransfer` — after a secondary sale, `seatToAgent[token]` still points at the seller's agent and `agentToSeat[sellerAgent]` is still set. The buyer's license is dead until they discover and call `repairSeat`; `pairSeat` reverts for them (`SeatAlreadyPaired`).

This contradicts the contract's own docstring on `repairSeat`: *"The license always follows the token holder."* It doesn't — it follows whoever last called pair/repair. Two impacts:
1. **License double-spend (system level):** against a naive job-board check (`agentToSeat[agentId] != 0`), the seller keeps a working "licensed" agent after selling the seat.
2. **Buyer grief/UX:** a secondhand buyer who doesn't know about `repairSeat` holds a dead license; nothing in the token tells them.

**Fix (pick one before deploy):** (a) clear both pairing mappings in `_update` on every real transfer (from != 0, to != 0) — the license truly follows the holder, at the cost of deactivating on every transfer (including self-transfers between own wallets); or (b) keep stale state but lock in the hardened eligibility check as the job-board rule: `agentToSeat[agentId] != 0 && ownerOf(seat) == registry.ownerOf(agentId) && seatToAgent[seat] == agentId` (see A2-H2). Note the existing test `test_RepairSeatAfterSecondarySale` asserts the *stale* behavior — it will need updating if (a) is chosen.

## Medium

### A1-M1 — Owner can rug the price under existing max approvals
**PoC:** `test_PoC4_OwnerPriceRugUnderMaxApproval` — user approves max (standard UX), owner front-runs `setPrice(100x)`, mint pulls 100x to treasury. `setPrice` has no timelock, no cap, no event-before-effect. **Fix:** timelock on `setPrice`; frontend should request exact-amount approvals until then.

### A1-M2 — Owner can brick all transfers via the transfer validator
**PoC:** `test_PoC5_ValidatorBricksTransfers` — owner sets a reverting validator; every `transferFrom` reverts (collection becomes soulbound at will). Unbricking also requires the owner. Standard trust assumption for 721C-style gating, but it should be an explicit acknowledgment, ideally behind the planned multisig/timelock.

### A1-M3 — No `baseURI` setter: metadata frozen at deploy
**PoC:** `test_PoC8_NoBaseURISetter` — no `setBaseURI`/`setBaseTokenURI` exists. A wrong IPFS CID at deploy bricks discoverability forever (tokenURI would 404 for all 10k). **Fix:** add an owner-gated (timelocked) `setBaseURI`, or verify the CID 10 times over pre-deploy per the deploy bar.

### A1-M4 — 10/wallet cap is per-wallet, trivially sybiled
**PoC:** `test_PoC3_WalletCapSybil` — 5 fresh EOAs × 10 mints = 50 seats, one payer. Contract wallets work too (any contract implementing `onERC721Received`). The cap is a rate limit, not an anti-whale measure. **Fix:** acknowledge as-is, or bind the cap to 8004 identity ownership if per-person matters.

## Low

### A1-L1 — Constructor doesn't verify `identityRegistry_` has code
Only zero-address is rejected. Deploying with an EOA (or wrong address) makes `IDENTITY_REGISTRY.ownerOf(...)` revert on ABI-decode — **pairing would be permanently bricked** (immutable variable, non-upgradeable contract). **Fix:** `require(identityRegistry_.code.length > 0)` or a deploy-script check.

### A1-L2 — No rescue for stuck ETH / accidental ERC20s
No `receive`/`fallback`, no sweep. Direct ETH sends or mistaken token transfers to the contract are locked forever. (Mint payments themselves go straight to treasury — good — so anything sitting in the contract is accidental.) **Fix:** owner-gated `rescueETH`/`rescueERC20` (excluding nothing, since payment token never custodies).

### A1-L3 — USDC blacklist DoS
FiatTokenV2 can blacklist addresses. If `treasury` is ever blacklisted, every `mint` reverts until `setTreasury` is called. Operational note; keep a standby treasury.

### A1-L4 — Canonical 721C validator may deploy on Ink later
`getTransferValidator()` returns `0x721C008fdff27BF06E7E123956E2Fe03B63342e3`, which has no code on Ink today → transfers unrestricted (correct). That address is a keyless Limit Break deployment that *could* appear on Ink later; default behavior is allow-all, but transfer semantics should be re-checked if it does.

### A1-L5 — No `unpairSeat`
A compromised agent's pairing cannot be revoked without transferring the seat. Operational gap; pairs with A2-H1's fix discussion.

## Informational (verified good)

- **A1-I1 — Payment-before-mint is atomic.** `test_PoC6_MintAtomicityOnReceiverRevert`: a reverting `onERC721Received` reverts the whole tx; payer's USDC untouched, no token consumed. The pull-then-mint ordering loses nothing.
- **A1-I2 — Callback pairing is benign.** `test_PoC7_CallbackAtomicPair`: a recipient contract *can* `pairSeat` inside its own mint callback (ownership is set before the callback), but it can only pair its own seat to its own agent — legitimate.
- **A1-I3 — Reentrancy posture is good.** `nonReentrant` on `mint`/`mintBatch`/`teamMint`; `pairSeat`/`repairSeat` make no state-changing external calls (`IDENTITY_REGISTRY.ownerOf` is a view to a trusted contract; a malicious registry couldn't pass the holder check on reentry anyway).
- **A1-I4 — Supply cap is airtight.** `test_PoC10_SupplyBoundary`: token 10000 mints, 10001 and over-size batches revert with `MaxSupplyReached`. Sequential IDs 1..10000 guaranteed.
- `supportsInterface` correctly advertises ICreatorToken + ICreatorTokenLegacy + ERC-2981; OZ v5 `_update`/`_increaseBalance` overrides follow the canonical Enumerable pattern; royalty math (500 bps) and `setTreasury` royalty-receiver update verified.

---

# AUDIT 2 — Economics + mechanism design

*(Ran after Audit 1; builds on A1-H1, A1-H2, A1-M4.)*

## High

### A2-H1 — License multiplexing: one seat, unlimited serial agent licenses, at gas cost
**Demo:** `test_Demo1_LicenseMultiplexing` + `test_Demo4_NoRepairCooldown` — one seat is paired, then `repairSeat`-rotated across 3 agents owned by the same EOA, back-to-back in the same block. No fee, no cooldown.

If the job board gates **per-agent** at claim time, a single $12 seat becomes an unlimited license printer: pair → claim job as agent 1 → repair → claim as agent 2 → … The "1 seat = 1 worker" scarcity story breaks. Note this defeats even the hardened eligibility check, because the multiplexing is *serial* — every point-in-time check passes.

**Fix (pick one):** (a) `repairSeat` cooldown (e.g., 7–30 days) and/or a repair fee; (b) account jobs **per-seat** instead of per-agent (a seat earns once per job regardless of which agent claims); (c) make pairing sticky — `repairSeat` only to a *never-before-paired* agent. The right choice depends on the job-board design, which should be specified before deploy.

### A2-H2 — License rental via agent-identity transfer
**Demo:** `test_Demo2_RentalViaAgentTransfer` — Alice pairs seat→agent, then transfers the **agent identity** (ERC-721 in the 8004 registry) to Bob. Bob now controls a "licensed" agent while owning no seat. The naive check `agentToSeat[agentId] != 0` **still passes**.

**This is the single most important integration invariant in the worker-license model.** The job board MUST NOT use the naive check. The hardened check that rejects the rental:
```
eligible(agentId) :=
    agentToSeat[agentId] != 0
    && traces.ownerOf(agentToSeat[agentId]) == registry.ownerOf(agentId)
    && traces.seatToAgent[agentToSeat[agentId]] == agentId
```
i.e., **the same EOA must currently own both the seat and the agent identity**. (Out of scope but noted: custodial key-sharing — "operate my agent for me" — can't be prevented onchain.)

### A2-H3 — Whitelist terminal pass-around (if WL = "holds terminal now")
If whitelist eligibility is ever implemented as a *current* terminal balance check (site or contract), **one terminal mints unlimited WL spots**: Alice holds terminal → mints WL → transfers terminal to Bob → Bob mints WL → … Each mint is 1:1 with *current* holding, not with distinct terminals. The only sound design is a **snapshot**: terminals held at snapshot block → fixed per-address allocation (merkle root), each terminal counted exactly once. This compounds A1-H1 — currently there is no WL mechanism at all, so this must be designed, not patched.

## Medium

### A2-M1 — Snapshot timing: announced invites farming, surprise is fairer
Undecided per the brief. Announced snapshot → terminal accumulation by farmers (4 addresses already hold exactly 17 terminals; top-10 hold ~1,200 of 4,234). A farmer buying terminals purely for WL spots is rational if a WL spot's expected value exceeds the terminal price. **Recommendation:** surprise snapshot at a past block + merkle root + per-address allocation. Announced only if the goal is to reward *current* holders' patience rather than fairness.

### A2-M2 — Cross-chain WL check is impractical onchain
Terminals live on Robinhood Chain (ERC-721 mirror `0x027ACa2794E44f24950D81227DcD516FfBB49d6e`); TRACES lives on Ink. There is no trustless onchain "holds a terminal" check at mint time — another reason the merkle-snapshot design (A2-H3) is the only sound one.

### A2-M3 — Team self-dealing capacity (natively available)
**Demo:** `test_Demo3_TeamSelfDealing` — 100 free `teamMint`s spread over 10 wallets + free 8004 registrations = 100 "licensed" worker agents for gas money, zero USDC to treasury. The machinery to fake swarm activity exists in the contract itself. Not a vulnerability per se (it's Father's project), but: disclose team seats publicly and keep a public team-mint log, or the "watch agents get rich" spectacle is one accusation away from a public teardown.

### A2-M4 — Unclaimed-WL rollover has no mechanism
"Unclaimed whitelist allocation rolls into public" requires phased minting (WL window with deadline → public window). No phases exist (A1-H1). Must be designed with the merkle phase.

## Low

### A2-L1 — Royalty evasion
ERC-2981 is voluntary signaling. OTC deals, private transfers, and wrapping (vault/ fractionalization contracts) bypass the 5% cleanly; the ERC-721C validator is inert on Ink (A1-L4), so there's no enforcement layer. If enforceable royalties matter, deploy/configure a transfer validator with an operator allowlist — currently not planned.

### A2-L2 — $10 / $12 spread economics
The 20% WL discount is modest: max discount capture is $20 per 10-cap wallet. WL spot value derives from secondary floor, not the discount. No issue; just don't expect the discount alone to drive demand.

### A2-L3 — Mint sniping / gas wars
No per-transaction cap beyond the wallet cap; bots can sweep 10/wallet across many wallets at open. With 10k supply that's 1,000 wallets to sell out — fine for a fair drop, but expect bots on a hyped mint. Consider a per-tx cap (e.g., 2–3) for the public phase.

### A2-L4 — 8004 registry is upgradeable by the 8004 team
`IDENTITY_REGISTRY` is immutable in *our* contract, but the registry itself is `IdentityRegistryUpgradeable` controlled by the 8004 team. Pairing integrity rests on their `ownerOf`. Monitor their upgrades.

## Informational

- **A2-I1 — The job side is honest by construction.** BountyEscrow requires a distinct requester to lock real USDC per job — Self-assigned job wash can't happen on the 402 board. The risk surface is entirely the *worker-license* side (this audit's Highs), not job fabrication.

---

# Prioritized fix list (for Father's review — nothing ships until he signs off)

**P0 — before deploy:**
1. **Whitelist design:** surprise snapshot at a past block → merkle root with per-address allocation (terminals counted once) → contract-enforced WL phase (WL price + window) → public phase (public price + window) with automatic rollover. Resolves A1-H1, A2-H3, A2-M1, A2-M2, A2-M4. (Alternative: formally scope WL enforcement to OpenSea stages and keep contract mint closed until public — but then the contract needs no `mintOpen` WL ambiguity.)
2. **Pairing/transfer invariant:** either clear both pairing mappings in `_update` on transfers (license truly follows the holder), or lock in the hardened eligibility check as *the* job-board rule and document that stale pairings are expected. Resolves A1-H2, A2-H2.
3. **Repair economics:** add a `repairSeat` cooldown and/or fee, or account jobs per-seat instead of per-agent — otherwise one $12 seat serially licenses unlimited agents. Resolves A2-H1. (Needs the job-board spec to pick correctly.)

**P1 — strongly recommended:**
4. Owner controls → multisig + timelock (standing long-term plan); at minimum timelock `setPrice` and `setTransferValidator`. (A1-M1, A1-M2)
5. Add timelocked `setBaseURI`, or verify the IPFS CID 10× pre-deploy. (A1-M3)
6. Add `rescueETH`/`rescueERC20` for stuck funds. (A1-L2)
7. `code.length` check on `identityRegistry_` in the constructor. (A1-L1)

**P2 — operational:**
8. Public team-mint log; disclose team seats. (A2-M3)
9. Re-check transfer semantics if the canonical 721C validator ever deploys on Ink. (A1-L4)
10. Frontend: exact-amount USDC approvals (mitigates A1-M1 until timelock lands). (A1-M1)
11. Keep a standby treasury address (USDC blacklist DoS). (A1-L3)

---

# Appendix: files

- Contract: `~/workspace/402/contracts/TracesLicense.sol` (unchanged)
- Transfer gating: `~/workspace/402/contracts/ERC721CCompat.sol` (unchanged)
- Audit 1 PoCs: `~/workspace/402/test/sol/TracesAudit1.t.sol` (10 tests, all pass)
- Audit 2 demos: `~/workspace/402/test/sol/TracesAudit2.t.sol` (4 tests, all pass)
- This report: `~/workspace/402/audits/2026-09-28-traces-double-audit.md`

---

# Addendum — P0 fixes implemented 2026-09-28 (founder-approved)

Father approved all three P0 design decisions on 2026-09-28 ~15:00 EDT, with two
refinements: the snapshot will be a **surprise past-block snapshot, never
announced**, and the repair cooldown is **72h** (no fee).

## What changed in `contracts/TracesLicense.sol`

1. **Merkle whitelist + contract-enforced phases + rollover** (resolves A1-H1, A2-H3)
   - `whitelistMerkleRoot`, `whitelistStart`, `whitelistEnd` (owner-set, all
     locked once the window starts via `WhitelistLocked`).
   - `whitelistMint(terminalId, proof)`: leaf =
     `keccak256(bytes.concat(keccak256(abi.encode(wallet, terminalId))))`
     (OZ sorted-pair hashing). Each Quotrons terminal claims exactly once
     (`terminalClaimed`), seat goes to the claiming wallet, charged at
     `whitelistPrice` ($10).
   - `mint`/`mintBatch` revert with `WhitelistPhaseActive` during the window;
     after `whitelistEnd` the public sale runs at `price` ($12). Unclaimed WL
     allocation rolls over automatically — one shared 10k supply.
   - Constructor now takes `whitelistPrice_` and `publicPrice_` separately.
   - Snapshot ops (offchain, at deploy time): take a surprise snapshot of the
     Quotrons terminal contract (`0x027ACa2794E44f24950D81227DcD516FfBB49d6e`)
     on Robinhood Chain at a **past, unannounced block**, build the tree with
     the leaf formula above, `setWhitelistMerkleRoot` + `setWhitelistWindow`,
     then `setMintOpen(true)`.

2. **Pairings auto-clear on transfer** (resolves A1-H2)
   - `_update` clears `seatToAgent`/`agentToSeat` on every real transfer and
     emits `SeatUnpaired(tokenId, agentId)`. The license now truly follows the
     token holder; secondhand buyers activate with `pairSeat` directly.
   - Defense in depth stands: job-board integrations must still check the same
     wallet owns both seat and agent (agent identities remain transferable
     ERC-721s — A2-H2's rental vector is mitigated at the assignment layer,
     documented in the contract natspec).

3. **72h `repairSeat` cooldown** (resolves A2-H1)
   - `REPAIR_COOLDOWN = 72 hours`, per-seat `lastRepairAt`. First repair is
     free (never-repaired seats skip the check); subsequent repairs inside the
     window revert with `RepairCooldown`. Serial license multiplexing is dead;
     legitimate re-pairing still works after the cooldown.

4. **Small hardening** (resolves A1-M3, A1-L1)
   - Owner-only `setBaseURI` (emits `BaseURIUpdated`) — a wrong deploy-time CID
     is correctable instead of permanent.
   - Constructor reverts with `RegistryNotContract` if `identityRegistry_`
     has no code.

## Verification (2026-09-28)

- `forge build`: clean.
- TRACES suites: **62/62 green** — `TracesLicense.t.sol` (updated),
  `TracesAudit1.t.sol` (PoC-1/2/8 rewritten as fix-regression tests; PoC-3/4/5/6/7/9/10 kept),
  `TracesAudit2.t.sol` (Demo-1/4 rewritten as cooldown-regression tests; Demo-2/3 kept as informational),
  new `TracesP0Fixes.t.sol` (10 tests: multi-leaf merkle tree, rollover, cap interaction,
  param locking, window validation, constructor check, secondhand flow, safeTransfer clearing),
  `TracesForkRehearsal.t.sol` (live Ink fork, real USDC) — all pass.
- Full repo `forge test`: **347/347 green** (15 suites, incl. fuzz + Ink fork rehearsal).

## Residuals (unchanged, founder's call)

- Owner can still reprice sharply without a timelock (A1-M1) and brick transfers
  via a reverting validator (A1-M2) — needs the standing timelock+multisig plan.
- 10/wallet cap remains Sybil-able with fresh EOAs (A1-M4) — inherent.
- ERC-2981 royalties remain voluntarily enforced (A2 analytical) — inherent.
- Team 100 free mints → recommend a public team-mint log at launch (A2-M3).
- No `rescueETH`/`rescueERC20` (A1-L2) — not added; contract holds no ETH path,
  USDC only moves via pull-payments to treasury.

**Deploy status: still NOT authorized.** Fixes are code-complete and tested; no
deploy, no mainnet broadcast, no public announcement until Father says so.
