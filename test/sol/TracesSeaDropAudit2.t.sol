// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {console} from "forge-std/src/console.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {TracesLicenseSeaDrop} from "../../contracts/TracesLicenseSeaDrop.sol";
import {INonFungibleSeaDropToken} from "../../contracts/seadrop/INonFungibleSeaDropToken.sol";

/// @notice ERC-8004 registry stand-in WITH agent transfers, so we can model
///         the A2-H2 desync: seat stays, agent moves.
contract Audit2Registry {
    uint256 public nextId = 1;
    mapping(uint256 => address) public owners;

    function register() external returns (uint256 id) {
        id = nextId++;
        owners[id] = msg.sender;
    }

    function transferAgent(address to, uint256 id) external {
        require(owners[id] == msg.sender, "not agent owner");
        owners[id] = to;
    }

    function ownerOf(uint256 id) external view returns (address) {
        address o = owners[id];
        require(o != address(0), "no agent");
        return o;
    }
}

/// @notice Models the CANONICAL SeaDrop's cap enforcement, verified against
///         canonical SeaDrop.sol `_checkMintQuantity`:
///         `quantity + minterNumMinted > maxTotalMintableByWallet` reverts,
///         where minterNumMinted is the CUMULATIVE per-wallet count from the
///         token's getMintStats — checked independently by EVERY stage
///         (mintPublic AND mintAllowList). Caps are therefore
///         lifetime-cumulative across stages, not per-stage-additive.
contract Audit2SeaDrop {
    uint256 public wlCap;
    uint256 public publicCap;
    mapping(address => bool) public wl;

    function configure(uint256 _wlCap, uint256 _publicCap) external {
        wlCap = _wlCap;
        publicCap = _publicCap;
    }

    function setWL(address w, bool b) external {
        wl[w] = b;
    }

    function mintAllowList(address token, address minter, uint256 qty) external {
        require(wl[minter], "AUDIT: not allowlisted");
        (uint256 minted,,) = INonFungibleSeaDropToken(token).getMintStats(minter);
        require(minted + qty <= wlCap, "AUDIT: wl cap exceeded");
        INonFungibleSeaDropToken(token).mintSeaDrop(minter, qty);
    }

    function mintPublic(address token, address minter, uint256 qty) external {
        (uint256 minted,,) = INonFungibleSeaDropToken(token).getMintStats(minter);
        require(minted + qty <= publicCap, "AUDIT: public cap exceeded");
        INonFungibleSeaDropToken(token).mintSeaDrop(minter, qty);
    }
}

/// @notice Malicious SeaDrop: no caps, no payment. Models what an
///         owner-allowlisted SeaDrop (compromised owner key or rogue owner)
///         can do — the token contract enforces NOTHING itself.
contract Audit2EvilSeaDrop {
    function rug(address token, address to, uint256 qty) external {
        INonFungibleSeaDropToken(token).mintSeaDrop(to, qty);
    }
}

