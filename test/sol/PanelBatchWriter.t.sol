// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {Four02ReputationRegistryV2} from "../../contracts/Four02ReputationRegistryV2.sol";
import {PanelBatchWriter} from "../../contracts/PanelBatchWriter.sol";

/// @notice Integration tests for PanelBatchWriter against the real
///         Four02ReputationRegistryV2 (not a mock).
contract PanelBatchWriterTest is Test {
    Four02ReputationRegistryV2 internal registry;
    PanelBatchWriter internal writer;

    address internal owner = address(0xA11CE);
    address internal keeper = address(0xBEEF);
    address internal stranger = address(0xDEAD);

    // 2026-09-29T12:00:00Z — warped in setUp so the ±2d freshness window
    // accepts epoch day 20260929.
    uint256 internal constant NOW = 1790683200;
    uint256 internal constant EPOCH = 20260929000; // 2026-09-29, chunk 0

    function setUp() public {
        vm.warp(NOW);
        registry = new Four02ReputationRegistryV2(owner);
        writer = new PanelBatchWriter(address(registry), keeper, owner);
        // Owner allowlists the writer on the registry (the real onboarding step).
        vm.prank(owner);
        registry.addWriter(address(writer));
    }

    function _hash(
        uint256[] memory ids,
        uint256[] memory bps
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(ids, bps));
    }

    function _one(uint256 id, uint256 bps_) internal pure returns (uint256[] memory ids, uint256[] memory bps) {
        ids = new uint256[](1);
        bps = new uint256[](1);
        ids[0] = id;
        bps[0] = bps_;
    }

    // ------------------------------------------------------------------------
    // Constructor / admin
    // ------------------------------------------------------------------------

    function test_constructor_rejectsZeroRegistry() public {
        vm.expectRevert(PanelBatchWriter.ZeroAddress.selector);
        new PanelBatchWriter(address(0), keeper, owner);
    }

    function test_constructor_rejectsZeroKeeper() public {
        vm.expectRevert(PanelBatchWriter.ZeroAddress.selector);
        new PanelBatchWriter(address(registry), address(0), owner);
    }

    function test_renounceOwnership_reverts() public {
        vm.prank(owner);
        vm.expectRevert(PanelBatchWriter.RenounceDisabled.selector);
        writer.renounceOwnership();
        // Ownership is intact.
        assertEq(writer.owner(), owner);
    }

    // ------------------------------------------------------------------------
    // Two-step keeper rotation
    // ------------------------------------------------------------------------

    function test_proposeKeeper_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        writer.proposeKeeper(stranger);

        vm.prank(owner);
        writer.proposeKeeper(stranger);
        assertEq(writer.pendingKeeper(), stranger);
        // Not effective until accepted.
        assertEq(writer.keeper(), keeper);
    }

    function test_proposeKeeper_rejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(PanelBatchWriter.ZeroAddress.selector);
        writer.proposeKeeper(address(0));
    }

    function test_acceptKeeper_onlyProposed() public {
        vm.prank(owner);
        writer.proposeKeeper(stranger);

        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.NotProposedKeeper.selector);
        writer.acceptKeeper();

        vm.prank(stranger);
        writer.acceptKeeper();
        assertEq(writer.keeper(), stranger);
        assertEq(writer.pendingKeeper(), address(0));
    }

    function test_acceptKeeper_revertsWithNoProposal() public {
        vm.prank(stranger);
        vm.expectRevert(PanelBatchWriter.NotProposedKeeper.selector);
        writer.acceptKeeper();
    }

    function test_proposeKeeper_overwritesPending() public {
        vm.prank(owner);
        writer.proposeKeeper(stranger);
        address other = address(0xCAFE);
        vm.prank(owner);
        writer.proposeKeeper(other);
        assertEq(writer.pendingKeeper(), other);

        // The first nominee can no longer accept.
        vm.prank(stranger);
        vm.expectRevert(PanelBatchWriter.NotProposedKeeper.selector);
        writer.acceptKeeper();
    }

    function test_submitBatch_revertsForOldKeeperAfterRotation() public {
        vm.prank(owner);
        writer.proposeKeeper(stranger);
        vm.prank(stranger);
        writer.acceptKeeper();

        (uint256[] memory ids, uint256[] memory bps) = _one(7, 10_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.NotKeeper.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));

        // The new keeper works.
        vm.prank(stranger);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
        assertTrue(writer.epochSubmitted(EPOCH));
    }

    // ------------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------------

    function test_submitBatch_revertsForNonKeeper() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 10_000);
        vm.prank(stranger);
        vm.expectRevert(PanelBatchWriter.NotKeeper.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    // ------------------------------------------------------------------------
    // Epoch freshness window (±2 days of block.timestamp)
    // ------------------------------------------------------------------------

    function test_submitBatch_acceptsEpochWithinWindow() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        // -2d, -1d, today, +1d, +2d all pass.
        uint256[5] memory dayList = [
            uint256(20260927000),
            uint256(20260928000),
            uint256(20260929000),
            uint256(20260930000),
            uint256(20261001000)
        ];
        for (uint256 i = 0; i < dayList.length; i++) {
            (uint256[] memory ids2, uint256[] memory bps2) = _one(7 + i, 8_000);
            vm.prank(keeper);
            writer.submitBatch(dayList[i], ids2, bps2, _hash(ids2, bps2));
            assertTrue(writer.epochSubmitted(dayList[i]));
        }
    }

    function test_submitBatch_rejectsEpochTooOld() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.EpochOutOfWindow.selector);
        writer.submitBatch(20260926000, ids, bps, _hash(ids, bps)); // -3d
    }

    function test_submitBatch_rejectsEpochTooNew() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.EpochOutOfWindow.selector);
        writer.submitBatch(20261002000, ids, bps, _hash(ids, bps)); // +3d
    }

    function test_submitBatch_rejectsMalformedEpochDay() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.EpochOutOfWindow.selector);
        writer.submitBatch(20261345000, ids, bps, _hash(ids, bps)); // month 13
    }

    function test_submitBatch_rejectsImpossibleDate() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.EpochOutOfWindow.selector);
        writer.submitBatch(20260230000, ids, bps, _hash(ids, bps)); // Feb 30
    }

    function test_submitBatch_windowFollowsWarp() public {
        // A week later, today's epoch is stale.
        vm.warp(NOW + 7 days);
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.EpochOutOfWindow.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    // ------------------------------------------------------------------------
    // Happy path: exact recordCommerceEvent args + batchHash commitment
    // ------------------------------------------------------------------------

    function test_submitBatch_recordsExactArgs() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 42;
        ids[1] = 1337;
        uint256[] memory bps = new uint256[](2);
        bps[0] = 9_500;
        bps[1] = 10_000;

        vm.prank(keeper);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));

        assertTrue(writer.epochSubmitted(EPOCH));
        assertEq(registry.getEventCount(42), 1);
        assertEq(registry.getEventCount(1337), 1);

        (
            Four02ReputationRegistryV2.EventType t0,
            uint256 v0,
            ,
            bytes32 ref0,
            address writer0,
            address cp0
        ) = registry.events(42, 0);
        assertEq(
            uint256(t0),
            uint256(Four02ReputationRegistryV2.EventType.EscrowCompleted)
        );
        assertEq(v0, 9_500); // agreement bps, NOT usdc
        assertEq(
            ref0,
            keccak256(abi.encodePacked("402:panel-review/v1", EPOCH, uint256(42)))
        );
        assertEq(writer0, address(writer));
        assertEq(cp0, address(0));

        (, uint256 v1, , , , ) = registry.events(1337, 0);
        assertEq(v1, 10_000);
    }

    function test_submitBatch_emitsBatchSubmittedWithHash() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        bytes32 h = _hash(ids, bps);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit PanelBatchWriter.BatchSubmitted(EPOCH, 1, h);
        writer.submitBatch(EPOCH, ids, bps, h);
    }

    function test_submitBatch_rejectsBatchHashMismatch() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.BatchHashMismatch.selector);
        writer.submitBatch(EPOCH, ids, bps, bytes32(uint256(1)));
    }

    function test_batchHash_matchesTypeScriptKeeper() public {
        // Cross-language pin: the TS keeper computes
        // keccak256(abi.encode(agentIds, agreementBps)) via viem's
        // encodeAbiParameters. This must equal the Solidity-side value or
        // every real batch reverts with BatchHashMismatch.
        uint256[] memory ids = new uint256[](2);
        ids[0] = 7;
        ids[1] = 9;
        uint256[] memory bps = new uint256[](2);
        bps[0] = 8_000;
        bps[1] = 10_000;
        assertEq(
            keccak256(abi.encode(ids, bps)),
            0xba02fb79c00e05ab3511be728de7c028e3aa8510ed894d2c98efa60e74b58f45,
            "TS keeper's pinned hash must match the contract's encoding"
        );
        // And the contract accepts it.
        vm.prank(keeper);
        writer.submitBatch(
            EPOCH,
            ids,
            bps,
            0xba02fb79c00e05ab3511be728de7c028e3aa8510ed894d2c98efa60e74b58f45
        );
        assertTrue(writer.epochSubmitted(EPOCH));
    }

    // ------------------------------------------------------------------------
    // Replay / validation guards
    // ------------------------------------------------------------------------

    function test_submitBatch_rejectsEpochReplay() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);

        vm.prank(keeper);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));

        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.EpochAlreadySubmitted.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_allowsDifferentChunksSameDay() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);

        vm.prank(keeper);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps)); // chunk 0

        (uint256[] memory ids2, uint256[] memory bps2) = _one(8, 8_000);
        vm.prank(keeper);
        writer.submitBatch(EPOCH + 1, ids2, bps2, _hash(ids2, bps2)); // chunk 1, same day
        assertEq(registry.getEventCount(8), 1);
    }

    function test_submitBatch_rejectsZeroEpoch() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.InvalidEpochId.selector);
        writer.submitBatch(0, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_rejectsLengthMismatch() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 7;
        ids[1] = 8;
        uint256[] memory bps = new uint256[](1);
        bps[0] = 8_000;
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.LengthMismatch.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_rejectsEmptyBatch() public {
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.BatchSizeInvalid.selector);
        writer.submitBatch(EPOCH, new uint256[](0), new uint256[](0), bytes32(0));
    }

    function test_submitBatch_rejectsOversizeBatch() public {
        uint256 n = writer.MAX_BATCH() + 1; // 71
        uint256[] memory ids = new uint256[](n);
        uint256[] memory bps = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = i + 1;
            bps[i] = 10_000;
        }
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.BatchSizeInvalid.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_acceptsMaxBatch() public {
        assertEq(writer.MAX_BATCH(), 70);
        uint256 n = 70;
        uint256[] memory ids = new uint256[](n);
        uint256[] memory bps = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = i + 1;
            bps[i] = 10_000;
        }
        vm.prank(keeper);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
        assertEq(registry.getEventCount(70), 1);
    }

    function test_submitBatch_rejectsZeroAgentId() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(0, 8_000);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.ZeroAgentId.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_rejectsDuplicateAgentIds() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 7;
        ids[1] = 7; // duplicate
        uint256[] memory bps = new uint256[](2);
        bps[0] = 8_000;
        bps[1] = 9_000;
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.AgentIdsNotSorted.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_rejectsUnsortedAgentIds() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 9;
        ids[1] = 7; // descending
        uint256[] memory bps = new uint256[](2);
        bps[0] = 8_000;
        bps[1] = 9_000;
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.AgentIdsNotSorted.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    function test_submitBatch_rejectsBpsOver10000() public {
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 10_001);
        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.ScoreOutOfRange.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
    }

    // ------------------------------------------------------------------------
    // Atomicity: one bad entry reverts the whole batch, epoch stays open
    // ------------------------------------------------------------------------

    function test_submitBatch_noPartialWrites() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 7;
        ids[1] = 7; // duplicate in the middle
        ids[2] = 9;
        uint256[] memory bps = new uint256[](3);
        bps[0] = 8_000;
        bps[1] = 8_000;
        bps[2] = 8_000;

        vm.prank(keeper);
        vm.expectRevert(PanelBatchWriter.AgentIdsNotSorted.selector);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));

        // Nothing was written, and the epoch is still submittable.
        assertEq(registry.getEventCount(7), 0);
        assertEq(registry.getEventCount(9), 0);
        assertFalse(writer.epochSubmitted(EPOCH));

        ids[1] = 8;
        vm.prank(keeper);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
        assertEq(registry.getEventCount(7), 1);
        assertEq(registry.getEventCount(8), 1);
        assertEq(registry.getEventCount(9), 1);
    }

    // ------------------------------------------------------------------------
    // Score-math isolation: panel events must not move reliability
    // ------------------------------------------------------------------------

    function test_panelEvents_doNotAffectReliability() public {
        // reliability() with no invoice/ghost history is 0; EscrowCompleted
        // events (the panel carrier) must not change that.
        (uint256[] memory ids, uint256[] memory bps) = _one(7, 10_000);
        vm.prank(keeper);
        writer.submitBatch(EPOCH, ids, bps, _hash(ids, bps));
        assertEq(registry.reliability(7), 0);
        // …and a perfect panel score does not conjure a dispute rate either.
        assertEq(registry.disputeRate(7), 0);
    }
}
