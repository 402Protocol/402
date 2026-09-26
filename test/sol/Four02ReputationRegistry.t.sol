// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {Four02ReputationRegistry} from "../../contracts/Four02ReputationRegistry.sol";

/// @notice Tests for Four02ReputationRegistry: gated writes, append-only log,
///         derived scores (reliability, dispute rate, arbitration), decay,
///         weight retuning, and the preserved ERC-8004 read interface.
contract Four02ReputationRegistryTest is Test {
    Four02ReputationRegistry internal reg;

    address internal owner = address(0xA11CE);
    address internal writer = address(0xBEEF);
    address internal writer2 = address(0xBEEF2);
    address internal stranger = address(0xCAFE);
    address internal counterparty = address(0xD00D);

    uint256 internal constant AGENT = 1628;
    uint256 internal constant HUNDRED_USDC = 100_000_000; // $100, 6 decimals

    event CommerceEventRecorded(
        uint256 indexed agentId,
        Four02ReputationRegistry.EventType indexed eventType,
        uint256 value,
        bytes32 indexed refId,
        address writer,
        address counterparty
    );
    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);
    event WeightsUpdated(uint256 onTimeWeightBps, uint256 lateWeightBps);
    event DecayWindowUpdated(uint256 decayWindow);

    function setUp() public {
        reg = new Four02ReputationRegistry(owner);
        vm.prank(owner);
        reg.addWriter(writer);
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _record(
        uint256 agentId,
        Four02ReputationRegistry.EventType t,
        uint256 value,
        bytes32 refId
    ) internal {
        vm.prank(writer);
        reg.recordCommerceEvent(agentId, t, value, refId, counterparty);
    }

    function _recordAs(
        address w,
        uint256 agentId,
        Four02ReputationRegistry.EventType t,
        uint256 value,
        bytes32 refId
    ) internal {
        vm.prank(w);
        reg.recordCommerceEvent(agentId, t, value, refId, counterparty);
    }

    // ------------------------------------------------------------------------
    // Writer gating
    // ------------------------------------------------------------------------

    function test_NonWriterCannotRecord() public {
        vm.prank(stranger);
        vm.expectRevert(Four02ReputationRegistry.NotWriter.selector);
        reg.recordCommerceEvent(
            AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(0), counterparty
        );
    }

    function test_WriterAllowlistAddRemove() public {
        // addWriter emits and authorizes
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit WriterAdded(writer2);
        reg.addWriter(writer2);
        assertTrue(reg.isWriter(writer2));

        // new writer can record
        _recordAs(writer2, AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(uint256(1)));
        assertEq(reg.getEventCount(AGENT), 1);

        // removeWriter emits and revokes
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit WriterRemoved(writer2);
        reg.removeWriter(writer2);
        assertFalse(reg.isWriter(writer2));

        // revoked writer can no longer record (past events stay)
        vm.prank(writer2);
        vm.expectRevert(Four02ReputationRegistry.NotWriter.selector);
        reg.recordCommerceEvent(
            AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(uint256(2)), counterparty
        );
        assertEq(reg.getEventCount(AGENT), 1);
    }

    function test_OnlyOwnerManagesWriters() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger)
        );
        reg.addWriter(writer2);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger)
        );
        reg.removeWriter(writer);
    }

    function test_AddWriterZeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistry.ZeroAddress.selector);
        reg.addWriter(address(0));
    }

    function test_RecordZeroAgentIdReverts() public {
        vm.prank(writer);
        vm.expectRevert(Four02ReputationRegistry.ZeroAgentId.selector);
        reg.recordCommerceEvent(
            0, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(0), counterparty
        );
    }

    // ------------------------------------------------------------------------
    // Append-only log
    // ------------------------------------------------------------------------

    function test_RecordAppendsAndEmits() public {
        bytes32 refId = keccak256("invoice-1");
        vm.expectEmit(true, true, true, true);
        emit CommerceEventRecorded(
            AGENT,
            Four02ReputationRegistry.EventType.InvoicePaidOnTime,
            HUNDRED_USDC,
            refId,
            writer,
            counterparty
        );
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, refId);

        assertEq(reg.getEventCount(AGENT), 1);
        (
            Four02ReputationRegistry.EventType t,
            uint256 value,
            uint64 timestamp,
            bytes32 gotRef,
            address gotWriter,
            address gotCounterparty
        ) = reg.events(AGENT, 0);
        assertEq(uint8(t), uint8(Four02ReputationRegistry.EventType.InvoicePaidOnTime));
        assertEq(value, HUNDRED_USDC);
        assertEq(timestamp, block.timestamp);
        assertEq(gotRef, refId);
        assertEq(gotWriter, writer);
        assertEq(gotCounterparty, counterparty);

        // second event appends (index 1), first untouched
        _record(AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(uint256(7)));
        assertEq(reg.getEventCount(AGENT), 2);
        (Four02ReputationRegistry.EventType t0,,,,,) = reg.events(AGENT, 0);
        assertEq(uint8(t0), uint8(Four02ReputationRegistry.EventType.InvoicePaidOnTime));
    }

    // ------------------------------------------------------------------------
    // Reliability
    // ------------------------------------------------------------------------

    function test_ReliabilityOnTimePlusUnpaidIsFifty() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.InvoiceUnpaid, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 50);
    }

    function test_ReliabilityAllOnTimeIsHundred() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 100);
    }

    function test_ReliabilityAllUnpaidIsZero() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoiceUnpaid, HUNDRED_USDC, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 0);
    }

    function test_ReliabilityNoHistoryIsZero() public {
        assertEq(reg.reliability(AGENT), 0);
    }

    function test_LatePaymentGetsPartialCredit() public {
        // default late weight is 50%: $100 late only -> 50
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidLate, HUNDRED_USDC, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 50);

        // $100 on-time + $100 late -> (100 + 50) / 200 = 75
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 75);
    }

    function test_ReliabilityIsValueWeighted() public {
        // $900 on-time vs $100 unpaid -> 90
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, 900_000_000, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.InvoiceUnpaid, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 90);
    }

    // ------------------------------------------------------------------------
    // Time decay
    // ------------------------------------------------------------------------

    function test_TimeDecayFadesScoreButNotHistory() public {
        // old sin: $100 unpaid at t0
        _record(AGENT, Four02ReputationRegistry.EventType.InvoiceUnpaid, HUNDRED_USDC, bytes32(uint256(1)));

        // half a window later a $100 on-time payment lands: the fresh good
        // event now outweighs the half-decayed bad one -> 100/(100+50) = 66,
        // not the undecayed 50.
        vm.warp(block.timestamp + 182 days + 12 hours);
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(2)));
        assertEq(reg.reliability(AGENT), 66);

        // past the window the headline score is 0, raw log intact
        vm.warp(block.timestamp + 400 days);
        assertEq(reg.reliability(AGENT), 0);
        assertEq(reg.getEventCount(AGENT), 2);

        // a fresh event after the warp scores fully again
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(3)));
        assertEq(reg.reliability(AGENT), 100);
    }

    function test_DecayWindowRetunable() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit DecayWindowUpdated(30 days);
        reg.setDecayWindow(30 days);

        vm.warp(block.timestamp + 31 days);
        assertEq(reg.reliability(AGENT), 0);
        assertEq(reg.getEventCount(AGENT), 1);
    }

    function test_DecayWindowZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistry.BadDecayWindow.selector);
        reg.setDecayWindow(0);
    }

    // ------------------------------------------------------------------------
    // Dispute rate
    // ------------------------------------------------------------------------

    function test_DisputeRate() public {
        for (uint256 i = 1; i <= 10; i++) {
            _record(AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(i));
        }
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, bytes32("dispute-a"));
        // 1 dispute / 10 completed = 1000 bps = 10%
        assertEq(reg.disputeRate(AGENT), 1000);
    }

    function test_DisputeRateNoCommerceIsZero() public {
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, bytes32("dispute-a"));
        assertEq(reg.disputeRate(AGENT), 0); // no completed commerce -> 0, not div-by-zero
    }

    function test_WithdrawnDisputeIsNeutral() public {
        for (uint256 i = 1; i <= 10; i++) {
            _record(AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(i));
        }
        bytes32 refId = bytes32("dispute-a");
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, refId);
        assertEq(reg.disputeRate(AGENT), 1000);

        // withdrawn: neutral on the score...
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeWithdrawn, 0, refId);
        assertEq(reg.disputeRate(AGENT), 0);

        // ...but both events stay in the raw log
        assertEq(reg.getEventCount(AGENT), 12);
    }

    function test_ResolvedDisputeStillCounts() public {
        _record(AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(uint256(1)));
        bytes32 refId = bytes32("dispute-a");
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, refId);
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeResolved, 0, refId);
        // resolved != withdrawn: the dispute happened
        assertEq(reg.disputeRate(AGENT), 10_000);
    }

    function test_DisputeRateDecays() public {
        _record(AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, bytes32("dispute-a"));
        assertEq(reg.disputeRate(AGENT), 10_000);

        vm.warp(block.timestamp + 400 days);
        assertEq(reg.disputeRate(AGENT), 0);
    }

    // ------------------------------------------------------------------------
    // Arbitration
    // ------------------------------------------------------------------------

    function test_ArbitrationRecord() public {
        _record(AGENT, Four02ReputationRegistry.EventType.ArbitrationWon, 0, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.ArbitrationWon, 0, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistry.EventType.ArbitrationLost, 0, bytes32(uint256(3)));
        (uint256 wins, uint256 losses) = reg.arbitrationRecord(AGENT);
        assertEq(wins, 2);
        assertEq(losses, 1);
    }

    function test_ArbitrationRecordEmpty() public {
        (uint256 wins, uint256 losses) = reg.arbitrationRecord(AGENT);
        assertEq(wins, 0);
        assertEq(losses, 0);
    }

    // ------------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------------

    function test_Summary() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.InvoiceUnpaid, HUNDRED_USDC, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistry.EventType.ArbitrationWon, 0, bytes32(uint256(3)));

        Four02ReputationRegistry.AgentSummary memory s = reg.summary(AGENT);
        assertEq(s.reliability, 50);
        assertEq(s.disputeRateBps, 0); // no completed commerce besides invoices paid... see below
        assertEq(s.arbitrationWins, 1);
        assertEq(s.arbitrationLosses, 0);
        assertEq(s.totalEvents, 3);
        assertEq(s.lastEventTimestamp, block.timestamp);
    }

    function test_SummaryEmpty() public view {
        Four02ReputationRegistry.AgentSummary memory s = reg.summary(AGENT);
        assertEq(s.reliability, 0);
        assertEq(s.disputeRateBps, 0);
        assertEq(s.arbitrationWins, 0);
        assertEq(s.arbitrationLosses, 0);
        assertEq(s.totalEvents, 0);
        assertEq(s.lastEventTimestamp, 0);
    }

    // ------------------------------------------------------------------------
    // Weight retuning (no migration)
    // ------------------------------------------------------------------------

    function test_WeightRetuningChangesScoresWithNoNewEvents() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidLate, HUNDRED_USDC, bytes32(uint256(1)));
        assertEq(reg.reliability(AGENT), 50); // 50% late credit by default

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit WeightsUpdated(10_000, 10_000);
        reg.setWeights(10_000, 10_000);

        assertEq(reg.getEventCount(AGENT), 1); // no new events...
        assertEq(reg.reliability(AGENT), 100); // ...but the score changed

        vm.prank(owner);
        reg.setWeights(10_000, 0); // late = no credit
        assertEq(reg.reliability(AGENT), 0);
    }

    function test_BadWeightsRevert() public {
        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistry.BadWeight.selector);
        reg.setWeights(10_001, 5_000);

        vm.prank(owner);
        vm.expectRevert(Four02ReputationRegistry.BadWeight.selector);
        reg.setWeights(10_000, 10_001);
    }

    function test_OnlyOwnerTunesWeights() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger)
        );
        reg.setWeights(10_000, 10_000);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger)
        );
        reg.setDecayWindow(30 days);
    }

    // ------------------------------------------------------------------------
    // ERC-8004 read interface
    // ------------------------------------------------------------------------

    function test_ReadInterfaceShapes() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidLate, 50_000_000, bytes32(uint256(2)));
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, bytes32("d1"));

        address[] memory clients = new address[](1);
        clients[0] = writer;

        // getLastIndex
        assertEq(reg.getLastIndex(AGENT, writer), 3);
        assertEq(reg.getLastIndex(AGENT, stranger), 0);

        // readFeedback: (value, valueDecimals, tag1, tag2, isRevoked)
        (int128 v, uint8 vd, string memory t1, string memory t2, bool revoked) =
            reg.readFeedback(AGENT, writer, 1);
        assertEq(v, int128(int256(HUNDRED_USDC)));
        assertEq(vd, 6);
        assertEq(t1, "invoice_paid_on_time");
        assertEq(t2, "402:commerce");
        assertFalse(revoked);

        (int128 v3,,,,) = reg.readFeedback(AGENT, writer, 3);
        assertEq(v3, 0);

        // out-of-bounds reverts (0 and > lastIndex, like the reference)
        vm.expectRevert(Four02ReputationRegistry.FeedbackIndexOutOfBounds.selector);
        reg.readFeedback(AGENT, writer, 0);
        vm.expectRevert(Four02ReputationRegistry.FeedbackIndexOutOfBounds.selector);
        reg.readFeedback(AGENT, writer, 4);

        // getSummary: average of tag-matching values
        (uint64 count, int128 sumVal, uint8 sumDec) =
            reg.getSummary(AGENT, clients, "invoice_paid_on_time", "");
        assertEq(count, 1);
        assertEq(sumVal, int128(int256(HUNDRED_USDC)));
        assertEq(sumDec, 6);

        // empty tag1/tag2 = all of this writer's events: avg of (100M, 50M, 0)
        (uint64 countAll, int128 avgAll,) = reg.getSummary(AGENT, clients, "", "");
        assertEq(countAll, 3);
        assertEq(avgAll, int128(int256((HUNDRED_USDC + 50_000_000) / 3)));

        // empty client list reverts, like the reference
        vm.expectRevert(Four02ReputationRegistry.EmptyClientList.selector);
        reg.getSummary(AGENT, new address[](0), "", "");

        // readAllFeedback: 7-array shape
        (
            address[] memory rClients,
            uint64[] memory rIndexes,
            int128[] memory rValues,
            uint8[] memory rDecimals,
            string[] memory rTag1s,
            string[] memory rTag2s,
            bool[] memory rRevoked
        ) = reg.readAllFeedback(AGENT, clients, "", "", false);
        assertEq(rClients.length, 3);
        assertEq(rClients[0], writer);
        assertEq(rIndexes[0], 1);
        assertEq(rIndexes[2], 3);
        assertEq(rValues[1], int128(int256(50_000_000)));
        assertEq(rDecimals[0], 6);
        assertEq(rTag1s[2], "dispute_opened");
        assertEq(rTag2s[0], "402:commerce");
        assertFalse(rRevoked[0]);

        // empty client list reads all writers
        vm.prank(owner);
        reg.addWriter(writer2);
        _recordAs(writer2, AGENT, Four02ReputationRegistry.EventType.EscrowCompleted, 0, bytes32(uint256(9)));
        (address[] memory allClients,,,,,,) =
            reg.readAllFeedback(AGENT, new address[](0), "", "", true);
        assertEq(allClients.length, 4);

        // getResponseCount: always 0 (no responses in the commerce model)
        assertEq(reg.getResponseCount(AGENT, writer, 1, clients), 0);

        // getClients: writers for the agent
        address[] memory writers = reg.getClients(AGENT);
        assertEq(writers.length, 2);
        assertEq(writers[0], writer);
        assertEq(writers[1], writer2);

        // getIdentityRegistry: address(0) by design
        assertEq(reg.getIdentityRegistry(), address(0));

        // getVersion
        assertEq(reg.getVersion(), "1.0.0");
    }

    function test_ReadInterfaceTagFiltering() public {
        _record(AGENT, Four02ReputationRegistry.EventType.InvoicePaidOnTime, HUNDRED_USDC, bytes32(uint256(1)));
        _record(AGENT, Four02ReputationRegistry.EventType.DisputeOpened, 0, bytes32("d1"));

        address[] memory clients = new address[](1);
        clients[0] = writer;

        // tag1 filter that matches nothing
        (uint64 count,,) = reg.getSummary(AGENT, clients, "escrow_completed", "");
        assertEq(count, 0);

        (address[] memory rClients,,,,,,) =
            reg.readAllFeedback(AGENT, clients, "dispute_opened", "", false);
        assertEq(rClients.length, 1);

        // tag2 filter on the 402 namespace matches everything
        (uint64 countNs,,) = reg.getSummary(AGENT, clients, "", "402:commerce");
        assertEq(countNs, 2);
    }
}