/// @notice Adversarial MECHANISM-DESIGN audit (Audit 2) for
///         TracesLicenseSeaDrop: attacks the LICENSE ECONOMICS, not code
///         bugs. Each test is a runnable game-theoretic PoC with quantified
///         impact (rotations/month, extra mints extracted, etc.).
contract TracesSeaDropAudit2Test is Test {
    TracesLicenseSeaDrop token;
    Audit2Registry registry;
    Audit2SeaDrop seaDrop;

    address OWNER = makeAddr("owner");
    address TREASURY = makeAddr("treasury");

    string constant BASE = "ipfs://base/";

    function setUp() external {
        registry = new Audit2Registry();
        seaDrop = new Audit2SeaDrop();
        address[] memory allowed = new address[](1);
        allowed[0] = address(seaDrop);
        token = new TracesLicenseSeaDrop(
            OWNER, address(registry), allowed, BASE, TREASURY, 500
        );
    }

    // ---------------------------------------------------------------------
    // M-1: rotation bound — one seat licenses at most 10 agents / 30 days.
    // ---------------------------------------------------------------------
    function testPOC_M1_RotationBoundQuantified() external {
        address attacker = makeAddr("attacker");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), attacker, 1); // tokenId 1

        uint256 t0 = block.timestamp;
        uint256[4] memory agents;
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(attacker);
            agents[i] = registry.register();
        }

        // Rotation 1: free (first pairing).
        vm.prank(attacker);
        token.pairSeat(1, agents[0]);
        assertEq(token.seatToAgent(1), agents[0]);

        // Rotations 2 and 3: one per 72h window.
        vm.warp(t0 + 72 hours + 1);
        vm.prank(attacker);
        token.repairSeat(1, agents[1]);
        assertEq(token.agentToSeat(agents[0]), 0); // old license revoked
        vm.warp(t0 + 144 hours + 2);
        vm.prank(attacker);
        token.repairSeat(1, agents[2]);
        assertEq(token.seatToAgent(1), agents[2]);

        // A 4th rotation inside the window is impossible.
        vm.prank(attacker);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.repairSeat(1, agents[3]);

        uint256 perMonth = (30 days) / token.PAIR_COOLDOWN();
        console.log("M-1: max distinct agent-licenses per seat per 30d:", perMonth);
        console.log("M-1: marginal license cost at $12 public:", 12 ether / perMonth, "USD-cents equiv per agent-month (12/10 = $1.20)");
        assertEq(perMonth, 10);
    }

    // ---------------------------------------------------------------------
    // M-1b: team seats farm licenses at $0.
    // (Team allocation is now a zero-price SeaDrop stage — owner decision
    // 2026-09-28. The economics are unchanged: 100 seats, $0 mint cost.)
    // ---------------------------------------------------------------------
    function testPOC_M1b_TeamSeatLicenseFarm() external {
        address operator = makeAddr("operator");
        seaDrop.configure(0, 10_000);
        seaDrop.mintPublic(address(token), operator, 100);
        assertEq(token.balanceOf(operator), 100);

        uint256 teamLicensesPerMonth = 100 * ((30 days) / token.PAIR_COOLDOWN());
        uint256 paidLicensesPerMonth = 9_900 * ((30 days) / token.PAIR_COOLDOWN());
        console.log("M-1b: team license capacity / month:", teamLicensesPerMonth);
        console.log("M-1b: team share of total license capacity (bps):", (teamLicensesPerMonth * 10_000) / (teamLicensesPerMonth + paidLicensesPerMonth));
        assertEq(teamLicensesPerMonth, 1_000);
    }

    // ---------------------------------------------------------------------
    // S-1 (SOUND): cooldown cannot be laundered via transfer / self-transfer.
    // ---------------------------------------------------------------------
    function testPOC_S1_CooldownLaunderingFails() external {
        address w1 = makeAddr("w1");
        address w2 = makeAddr("w2");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), w1, 1);

        vm.prank(w1);
        uint256 a1 = registry.register();
        uint256 t0 = block.timestamp;
        vm.prank(w1);
        token.pairSeat(1, a1);

        // Launder attempt 1: transfer to a fresh wallet, pair there.
        vm.prank(w1);
        token.transferFrom(w1, w2, 1);
        assertEq(token.seatToAgent(1), 0); // auto-clear happened...
        vm.prank(w2);
        uint256 b1 = registry.register();
        vm.prank(w2);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(1, b1); // ...but the clock survived the transfer.

        // Launder attempt 2: self-transfer resets nothing.
        vm.prank(w2);
        token.transferFrom(w2, w2, 1);
        vm.prank(w2);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(1, b1);

        // Honest path after the window: works.
        vm.warp(t0 + 72 hours);
        vm.prank(w2);
        token.pairSeat(1, b1);
        assertEq(token.seatToAgent(1), b1);
        console.log("S-1 SOUND: transfer/self-transfer do not reset the 72h pairing clock");
    }

    // ---------------------------------------------------------------------
    // M-4: secondhand buyer inherits the seller's remaining cooldown.
    // ---------------------------------------------------------------------
    function testPOC_M4_BuyerInheritsCooldownQuantified() external {
        address seller = makeAddr("seller");
        address buyer = makeAddr("buyer");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), seller, 1);

        vm.prank(seller);
        uint256 s1 = registry.register();
        uint256 t0 = block.timestamp;
        vm.prank(seller);
        token.pairSeat(1, s1);

        // Maximal grief: seller pairs 1s before selling.
        vm.warp(t0 + 1);
        vm.prank(seller);
        token.transferFrom(seller, buyer, 1);

        vm.prank(buyer);
        uint256 b1 = registry.register();
        vm.prank(buyer);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(1, b1);

        // Buyer waits out (almost) the full 72h.
        vm.warp(t0 + 72 hours);
        vm.prank(buyer);
        token.pairSeat(1, b1);
        assertEq(token.seatToAgent(1), b1);

        // Control: a never-paired ("virgin") seat pairs instantly for a buyer.
        seaDrop.mintPublic(address(token), seller, 1); // tokenId 2
        vm.prank(seller);
        token.transferFrom(seller, buyer, 2);
        vm.prank(buyer);
        uint256 b2 = registry.register();
        vm.prank(buyer);
        token.pairSeat(2, b2); // no revert: lastPairAt == 0
        console.log("M-4: max buyer activation delay after maximal-grief sale: ~72h; virgin seats pair instantly");
    }

    // ---------------------------------------------------------------------
    // S-2 (SOUND): WL mint -> transfer -> re-mint is blocked by the
    // cumulative _seaDropMinted counter.
    // ---------------------------------------------------------------------
    function testPOC_S2_WLRemintBlockedAfterTransfer() external {
        address holder = makeAddr("holder");
        address other = makeAddr("other");
        seaDrop.configure(2, 10); // 2 terminals -> cap 2
        seaDrop.setWL(holder, true);

        seaDrop.mintAllowList(address(token), holder, 2);
        vm.prank(holder);
        token.transferFrom(holder, other, 1);
        vm.prank(holder);
        token.transferFrom(holder, other, 2);

        (uint256 minted,,) = token.getMintStats(holder);
        assertEq(minted, 2); // counter survived the transfers
        assertEq(token.balanceOf(holder), 0);

        vm.expectRevert("AUDIT: wl cap exceeded");
        seaDrop.mintAllowList(address(token), holder, 1);
        console.log("S-2 SOUND: extra WL mints extractable via transfer+remint: 0");
    }

    // ---------------------------------------------------------------------
    // M-5: stage caps are lifetime-cumulative (canonical SeaDrop semantics).
    // Effective per-wallet cap = max(WL cap, public cap). A misconfigured
    // public cap voids WL scarcity.
    // ---------------------------------------------------------------------
    function testPOC_M5_StageCapInteraction() external {
        address whale = makeAddr("whale");       // 17 terminals
        address pub = makeAddr("publicUser");
        seaDrop.configure(17, 10);
        seaDrop.setWL(whale, true);

        // Whale takes the full WL entitlement...
        seaDrop.mintAllowList(address(token), whale, 17);
        // ...and is then LOCKED OUT of the public stage (17+1 > 10).
        vm.expectRevert("AUDIT: public cap exceeded");
        seaDrop.mintPublic(address(token), whale, 1);

        // Ordinary wallet: 10 public OK, 11th reverts.
        seaDrop.mintPublic(address(token), pub, 10);
        vm.expectRevert("AUDIT: public cap exceeded");
        seaDrop.mintPublic(address(token), pub, 1);

        // Footgun: owner sets public cap to 1000 (overlapping stages).
        // "WL 1:1 per terminal" becomes meaningless — anyone mints 100.
        seaDrop.configure(17, 1000);
        address degen = makeAddr("degen");
        seaDrop.mintPublic(address(token), degen, 100);
        assertEq(token.balanceOf(degen), 100);
        console.log("M-5: effective lifetime per-wallet cap = max(stage caps); public cap 1000 lets a non-WL wallet extract 100 seats");
    }

    // ---------------------------------------------------------------------
    // M-2: agent transfer desyncs onchain pairing from ownership. A naive
    // integrator reading agentToSeat alone licenses a seatless agent.
    // ---------------------------------------------------------------------
    function testPOC_M2_AgentTransferDesync() external {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), alice, 1);

        vm.prank(alice);
        uint256 agentA = registry.register();
        vm.prank(alice);
        token.pairSeat(1, agentA);

        // Alice sells the AGENT (ERC-8004 identities are transferable).
        // The seat does not move. Nothing onchain clears the pairing.
        vm.prank(alice);
        registry.transferAgent(bob, agentA);

        // Onchain state is now stale: mappings still claim A <-> seat 1.
        assertEq(token.seatToAgent(1), agentA);
        assertEq(token.agentToSeat(agentA), 1);
        // But ownership disagrees: Bob owns the agent, Alice owns the seat.
        assertEq(registry.ownerOf(agentA), bob);
        assertEq(token.ownerOf(1), alice);

        // THE TRAP: a naive job board checking only agentToSeat(agentA) != 0
        // would treat Bob's agent as a licensed worker. Bob owns no seat.
        bool naiveCheck = token.agentToSeat(agentA) != 0;
        bool correctCheck = token.ownerOf(token.agentToSeat(agentA)) == registry.ownerOf(agentA);
        assertTrue(naiveCheck);      // passes -> free license for Bob
        assertFalse(correctCheck);   // the required same-wallet check fails
        console.log("M-2: stale pairing lets a seatless agent pass the naive check; same-wallet check is load-bearing and entirely offchain");
    }

    // ---------------------------------------------------------------------
    // M-2b: clearStalePairing (added mid-audit, commit 0af1737) gives the
    // agent owner — who does NOT own the seat — a permissionless cleanup
    // for the M-2 desync. Verify: it clears, it can't be abused by the
    // seat owner as a free unpair, and it does NOT reset the 72h clock.
    // ---------------------------------------------------------------------
    function testPOC_M2b_ClearStalePairing() external {
        address alice = makeAddr("alice2");
        address bob = makeAddr("bob2");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), alice, 1);

        vm.prank(alice);
        uint256 agentA = registry.register();
        uint256 t0 = block.timestamp;
        vm.prank(alice);
        token.pairSeat(1, agentA);

        // Desync: Alice moves the agent to Bob.
        vm.prank(alice);
        registry.transferAgent(bob, agentA);
        assertEq(token.agentToSeat(agentA), 1); // stale

        // Bob (agent owner, not seat owner) clears it. Incentives align:
        // Bob must clear before he can pair this agent to his own seat.
        vm.prank(bob);
        token.clearStalePairing(agentA);
        assertEq(token.agentToSeat(agentA), 0);
        assertEq(token.seatToAgent(1), 0);

        // Abuse check 1: seat owner cannot use it as a free unpair while
        // they still own both sides.
        vm.prank(alice);
        uint256 agentA2 = registry.register();
        vm.warp(t0 + 72 hours); // let the original cooldown expire first
        vm.prank(alice);
        token.pairSeat(1, agentA2);
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.PairingNotStale.selector);
        token.clearStalePairing(agentA2);

        // Abuse check 2: a random third party cannot clear.
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(TracesLicenseSeaDrop.NotAgentOwner.selector);
        token.clearStalePairing(agentA2);

        // Abuse check 3: clearing does NOT reset the 72h pairing clock —
        // no rotation bypass via clear+repair.
        vm.prank(alice);
        registry.transferAgent(bob, agentA2); // desync again
        vm.prank(bob);
        token.clearStalePairing(agentA2);
        uint256 t1 = block.timestamp;
        vm.prank(alice);
        uint256 agentA3 = registry.register();
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.repairSeat(1, agentA3); // lastPairAt still t0+72h
        vm.warp(t1 + 72 hours);
        vm.prank(alice);
        token.repairSeat(1, agentA3); // honest path works after the window
        assertEq(token.seatToAgent(1), agentA3);
        console.log("M-2b: clearStalePairing closes the desync with aligned incentives; no cooldown bypass, no seat-owner abuse");
    }

    // ---------------------------------------------------------------------
    // S-3 (SOUND): pairSeat and repairSeat share one cooldown clock; no
    // fast path exists (repairSeat on a virgin seat == pairSeat).
    // ---------------------------------------------------------------------
    function testPOC_S3_NoFastPairPath() external {
        address user = makeAddr("user");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), user, 2); // tokenIds 1, 2

        uint256[3] memory agents;
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(user);
            agents[i] = registry.register();
        }

        // repairSeat on a never-paired seat works exactly like pairSeat...
        vm.prank(user);
        token.repairSeat(2, agents[0]);
        assertEq(token.seatToAgent(2), agents[0]);
        // ...and starts the same clock: immediate switch reverts.
        vm.prank(user);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.repairSeat(2, agents[1]);

        // pairSeat path: same clock, same revert.
        vm.prank(user);
        token.pairSeat(1, agents[1]);
        vm.prank(user);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.repairSeat(1, agents[2]);
        console.log("S-3 SOUND: pairSeat/repairSeat share one 72h clock; no fast-switch path");
    }

    // ---------------------------------------------------------------------
    // M-6 CLOSED: team allocation flows through SeaDrop — it is visible in
    // getMintStats and stage caps enforced on the cumulative total.
    // (Owner decision 2026-09-28: teamMint removed; team is a zero-price
    // allowlist stage on SeaDrop.)
    // ---------------------------------------------------------------------
    function testPOC_M6_TeamMintBypassesSeaDropCaps() external {
        address teamWallet = makeAddr("teamWallet");
        seaDrop.configure(0, 110);
        // Team's 100 flow through SeaDrop like everyone else.
        seaDrop.mintPublic(address(token), teamWallet, 100);

        (uint256 minted,,) = token.getMintStats(teamWallet);
        assertEq(minted, 100);                    // SeaDrop sees all 100...
        assertEq(token.balanceOf(teamWallet), 100);
        // ...and stage caps apply against the cumulative total.
        vm.expectRevert("AUDIT: public cap exceeded");
        seaDrop.mintPublic(address(token), teamWallet, 11); // 100 + 11 > 110
        console.log("M-6 CLOSED: team allocation is SeaDrop-visible; caps enforced on cumulative mints");
    }

    // ---------------------------------------------------------------------
    // M-7 (residual, no third-party vector): mid-job seat transfer bricks
    // the WORKER's own pairing — the seller internalizes the cost.
    // ---------------------------------------------------------------------
    function testPOC_M7_MidJobTransferSelfGrief() external {
        address worker = makeAddr("worker");
        address buyer = makeAddr("buyer");
        seaDrop.configure(0, 100);
        seaDrop.mintPublic(address(token), worker, 1);

        vm.prank(worker);
        uint256 agentW = registry.register();
        vm.prank(worker);
        token.pairSeat(1, agentW);
        // ...job assigned offchain to (seat 1, agentW)...

        // Worker sells the seat mid-job. Only the owner can do this.
        vm.prank(worker);
        token.transferFrom(worker, buyer, 1);

        // Pairing auto-cleared: the worker's agent is unlicensed, the
        // same-wallet payout check can no longer pass for the worker.
        assertEq(token.seatToAgent(1), 0);
        assertEq(token.agentToSeat(agentW), 0);
        // No third party could have triggered this: transfer requires
        // the seat owner's signature.
        console.log("M-7: mid-job transfer bricks the seller's own pairing; no third-party grief vector exists");
    }

    // ---------------------------------------------------------------------
    // M-3a(i) FIX-REGRESSION: the 10k supply ceiling is now HARD.
    // (Closed mid-audit by commit 0af1737: setMaxSupply above
    // MAX_SUPPLY_CEILING reverts MaxSupplyExceedsCeiling. The old
    // inflation PoC is retained here as a regression test proving the
    // attack now fails.)
    // ---------------------------------------------------------------------
    function testPOC_M3a_FIXREG_SupplyCeilingEnforced() external {
        // Attack: owner inflates the 10k cap to dilute all licenses.
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                TracesLicenseSeaDrop.MaxSupplyExceedsCeiling.selector,
                20_000,
                10_000
            )
        );
        token.setMaxSupply(20_000);
        assertEq(token.maxSupply(), 10_000);

        // Legitimate use (lowering the cap) still works.
        vm.prank(OWNER);
        token.setMaxSupply(9_000);
        assertEq(token.maxSupply(), 9_000);
        console.log("M-3a(i) FIXED: supply ceiling hard at 10k; owner can only lower");
    }

    // ---------------------------------------------------------------------
    // M-3a(ii): royalty diversion lever REMAINS (owner-mutable 5%).
    // ---------------------------------------------------------------------
    function testPOC_M3a_RoyaltyLeverRemains() external {
        address diverter = makeAddr("diverter");
        vm.prank(OWNER);
        token.setRoyaltyInfo(ERC2981.RoyaltyInfo({receiver: diverter, royaltyFraction: 1_000}));
        (address recv, uint256 amt) = token.royaltyInfo(1, 1 ether);
        assertEq(recv, diverter);
        assertEq(amt, 0.1 ether);
        console.log("M-3a(ii): royalty receiver/bps remain owner-mutable (5% is config, not rule)");
    }

    // ---------------------------------------------------------------------
    // M-3b: owner-allowlisted evil SeaDrop => unbounded free mint.
    // This AMPLIFIES owner-key compromise: without it the key can mint 100
    // team seats; with updateAllowedSeaDrop it can mint the whole supply.
    // ---------------------------------------------------------------------
    function testPOC_M3b_EvilSeaDropUnboundedMint() external {
        Audit2EvilSeaDrop evil = new Audit2EvilSeaDrop();
        address attacker = makeAddr("attacker");

        // Owner (or whoever holds the owner key) allowlists the evil drop.
        address[] memory allowed = new address[](1);
        allowed[0] = address(evil);
        vm.prank(OWNER);
        token.updateAllowedSeaDrop(allowed);

        // Attacker mints HALF THE SUPPLY for $0, no stages, no caps.
        evil.rug(address(token), attacker, 5_000);
        assertEq(token.balanceOf(attacker), 5_000);
        assertEq(token.nextTokenId(), 5_001);

        // Side effect: the legitimate drop is now bricked (old SeaDrop
        // no longer allowed).
        seaDrop.configure(0, type(uint256).max); // let the mock reach mintSeaDrop
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        seaDrop.mintPublic(address(token), attacker, 1);
        console.log("M-3b: allowlisted evil SeaDrop minted 5000 seats ($0); legitimate SeaDrop simultaneously bricked");
    }
}
