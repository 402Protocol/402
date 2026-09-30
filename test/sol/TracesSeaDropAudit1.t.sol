// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicenseSeaDrop} from "../../contracts/TracesLicenseSeaDrop.sol";
import {INonFungibleSeaDropToken} from "../../contracts/seadrop/INonFungibleSeaDropToken.sol";
import {ISeaDropTokenContractMetadata} from "../../contracts/seadrop/ISeaDropTokenContractMetadata.sol";
import {ITransferValidator} from "@creator-token-standards/interfaces/ITransferValidator.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Registry stand-in with controllable ownership (for squat PoC).
contract AuditRegistry {
    mapping(uint256 => address) public owners;
    uint256 public nextId = 1;

    function register() external returns (uint256 id) {
        id = nextId++;
        owners[id] = msg.sender;
    }

    function setOwner(uint256 id, address who) external {
        owners[id] = who;
    }

    function ownerOf(uint256 id) external view returns (address) {
        address o = owners[id];
        require(o != address(0), "no agent");
        return o;
    }
}

/// @notice Minimal SeaDrop stand-in: forwards mint calls.
contract AuditSeaDrop {
    function mintAs(address token, address to, uint256 qty) external {
        INonFungibleSeaDropToken(token).mintSeaDrop(to, qty);
    }
}

