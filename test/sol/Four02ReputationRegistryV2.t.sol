// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {Four02ReputationRegistryV2} from "../../contracts/Four02ReputationRegistryV2.sol";
import {Four02ReputationRegistry} from "../../contracts/Four02ReputationRegistry.sol";

/// @notice Tests for Four02ReputationRegistryV2: enum encoding stability vs
///         V1, all ten event types, reliability math (value weighting, 365d
///         decay, WorkerGhosted penalty), dispute-rate math (ghost counts in
///         the numerator, never withdrawn), access control, and the 8004
///         read interface with the new "worker_ghosted" tag.
contract Four02ReputationRegistryV2Test is Test {
    Four02ReputationRegistryV2 internal reg;

    address internal owner = address(0xA11CE);
    address internal writer = address(0xBEEF);
    address internal writer2 = address(0xBEEF2);
    address internal stranger = address(0xCAFE);
    address internal counterparty = address(0xD00D);

    uint256 internal constant AGENT = 1628;
    uint256 internal constant HUNDRED_USDC = 100_000_000; // $100, 6 decimals

    event CommerceEventRecorded(
        uint256 indexed agentId,
        Four02ReputationRegistryV2.EventType indexed eventType,
        uint256 value,
        bytes32 indexed refId,
        address writer,
        address counterparty
    );
    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);
    event WeightsUpdated(uint256 onTimeWeightBps, uint256 lateWeightBps);
    event GhostPenaltyUpdated(uint256 ghostPenaltyUsdc);
    event DecayWindowUpdated(uint256 decayWindow);

    function setUp() public {
        reg = new Four02ReputationRegistryV2(owner);
        vm.prank(owner);
        reg.addWriter(writer);
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _record(
        uint256 agentId,
        Four02ReputationRegistryV2.EventType t,
        uint256 value,
        bytes32 refId
    ) internal {
        vm.prank(writer);
        reg.recordCommerceEvent(agentId, t, value, refId, counterparty);
    }

    function _recordAs(
        address w,
        uint256 agentId,
        Four02ReputationRegistryV2.EventType t,
        uint256 value,
        bytes32 refId
    ) internal {
        vm.prank(w);
        reg.recordCommerceEvent(agentId, t, value, refId, counterparty);
    }

    function _allTypes() internal pure returns (Four02ReputationRegistryV2.EventType[10] memory) {
        return [
            Four02ReputationRegistryV2.EventType.InvoicePaidOnTime,
            Four02ReputationRegistryV2.EventType.InvoicePaidLate,
            Four02ReputationRegistryV2.EventType.InvoiceUnpaid,
            Four02ReputationRegistryV2.EventType.EscrowCompleted,
            Four02ReputationRegistryV2.EventType.DisputeOpened,
            Four02ReputationRegistryV2.EventType.DisputeWithdrawn,
            Four02ReputationRegistryV2.EventType.DisputeResolved,
            Four02ReputationRegistryV2.EventType.ArbitrationWon,
            Four02ReputationRegistryV2.EventType.ArbitrationLost,
            Four02ReputationRegistryV2.EventType.WorkerGhosted
        ];
    }

    // ------------------------------------------------------------------------
    // Enum encoding stability (vs V1)
    // ------------------------------------------------------------------------

    function test_Enum_ExistingVariantsUnchanged() public {
        // V1 variant uint8 values, asserted against the ORIGINAL contract so a
        // future edit that shifts them fails here, not onchain.
        assertEq(uint8(Four02ReputationRegistry.EventType.InvoicePaidOnTime), 0);
        assertEq(uint8(Four02ReputationRegistry.EventType.InvoicePaidLate), 1);
        assertEq(uint8(Four02ReputationRegistry.EventType.InvoiceUnpaid), 2);
        assertEq(uint8(Four02ReputationRegistry.EventType.EscrowCompleted), 3);
        assertEq(uint8(Four02ReputationRegistry.EventType.DisputeOpened), 4);
        assertEq(uint8(Four02ReputationRegistry.EventType.DisputeWithdrawn), 5);
        assertEq(uint8(Four02ReputationRegistry.EventType.DisputeResolved), 6);
        assertEq(uint8(Four02ReputationRegistry.EventType.ArbitrationWon), 7);
        assertEq(uint8(Four02ReputationRegistry.EventType.ArbitrationLost), 8);

        assertEq(uint8(Four02ReputationRegistryV2.EventType.InvoicePaidOnTime), 0);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.InvoicePaidLate), 1);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.InvoiceUnpaid), 2);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.EscrowCompleted), 3);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.DisputeOpened), 4);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.DisputeWithdrawn), 5);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.DisputeResolved), 6);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.ArbitrationWon), 7);
        assertEq(uint8(Four02ReputationRegistryV2.EventType.ArbitrationLost), 8);
    }

    function test_Enum_WorkerGhostedIsLastVariant() public {
        assertEq(uint8(Four02ReputationRegistryV2.EventType.WorkerGhosted), 9);
    }

    // ------------------------------------------------------------------------
    // Every event type records correctly
    // ------------------------------------------------------------------------

    function test_AllEventTypesRecord() public {
        Four02ReputationRegistryV2.EventType[10] memory types = _allTypes();
        for (uint256 i; i < 10; i++) {
            _record(AGENT, types[i], HUNDRED_USDC, bytes32(i));
        }
        assertEq(reg.getEventCount(AGENT), 10);
        for (uint256 i; i < 10; i++) {
            (
                Four02ReputationRegistryV2.EventType t,
                uint256 value,
                ,
                bytes32 refId,
                address w,
                address cp
            ) = reg.events(AGENT, i);
            assertEq(uint8(t), i);
            assertEq(value, HUNDRED_USDC);
            assertEq(refId, bytes32(i));
            assertEq(w, writer);
            assertEq(cp, counterparty);
        }
    }

    function test_RecordEmitsCommerceEventRecorded() public {
        vm.expectEmit(true, true, true, true);
        emit CommerceEventRecorded(
            AGENT,
            Four02ReputationRegistryV2.EventType.WorkerGhosted,
            0,
            bytes32(uint256(7)),
            writer,
            counterparty
        );
        vm.prank(writer);
        reg.recordCommerceEvent(
            AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(7)), counterparty
        );
    }

    function test_RecordZeroAgentIdReverts() public {
        vm.prank(writer);
        vm.expectRevert(Four02ReputationRegistryV2.ZeroAgentId.selector);
        reg.recordCommerceEvent(
            0, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(0), counterparty
        );
    }

    // ------------------------------------------------------------------------
    // Writer allowlist (owner only)
    // ------------------------------------------------------------------------

    function test_NonWriterCannotRecord() public {
        vm.prank(stranger);
        vm.expectRevert(Four02ReputationRegistryV2.NotWriter.selector);
        reg.recordCommerceEvent(
            AGENT,
            Four02ReputationRegistryV2.EventType.InvoicePaidOnTime,
            HUNDRED_USDC,
            bytes32(0),
            counterparty
        );
    }

    function test_WriterAllowlistAddRemove() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit WriterAdded(writer2);
        reg.addWriter(writer2);
        assertTrue(reg.isWriter(writer2));

        _recordAs(
            writer2,
            AGENT,
            Four02ReputationRegistryV2.EventType.EscrowCompleted,
            0,
            bytes32(uint256(1))
        );
        assertEq(reg.getEventCount(AGENT), 1);

        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit WriterRemoved(writer2);
        reg.removeWriter(writer2);
        assertFalse(reg.isWriter(writer2));

        // revoked writer can no longer record (past events stay)
        vm.prank(writer2);
        vm.expectRevert(Four02ReputationRegistryV2.NotWriter.selector);
        reg.recordCommerceEvent(
            AGENT,
            Four02ReputationRegistryV2.EventType.EscrowCompleted,
            0,
            bytes32(uint256(2)),
            counterparty
        );
        assertEq(reg.getEventCount(AGENT), 1);
    }

    function test_OnlyOwnerManagesWriters() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        reg.addWriter(writer2);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        reg.removeWriter(writer);
    }

    function test_AddWriterZeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistryV2.ZeroAddress.selector);
        reg.addWriter(address(0));
    }

    function test_WriterAllowlistStartsEmpty() public {
        Four02ReputationRegistryV2 fresh = new Four02ReputationRegistryV2(owner);
        assertFalse(fresh.isWriter(writer));
    }

    // ------------------------------------------------------------------------
    // Reliability: value weighting
    // ------------------------------------------------------------------------

    function test_Reliability_AllOnTimeIs100() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 100);
    }

    function test_Reliability_LateIsHalfCredit() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidLate, HUNDRED_USDC, bytes32(uint256(2)));
        // good = 100*10000 + 100*5000 (bps), total = 200 -> 75
        assertEq(reg.reliability(AGENT), 75);
    }

    function test_Reliability_UnpaidDingsDenominatorOnly() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoiceUnpaid, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 50);
    }

    function test_Reliability_ZeroHistoryIsZero() public {
        assertEq(reg.reliability(AGENT), 0);
    }

    function test_Reliability_ValueWeighted() public {
        // $100 on time, $900 late: (100*100 + 900*50)/1000 = 55
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidLate, 9 * HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 55);
    }

    function test_Reliability_EscrowEventsDoNotFeed() public {
        // EscrowCompleted / disputes / arbitration are not invoice events.
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.ArbitrationWon, HUNDRED_USDC, bytes32(uint256(3)));
        assertEq(reg.reliability(AGENT), 0);
    }

    // ------------------------------------------------------------------------
    // Reliability: 365-day decay
    // ------------------------------------------------------------------------

    function test_Reliability_OldEventsDecayOut() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 100);
        vm.warp(block.timestamp + 365 days); // fully decayed
        assertEq(reg.reliability(AGENT), 0);
    }

    function test_Reliability_DecayWeightsByRecency() public {
        // On-time $100 recorded ~365 days ago (barely any weight left);
        // late $100 recorded now. The stale event should barely move the
        // score, so reliability sits near 50 (all-today math).
        uint256 base = block.timestamp + 400 days;
        vm.warp(base);
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        vm.warp(base + 365 days - 1);
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidLate, HUNDRED_USDC, bytes32(uint256(2)));
        uint256 r = reg.reliability(AGENT);
        // The ~365d-old event has weight 1 vs ~31536000 for today's: it
        // barely moves the score (49.99… truncates to 49).
        assertGe(r, 49);
        assertLe(r, 50);

        // And the decay applies to the denominator too: fully-decayed events
        // drop out entirely, leaving today's late $100 alone -> ~50.
        vm.warp(base + 365 days + 1);
        r = reg.reliability(AGENT);
        assertGe(r, 49);
        assertLe(r, 50);
    }

    function test_Reliability_GhostDecayOut() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 0); // ghost only, no credit
        // reliability stays 0 (nothing changes) but the penalty must decay:
        vm.warp(block.timestamp + 365 days);
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 100); // ghost fully decayed, no ding left
    }

    // ------------------------------------------------------------------------
    // WorkerGhosted in reliability
    // ------------------------------------------------------------------------

    function test_Ghost_DingsReliability() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        // one $100 ghost (default $100 penalty): good = 100, total = 200 -> 50
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 50);
    }

    function test_Ghost_AloneIsZeroReliability() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 0);
    }

    function test_Ghost_ValueIsIgnoredForReliability() public {
        // A writer that (incorrectly) passes a big value with WorkerGhosted
        // still dings by exactly the penalty, not the value: the escrow
        // records ghosts with value 0, and the penalty is the unit.
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 1_000_000_000_000, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 50);
    }

    function test_Ghost_MultipleGhostsStack() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(3)));
        // good = 100, total = 100 + 2*100 -> 33 (integer division)
        assertEq(reg.reliability(AGENT), 33);
    }

    // ------------------------------------------------------------------------
    // Ghost penalty tuning (owner only)
    // ------------------------------------------------------------------------

    function test_SetGhostPenalty_OwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        reg.setGhostPenalty(50_000_000);
    }

    function test_SetGhostPenalty_ZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistryV2.BadGhostPenalty.selector);
        reg.setGhostPenalty(0);
    }

    function test_SetGhostPenalty_TakesEffectImmediately() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 50);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit GhostPenaltyUpdated(300_000_000);
        reg.setGhostPenalty(300_000_000); // $300
        assertEq(reg.ghostPenaltyUsdc(), 300_000_000);
        // good = 100, total = 100 + 300 -> 25
        assertEq(reg.reliability(AGENT), 25);
    }

    // ------------------------------------------------------------------------
    // Dispute rate
    // ------------------------------------------------------------------------

    function test_DisputeRate_NoCompletedCommerceIsZero() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(1)));
        assertEq(reg.disputeRate(AGENT), 0);
    }

    function test_DisputeRate_OpenDispute() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(2)));
        assertEq(reg.disputeRate(AGENT), 10_000); // 1/1
    }

    function test_DisputeRate_WithdrawnDisputeDoesNotCount() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeWithdrawn, 0, bytes32(uint256(2)));
        assertEq(reg.disputeRate(AGENT), 0);
    }

    function test_DisputeRate_GhostCountsInNumerator() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        assertEq(reg.disputeRate(AGENT), 10_000); // a ghost IS a dispute signal
    }

    function test_DisputeRate_GhostNotWithdrawable() public {
        // A DisputeWithdrawn sharing the ghost's refId does NOT cancel the
        // ghost signal: no-shows are terminal, there is nothing to withdraw.
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeWithdrawn, 0, bytes32(uint256(2)));
        assertEq(reg.disputeRate(AGENT), 10_000);
    }

    function test_DisputeRate_GhostWithNoCompletedCommerceIsZero() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        assertEq(reg.disputeRate(AGENT), 0);
    }

    function test_DisputeRate_ResolvedDisputeDoesNotCount() public {
        // DisputeResolved alone (no DisputeOpened) is neutral — the resolved
        // path without an opening adds nothing to the numerator.
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeResolved, 0, bytes32(uint256(2)));
        assertEq(reg.disputeRate(AGENT), 0);
    }

    function test_DisputeRate_InvoicesCountAsCompleted() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidLate, HUNDRED_USDC, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(3)));
        assertEq(reg.disputeRate(AGENT), 5_000); // 1 dispute / 2 completed
    }

    function test_DisputeRate_GhostDecaysOut() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        assertEq(reg.disputeRate(AGENT), 10_000);
        vm.warp(block.timestamp + 365 days);
        assertEq(reg.disputeRate(AGENT), 0);
    }

    // ------------------------------------------------------------------------
    // Arbitration record
    // ------------------------------------------------------------------------

    function test_ArbitrationRecord_CountsNoDecay() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.ArbitrationWon, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.ArbitrationWon, HUNDRED_USDC, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.ArbitrationLost, HUNDRED_USDC, bytes32(uint256(3)));
        (uint256 wins, uint256 losses) = reg.arbitrationRecord(AGENT);
        assertEq(wins, 2);
        assertEq(losses, 1);

        vm.warp(block.timestamp + 400 days); // no decay on arbitration
        (wins, losses) = reg.arbitrationRecord(AGENT);
        assertEq(wins, 2);
        assertEq(losses, 1);
    }

    function test_Ghost_DoesNotTouchArbitration() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        (uint256 wins, uint256 losses) = reg.arbitrationRecord(AGENT);
        assertEq(wins, 0);
        assertEq(losses, 0);
    }

    // ------------------------------------------------------------------------
    // summary()
    // ------------------------------------------------------------------------

    function test_Summary_CombinesViews() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.ArbitrationWon, HUNDRED_USDC, bytes32(uint256(3)));

        Four02ReputationRegistryV2.AgentSummary memory s = reg.summary(AGENT);
        assertEq(s.reliability, 50);
        assertEq(s.disputeRateBps, 10_000);
        assertEq(s.arbitrationWins, 1);
        assertEq(s.arbitrationLosses, 0);
        assertEq(s.totalEvents, 3);
        assertEq(s.lastEventTimestamp, uint64(block.timestamp));
    }

    function test_Summary_EmptyAgent() public {
        Four02ReputationRegistryV2.AgentSummary memory s = reg.summary(AGENT);
        assertEq(s.reliability, 0);
        assertEq(s.disputeRateBps, 0);
        assertEq(s.totalEvents, 0);
        assertEq(s.lastEventTimestamp, 0);
    }

    // ------------------------------------------------------------------------
    // Weight / decay tuning (V1 behavior preserved)
    // ------------------------------------------------------------------------

    function test_SetWeights_RetunesReliability() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidLate, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 75);

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit WeightsUpdated(10_000, 0);
        reg.setWeights(10_000, 0);
        assertEq(reg.reliability(AGENT), 50); // late now worth nothing
    }

    function test_SetWeights_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        reg.setWeights(10_000, 5_000);
    }

    function test_SetWeights_BadWeightReverts() public {
        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistryV2.BadWeight.selector);
        reg.setWeights(10_001, 5_000);
    }

    function test_SetDecayWindow_OwnerOnlyAndValidated() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit DecayWindowUpdated(30 days);
        reg.setDecayWindow(30 days);
        assertEq(reg.decayWindow(), 30 days);

        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistryV2.BadDecayWindow.selector);
        reg.setDecayWindow(0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        reg.setDecayWindow(7 days);
    }

    // ------------------------------------------------------------------------
    // ERC-8004 read interface (V1 behavior preserved + new tag)
    // ------------------------------------------------------------------------

    function test_8004_GetClientsAndLastIndex() public {
        vm.prank(owner);
        reg.addWriter(writer2);
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        _recordAs(writer2, AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(2)));

        address[] memory clients = reg.getClients(AGENT);
        assertEq(clients.length, 2);
        assertEq(reg.getLastIndex(AGENT, writer), 1);
        assertEq(reg.getLastIndex(AGENT, writer2), 1);
    }

    function test_8004_ReadFeedback_GhostTag() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));

        (int128 value, uint8 decimals, string memory tag1, string memory tag2, bool revoked) =
            reg.readFeedback(AGENT, writer, 1);
        assertEq(value, 0);
        assertEq(decimals, 6);
        assertEq(tag1, "worker_ghosted");
        assertEq(tag2, "402:commerce");
        assertFalse(revoked);

        // index 0 and out-of-range revert
        vm.expectRevert(Four02ReputationRegistryV2.FeedbackIndexOutOfBounds.selector);
        reg.readFeedback(AGENT, writer, 0);
        vm.expectRevert(Four02ReputationRegistryV2.FeedbackIndexOutOfBounds.selector);
        reg.readFeedback(AGENT, writer, 2);
    }

    function test_8004_GetSummary_TagFilterGhost() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.EscrowCompleted, HUNDRED_USDC, bytes32(uint256(2)));

        address[] memory clients = new address[](1);
        clients[0] = writer;
        (uint64 count, int128 avg, uint8 dec) = reg.getSummary(AGENT, clients, "worker_ghosted", "");
        assertEq(count, 1);
        assertEq(avg, 0);
        assertEq(dec, 6);

        (count,,) = reg.getSummary(AGENT, clients, "dispute_opened", "");
        assertEq(count, 0);

        // empty client list reverts like the reference implementation
        vm.expectRevert(Four02ReputationRegistryV2.EmptyClientList.selector);
        reg.getSummary(AGENT, new address[](0), "", "");
    }

    function test_8004_ReadAllFeedback_TagFilter() public {
        _record(AGENT, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistryV2.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(2)));

        (
            address[] memory clients,
            uint64[] memory idx,
            int128[] memory values,
            uint8[] memory decimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revoked
        ) = reg.readAllFeedback(AGENT, new address[](0), "worker_ghosted", "", false);
        assertEq(clients.length, 1);
        assertEq(clients[0], writer);
        assertEq(idx[0], 1);
        assertEq(values[0], 0);
        assertEq(decimals[0], 6);
        assertEq(tag1s[0], "worker_ghosted");
        assertEq(tag2s[0], "402:commerce");
        assertFalse(revoked[0]);
    }

    function test_8004_StaticReads() public {
        assertEq(reg.getResponseCount(AGENT, writer, 1, new address[](0)), 0);
        assertEq(reg.getIdentityRegistry(), address(0));
        assertEq(reg.getVersion(), "1.0.0");
    }
}