/// @notice Receiver that tries to reenter mintSeaDrop on the token callback,
///         catching the revert so the outer mint completes. Proves the
///         reentrant mint is blocked while the legitimate mint succeeds.
contract ReentrantReceiver is IERC721Receiver {
    AuditSeaDrop public immutable seaDrop;
    address public immutable token;
    uint256 public callbacks;
    uint256 public blockedReentries;

    constructor(AuditSeaDrop sd, address t) {
        seaDrop = sd;
        token = t;
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        callbacks++;
        if (callbacks == 1) {
            try seaDrop.mintAs(token, address(this), 1) {
                // must never succeed
            } catch {
                blockedReentries++;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice Receiver that reenters via a SECOND allowed SeaDrop impl
///         (the exact scenario the SeaDrop interface NatSpec warns about).
contract CrossImplReentrantReceiver is IERC721Receiver {
    AuditSeaDrop public immutable otherSeaDrop;
    address public immutable token;
    uint256 public callbacks;
    uint256 public blockedReentries;

    constructor(AuditSeaDrop other, address t) {
        otherSeaDrop = other;
        token = t;
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        callbacks++;
        if (callbacks == 1) {
            try otherSeaDrop.mintAs(token, address(this), 1) {
                // must never succeed
            } catch {
                blockedReentries++;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice Transfer validator that bricks every transfer.
contract BrickValidator is ITransferValidator {
    function applyCollectionTransferPolicy(address, address, address)
        external
        pure
        override
    {
        revert("bricked");
    }

    function validateTransfer(address, address, address) external pure override {
        revert("bricked");
    }

    function validateTransfer(address, address, address, uint256)
        external
        pure
        override
    {
        revert("bricked");
    }

    function validateTransfer(address, address, address, uint256, uint256)
        external
        pure
        override
    {
        revert("bricked");
    }

    function beforeAuthorizedTransfer(address, address, uint256) external override {}
    function afterAuthorizedTransfer(address, uint256) external override {}
    function beforeAuthorizedTransfer(address, address) external override {}
    function afterAuthorizedTransfer(address) external override {}
    function beforeAuthorizedTransfer(address, uint256) external override {}
    function beforeAuthorizedTransferWithAmount(address, uint256, uint256) external override {}
    function afterAuthorizedTransferWithAmount(address, uint256) external override {}
}

/// @title TracesSeaDropAudit1 — adversarial PoCs
/// @notice Each test is either a FAILED exploit (documents a blocked attack)
///         or a SUCCESSFUL behavior demonstration (documents an owner-power /
///         design tradeoff). Findings are numbered to match the audit report.
contract TracesSeaDropAudit1Test is Test {
    TracesLicenseSeaDrop token;
    AuditRegistry registry;
    AuditSeaDrop seaDrop;
    address owner = address(0xA11CE);
    address treasury = address(0xBEEF);
    address alice = address(0xA11A);
    address bob = address(0xB0B);
    address attacker = address(0xBAD);

    string constant BASE = "ipfs://base/";

    function setUp() external {
        registry = new AuditRegistry();
        seaDrop = new AuditSeaDrop();
        address[] memory allowed = new address[](1);
        allowed[0] = address(seaDrop);
        token = new TracesLicenseSeaDrop(
            owner,
            address(registry),
            allowed,
            BASE,
            treasury,
            500
        );
    }

    function _mint(address to, uint256 qty) internal {
        seaDrop.mintAs(address(token), to, qty);
    }

    function _pair(address who, uint256 tid) internal returns (uint256 aid) {
        vm.prank(who);
        aid = registry.register();
        vm.prank(who);
        token.pairSeat(tid, aid);
    }

    // ------------------------------------------------------------------
    // A1. mintSeaDrop access control — FAILED exploit
    // ------------------------------------------------------------------
    function test_A1_nonSeaDropCannotMint() external {
        vm.prank(attacker);
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        token.mintSeaDrop(attacker, 1);
        // Even the OWNER cannot call it directly.
        vm.prank(owner);
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        token.mintSeaDrop(attacker, 1);
        assertEq(token.totalSupply(), 0);
    }

    // ------------------------------------------------------------------
    // A2. Reentrancy via _safeMint callback — FAILED exploit
    // ------------------------------------------------------------------
    function test_A2_reentrantMintBlocked() external {
        ReentrantReceiver rcvr = new ReentrantReceiver(seaDrop, address(token));
        // Outer mint completes; the reentrant inner mint is blocked by the
        // guard. Attacker ends with exactly 1 token, not 2.
        seaDrop.mintAs(address(token), address(rcvr), 1);
        assertEq(rcvr.callbacks(), 1, "callback ran");
        assertEq(rcvr.blockedReentries(), 1, "reentry was blocked");
        assertEq(token.balanceOf(address(rcvr)), 1);
        assertEq(token.totalSupply(), 1);
        assertEq(token.nextTokenId(), 2, "no ID skipped or double-issued");
        (uint256 minted,,) = token.getMintStats(address(rcvr));
        assertEq(minted, 1, "accounting counts the real mint once");
    }

    // ------------------------------------------------------------------
    // A3. Cross-SeaDrop-impl reentrancy (the interface NatSpec scenario)
    //      — FAILED exploit
    // ------------------------------------------------------------------
    function test_A3_crossImplReentrantMintBlocked() external {
        AuditSeaDrop seaDropB = new AuditSeaDrop();
        address[] memory allowed = new address[](2);
        allowed[0] = address(seaDrop);
        allowed[1] = address(seaDropB);
        vm.prank(owner);
        token.updateAllowedSeaDrop(allowed);

        CrossImplReentrantReceiver rcvr =
            new CrossImplReentrantReceiver(seaDropB, address(token));
        seaDrop.mintAs(address(token), address(rcvr), 1);
        assertEq(rcvr.callbacks(), 1);
        assertEq(rcvr.blockedReentries(), 1, "cross-impl reentry blocked");
        assertEq(token.totalSupply(), 1);
    }

    // ------------------------------------------------------------------
    // A4. Supply cap enforcement — teamMint removed (owner decision
    // 2026-09-28): team allocation is now a zero-price allowlist stage on
    // SeaDrop. The contract has no owner mint path; only SeaDrop mints,
    // and it enforces the cap.
    // ------------------------------------------------------------------
    function test_A4_cannotExceedMaxSupply() external {
        vm.prank(owner);
        token.setMaxSupply(3);
        _mint(alice, 3);
        vm.expectRevert(
            abi.encodeWithSelector(
                TracesLicenseSeaDrop.MintQuantityExceedsMaxSupply.selector, 4, 3
            )
        );
        _mint(alice, 1);
        assertEq(token.totalSupply(), 3);
    }

    // ------------------------------------------------------------------
    // A5. Zero-quantity mint — FAILED exploit
    // ------------------------------------------------------------------
    function test_A5_zeroQuantityReverts() external {
        vm.expectRevert(TracesLicenseSeaDrop.EmptyBatch.selector);
        seaDrop.mintAs(address(token), alice, 0);
    }

    // ------------------------------------------------------------------
    // A6. Rotation attack pair -> transfer -> pair, same block
    //      — FAILED exploit (the prior audit's H-1, now fixed)
    // ------------------------------------------------------------------
    function test_A6_rotationAttackBlockedSameBlock() external {
        _mint(alice, 1);
        uint256 aid = _pair(alice, 1);
        // Alice sells; pairing auto-clears.
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(token.seatToAgent(1), 0);
        assertEq(token.agentToSeat(aid), 0);
        // Bob tries to pair in the SAME block -> cooldown blocks it.
        vm.prank(bob);
        uint256 bobAid = registry.register();
        vm.prank(bob);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(1, bobAid);
        // After 72h the legitimate buyer pairs fine.
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(bob);
        token.pairSeat(1, bobAid);
        assertEq(token.seatToAgent(1), bobAid);
    }

    // ------------------------------------------------------------------
    // A7. Self-transfer rotation variant — FAILED exploit
    // ------------------------------------------------------------------
    function test_A7_selfTransferDoesNotResetCooldown() external {
        _mint(alice, 1);
        _pair(alice, 1);
        // Self-transfer clears the pairing but NOT the cooldown clock.
        vm.prank(alice);
        token.transferFrom(alice, alice, 1);
        assertEq(token.seatToAgent(1), 0);
        vm.prank(alice);
        uint256 aid2 = registry.register();
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(1, aid2);
    }

    // ------------------------------------------------------------------
    // A8. Double-pairing (both directions) — FAILED exploits
    // ------------------------------------------------------------------
    function test_A8_doublePairingBlocked() external {
        _mint(alice, 2);
        uint256 aid = _pair(alice, 1);
        // Same seat, second agent.
        vm.prank(alice);
        uint256 aid2 = registry.register();
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.SeatAlreadyPaired.selector);
        token.pairSeat(1, aid2);
        // Same agent, second seat.
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.AgentAlreadyPaired.selector);
        token.pairSeat(2, aid);
    }

    // ------------------------------------------------------------------
    // A9. Pair to someone else's agent — FAILED exploit
    // ------------------------------------------------------------------
    function test_A9_cannotPairOthersAgent() external {
        _mint(alice, 1);
        vm.prank(bob);
        uint256 bobAid = registry.register();
        vm.prank(alice);
        vm.expectRevert(
            TracesLicenseSeaDrop.IdentityNotOwnedByRecipient.selector
        );
        token.pairSeat(1, bobAid);
    }

    // ------------------------------------------------------------------
    // A10. Non-owner cannot pair — FAILED exploit
    // ------------------------------------------------------------------
    function test_A10_nonOwnerCannotPair() external {
        _mint(alice, 1);
        vm.prank(bob);
        uint256 bobAid = registry.register();
        vm.prank(bob);
        vm.expectRevert(TracesLicenseSeaDrop.NotSeatOwner.selector);
        token.pairSeat(1, bobAid);
    }

    // ------------------------------------------------------------------
    // A11. Auto-clear on EVERY transfer path — verified
    // ------------------------------------------------------------------
    function test_A11_autoClearAllTransferPaths() external {
        _mint(alice, 3);
        _pair(alice, 1);
        _pair(alice, 2);
        _pair(alice, 3);
        vm.startPrank(alice);
        token.transferFrom(alice, bob, 1);
        token.safeTransferFrom(alice, bob, 2);
        token.safeTransferFrom(alice, bob, 3, "data");
        vm.stopPrank();
        assertEq(token.seatToAgent(1), 0);
        assertEq(token.seatToAgent(2), 0);
        assertEq(token.seatToAgent(3), 0);
    }

    // ------------------------------------------------------------------
    // A12. Codeless validator cannot brick transfers on Ink — verified
    // ------------------------------------------------------------------
    function test_A12_defaultValidatorDoesNotBrick() external {
        // Default validator has no code on Ink -> transfers unrestricted.
        assertEq(
            token.getTransferValidator(),
            0x721C008fdff27BF06E7E123956E2Fe03B63342e3
        );
        _mint(alice, 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, 1); // succeeds
        assertEq(token.ownerOf(1), bob);
    }

    // ------------------------------------------------------------------
    // A13. setTransferValidator rejects codeless non-zero — verified
    // ------------------------------------------------------------------
    function test_A13_codelessValidatorRejected() external {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSignature("ERC721CCompat__InvalidTransferValidatorContract()")
        );
        token.setTransferValidator(address(0xDEAD));
    }

    // ------------------------------------------------------------------
    // B1. Owner adds an EOA to the allowlist -> EOA mints for free,
    //     bypassing SeaDrop economics entirely — WORKS (Low)
    // ------------------------------------------------------------------
    function test_B1_eoaInAllowlistBypassesSeaDrop() external {
        address[] memory allowed = new address[](2);
        allowed[0] = address(seaDrop);
        allowed[1] = attacker; // EOA, no code check performed
        vm.prank(owner);
        token.updateAllowedSeaDrop(allowed);
        // Attacker EOA mints directly: no SeaDrop, no payment, no caps.
        vm.prank(attacker);
        token.mintSeaDrop(attacker, 5);
        assertEq(token.balanceOf(attacker), 5);
    }

    // ------------------------------------------------------------------
    // B2. Owner raises maxSupply past 10k -> dilution — WORKS (Medium)
    // ------------------------------------------------------------------
    function test_B2_ownerCanRaiseMaxSupply() external {
        // FIXED (owner decision 2026-09-28): hard 10,000 ceiling.
        // Raising past the ceiling reverts; the PoC's 1,000,000 raise
        // no longer works.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                TracesLicenseSeaDrop.MaxSupplyExceedsCeiling.selector,
                1_000_000,
                10_000
            )
        );
        token.setMaxSupply(1_000_000);
        // Lowering still works and enforcement follows the current cap.
        vm.prank(owner);
        token.setMaxSupply(3);
        _mint(alice, 3);
        vm.prank(address(seaDrop));
        vm.expectRevert();
        token.mintSeaDrop(alice, 1);
        assertEq(token.totalSupply(), 3);
    }

    // ------------------------------------------------------------------
    // B3. Malicious validator set by owner bricks transfers — WORKS (Low)
    // ------------------------------------------------------------------
    function test_B3_ownerValidatorCanBrickTransfers() external {
        BrickValidator brick = new BrickValidator();
        vm.prank(owner);
        token.setTransferValidator(address(brick));
        _mint(alice, 1);
        vm.prank(alice);
        vm.expectRevert("bricked");
        token.transferFrom(alice, bob, 1);
        // Owner can unbrick by disabling.
        vm.prank(owner);
        token.setTransferValidator(address(0));
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(token.ownerOf(1), bob);
    }

    // ------------------------------------------------------------------
    // B4. Cooldown inheritance: buyer waits out seller's clock — (Info)
    // ------------------------------------------------------------------
    function test_B4_buyerInheritsRemainingCooldown() external {
        _mint(alice, 1);
        _pair(alice, 1);
        vm.warp(block.timestamp + 71 hours); // seller holds 71h, then sells
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        vm.prank(bob);
        uint256 bobAid = registry.register();
        vm.prank(bob);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(1, bobAid); // 1h of cooldown remains -> blocked
        vm.warp(block.timestamp + 61 minutes);
        vm.prank(bob);
        token.pairSeat(1, bobAid); // now clear
        assertEq(token.seatToAgent(1), bobAid);
    }

    // ------------------------------------------------------------------
    // B5. Stale agentToSeat after the 8004 AGENT (not the seat) transfers
    //     bricks that agent's future pairing — WORKS (Low).
    //     Seat-side transfers self-heal via auto-clear; the agent side has
    //     no permissionless unpair path.
    // ------------------------------------------------------------------
    function test_B5_staleAgentPairingBricksAgent() external {
        // Attacker pairs their own seat to their own agent (legit so far).
        _mint(attacker, 1); // token 1
        vm.prank(attacker);
        uint256 aid = registry.register();
        vm.prank(attacker);
        token.pairSeat(1, aid);
        // Attacker transfers the 8004 AGENT (not the seat) to the victim.
        // (setOwner models the ERC-721 transfer on the 8004 registry.)
        registry.setOwner(aid, bob);
        // Bob now owns agent aid AND seat 2, and wants to license the agent.
        _mint(bob, 1); // token 2
        vm.prank(bob);
        vm.expectRevert(TracesLicenseSeaDrop.AgentAlreadyPaired.selector);
        token.pairSeat(2, aid);
        // The stale mapping still points at the attacker's seat; only the
        // seat-1 owner (the attacker) can clear it via repairSeat/transfer.
        assertEq(token.agentToSeat(aid), 1);
        assertEq(token.seatToAgent(1), aid);
    }

    // ------------------------------------------------------------------
    // C1. getMintStats is cumulative across transfers — verified SAFE
    // ------------------------------------------------------------------
    function test_C1_mintStatsSurviveTransfers() external {
        _mint(alice, 4);
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, 2);
        (uint256 minted, uint256 total, uint256 max) = token.getMintStats(alice);
        assertEq(minted, 4, "cumulative, not balance");
        assertEq(token.balanceOf(alice), 2);
        assertEq(total, 4);
        assertEq(max, 10_000);
    }

    // ------------------------------------------------------------------
    // C2. repairSeat to same agent is a no-op revert — verified
    // ------------------------------------------------------------------
    function test_C2_repairSameAgentReverts() external {
        _mint(alice, 1);
        uint256 aid = _pair(alice, 1);
        vm.warp(block.timestamp + 73 hours);
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.NoPairingChange.selector);
        token.repairSeat(1, aid);
    }

    // ------------------------------------------------------------------
    // C3. repairSeat clears the OLD agent mapping — verified
    // ------------------------------------------------------------------
    function test_C3_repairClearsOldAgent() external {
        _mint(alice, 1);
        uint256 oldAid = _pair(alice, 1);
        vm.prank(alice);
        uint256 newAid = registry.register();
        vm.warp(block.timestamp + 73 hours);
        vm.prank(alice);
        token.repairSeat(1, newAid);
        assertEq(token.agentToSeat(oldAid), 0);
        assertEq(token.seatToAgent(1), newAid);
        assertEq(token.agentToSeat(newAid), 1);
    }

    // ------------------------------------------------------------------
    // C4. RoyaltyInfo adaptation preserves the canonical SeaDrop selector —
    //     the struct relocation (interface -> ERC2981) does not change the
    //     ERC-165 interface ID, since only canonical types count.
    // ------------------------------------------------------------------
    function test_C4_royaltyInfoSelectorIsCanonical() external pure {
        bytes4 canonical = bytes4(keccak256("setRoyaltyInfo((address,uint96))"));
        assertEq(
            ISeaDropTokenContractMetadata.setRoyaltyInfo.selector,
            canonical
        );
        assertTrue(
            type(ISeaDropTokenContractMetadata).interfaceId != bytes4(0)
        );
        assertTrue(
            type(INonFungibleSeaDropToken).interfaceId != bytes4(0)
        );
    }
}
