// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BountyEscrow, IIdentityRegistry} from "../../contracts/BountyEscrow.sol";
import {Four02ReputationRegistryV2} from "../../contracts/Four02ReputationRegistryV2.sol";

/// @notice Minimal mock USDC (6 decimals, mintable) for local testing.
contract MockUSDC2 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "mUSDC: allowance");
        unchecked {
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "mUSDC: balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
    }
}

/// @notice Mock ERC-8004 identity registry: ownerOf is a test-controlled map.
contract MockIdentityRegistry2 is IIdentityRegistry {
    mapping(uint256 => address) internal owners;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view override returns (address) {
        return owners[agentId];
    }
}

/// @notice Hostile reputation registry: recordCommerceEvent burns ~2.2M gas
/// WITHOUT reverting. try/catch cannot catch out-of-gas — without a gas
/// stipend on the escrow side, this OOGs the entire release()/refund()/
/// resolveDispute() transaction and locks every in-flight bounty.
contract GasBurningRegistry {
    mapping(uint256 => uint256) public burnSlots;

    function recordCommerceEvent(
        uint256,
        Four02ReputationRegistryV2.EventType,
        uint256,
        bytes32,
        address
    ) external {
        // Fresh (cold) storage slot per iteration: ~22k gas each, ~2.2M
        // total — far above the escrow's REP_WRITE_GAS stipend, far below
        // any block limit. The subcall must exhaust the stipend and be
        // caught; the outer payout must proceed.
        for (uint256 i = 0; i < 100; i++) {
            burnSlots[i] = uint256(keccak256(abi.encode(i, block.timestamp)));
        }
    }
}

/// @notice Hostile reputation registry: reenters escrow.raiseDispute from
/// inside recordCommerceEvent, mid-dispute.
contract ReentrantRepRegistry {
    BountyEscrow internal escrow;
    uint256 internal otherJob;

    function setEscrow(BountyEscrow e) external {
        escrow = e;
    }

    function setOtherJob(uint256 jobId) external {
        otherJob = jobId;
    }

    function recordCommerceEvent(
        uint256,
        Four02ReputationRegistryV2.EventType,
        uint256,
        bytes32,
        address
    ) external {
        escrow.raiseDispute(otherJob);
    }
}

/// @notice Fresh adversarial-audit tests for the second-pass fixes:
/// H4 rotation capture, reputation-call gas griefing, fee-math overflow,
/// stray-transfer sweep, refundDelay bounds, refId namespacing, and the
/// writer allowlist contract check.
contract BountyEscrowAudit2Test is Test {
    MockUSDC2 internal usdc;
    MockIdentityRegistry2 internal identityRegistry;
    Four02ReputationRegistryV2 internal repRegistry;
    BountyEscrow internal escrow;

    address internal payer = makeAddr("payer");
    address internal worker = makeAddr("worker");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AGENT_ID = 42;
    uint256 internal constant FEE_BPS = 75;
    uint64 internal constant REFUND_DELAY = 1 days;
    uint256 internal constant JOB_AMOUNT = 100_000_000; // 100 USDC

    event ReputationSkipped(
        uint256 indexed jobId, uint256 indexed agentId, Four02ReputationRegistryV2.EventType eventType
    );
    event ExcessSwept(address indexed to, uint256 amount);

    function setUp() public {
        usdc = new MockUSDC2();
        identityRegistry = new MockIdentityRegistry2();
        repRegistry = new Four02ReputationRegistryV2(address(this));
        escrow = new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            address(repRegistry),
            0, 0, 0
        );
        repRegistry.addWriter(address(escrow));
        identityRegistry.setOwner(AGENT_ID, worker);
        usdc.mint(payer, 10_000_000_000);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // -- helpers -------------------------------------------------------------

    function _openBounty() internal returns (uint256 jobId) {
        vm.prank(payer);
        jobId = escrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("spec"));
    }

    function _fundedBounty() internal returns (uint256 jobId) {
        jobId = _openBounty();
        vm.prank(worker);
        escrow.claimBounty(jobId, AGENT_ID);
    }

    function _deliveredBounty() internal returns (uint256 jobId) {
        jobId = _fundedBounty();
        vm.prank(worker);
        escrow.confirmDelivery(jobId);
    }

    function _eventRefId(uint256 agentId, uint256 idx) internal view returns (bytes32) {
        (,,, bytes32 refId,,) = repRegistry.events(agentId, idx);
        return refId;
    }

    function _eventType(uint256 agentId, uint256 idx)
        internal
        view
        returns (Four02ReputationRegistryV2.EventType)
    {
        (Four02ReputationRegistryV2.EventType t,,,,,) = repRegistry.events(agentId, idx);
        return t;
    }

    function _deployEscrow(address repReg, uint64 refundDelay) internal returns (BountyEscrow e) {
        e = new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            refundDelay,
            guardian,
            address(identityRegistry),
            repReg,
            0, 0, 0
        );
        vm.prank(payer);
        usdc.approve(address(e), type(uint256).max);
    }

    // -- H4-fix: rotation capture ---------------------------------------------

    function test_Rotation_ArbiterCannotOverwriteGuardianProposal() public {
        // The attack: the incumbent arbiter key is compromised. The guardian
        // proposes a safe replacement; the attacker re-proposes their own
        // address to restart the 14-day clock forever, making removal
        // impossible while they keep resolving disputes maliciously.
        address safeArbiter = makeAddr("safeArbiter");
        address evilArbiter = makeAddr("evilArbiter");

        vm.prank(guardian);
        escrow.proposeRotation(safeArbiter);
        assertEq(escrow.pendingProposer(), guardian);

        // The compromised arbiter's overwrite is rejected...
        vm.prank(arbiter);
        vm.expectRevert(BountyEscrow.RotationLocked.selector);
        escrow.proposeRotation(evilArbiter);

        // ...even 13 days later, one day before the timelock would elapse.
        vm.warp(block.timestamp + 13 days);
        vm.prank(arbiter);
        vm.expectRevert(BountyEscrow.RotationLocked.selector);
        escrow.proposeRotation(evilArbiter);
        assertEq(escrow.pendingArbiter(), safeArbiter);

        // The guardian's rotation confirms on schedule; the attacker is out.
        vm.warp(block.timestamp + 2 days);
        vm.prank(stranger); // permissionless finalization
        escrow.confirmRotation();
        assertEq(escrow.arbiter(), safeArbiter);
        assertEq(escrow.pendingProposer(), address(0));
    }

    function test_Rotation_ArbiterCannotCancelGuardianProposal() public {
        address safeArbiter = makeAddr("safeArbiter");
        vm.prank(guardian);
        escrow.proposeRotation(safeArbiter);

        // The incumbent cannot cancel their own removal.
        vm.prank(arbiter);
        vm.expectRevert(BountyEscrow.NotProposer.selector);
        escrow.cancelRotation();
        assertEq(escrow.pendingArbiter(), safeArbiter);

        // The guardian can still cancel their own proposal.
        vm.prank(guardian);
        escrow.cancelRotation();
        assertEq(escrow.pendingArbiter(), address(0));
        assertEq(escrow.pendingProposer(), address(0));
    }

    function test_Rotation_ArbiterCanReplaceOwnProposal() public {
        // Legit case preserved: the arbiter rotates to a new multisig and
        // corrects the target before the timelock elapses.
        address first = makeAddr("first");
        address second = makeAddr("second");
        vm.prank(arbiter);
        escrow.proposeRotation(first);
        vm.prank(arbiter);
        escrow.proposeRotation(second); // overwrite own proposal: allowed
        assertEq(escrow.pendingArbiter(), second);
        assertEq(escrow.pendingProposer(), arbiter);

        // ...and can cancel their own proposal.
        vm.prank(arbiter);
        escrow.cancelRotation();
        assertEq(escrow.pendingArbiter(), address(0));
    }

    function test_Rotation_GuardianOverridesArbiterProposal() public {
        // The guardian outranks: even if the (compromised) arbiter proposed
        // first, the guardian's proposal takes over and becomes immune.
        address evilArbiter = makeAddr("evilArbiter");
        address safeArbiter = makeAddr("safeArbiter");
        vm.prank(arbiter);
        escrow.proposeRotation(evilArbiter);
        vm.prank(guardian);
        escrow.proposeRotation(safeArbiter);
        assertEq(escrow.pendingArbiter(), safeArbiter);
        assertEq(escrow.pendingProposer(), guardian);

        vm.prank(arbiter);
        vm.expectRevert(BountyEscrow.RotationLocked.selector);
        escrow.proposeRotation(evilArbiter);
    }

    // -- gas-griefing registry --------------------------------------------------

    function test_RepWrite_GasBurningRegistryCannotBrickRelease() public {
        // The registry burns ~2.5M gas without reverting. The escrow's
        // stipend (REP_WRITE_GAS) contains it: the write is skipped, the
        // payout proceeds untouched.
        GasBurningRegistry burner = new GasBurningRegistry();
        BountyEscrow burnEscrow = _deployEscrow(address(burner), REFUND_DELAY);

        vm.prank(payer);
        uint256 jobId = burnEscrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("s"));
        vm.prank(worker);
        burnEscrow.claimBounty(jobId, AGENT_ID);
        vm.prank(worker);
        burnEscrow.confirmDelivery(jobId);

        vm.expectEmit(true, true, false, true);
        emit ReputationSkipped(jobId, AGENT_ID, Four02ReputationRegistryV2.EventType.EscrowCompleted);
        vm.prank(payer);
        burnEscrow.release(jobId); // must NOT run out of gas

        assertEq(burnEscrow.claimable(jobId, worker), 99_250_000);
        assertEq(burnEscrow.claimable(jobId, feeRecipient), 750_000);
        vm.prank(worker);
        burnEscrow.claim(jobId);
        assertEq(usdc.balanceOf(worker), 99_250_000);
    }

    function test_RepWrite_GasBurningRegistryCannotBrickRefund() public {
        // Ghost path: three registry writes (none here — refund records one
        // WorkerGhosted) must not brick the payer's refund either.
        GasBurningRegistry burner = new GasBurningRegistry();
        BountyEscrow burnEscrow = _deployEscrow(address(burner), REFUND_DELAY);

        vm.prank(payer);
        uint256 jobId = burnEscrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("s"));
        vm.prank(worker);
        burnEscrow.claimBounty(jobId, AGENT_ID);
        uint64 deadline = burnEscrow.getJob(jobId).deadline;
        vm.warp(deadline + REFUND_DELAY + 1);

        vm.expectEmit(true, true, false, true);
        emit ReputationSkipped(jobId, AGENT_ID, Four02ReputationRegistryV2.EventType.WorkerGhosted);
        vm.prank(stranger);
        burnEscrow.refund(jobId); // must NOT run out of gas
        assertEq(burnEscrow.claimable(jobId, payer), JOB_AMOUNT);
        vm.prank(payer);
        burnEscrow.claim(jobId);
        assertEq(usdc.balanceOf(payer), 10_000_000_000);
    }

    function test_RepWrite_LegitWriteFitsUnderStipend() public {
        // Guard against the stipend being set too tight: a real registry
        // write (cold path, ~287k gas) must succeed, not skip.
        uint256 jobId = _deliveredBounty();
        vm.prank(payer);
        escrow.release(jobId);
        assertEq(repRegistry.getEventCount(AGENT_ID), 1); // recorded, not skipped
        assertEq(uint8(_eventType(AGENT_ID, 0)), uint8(Four02ReputationRegistryV2.EventType.EscrowCompleted));
    }

    function test_RaiseDispute_ReentrantRegistryFailsClosed() public {
        // The registry reenters raiseDispute on a second job from inside
        // recordCommerceEvent. The reentrant call dies on the guard, the
        // try/catch swallows it, and the outer dispute is unaffected.
        ReentrantRepRegistry evil = new ReentrantRepRegistry();
        BountyEscrow evilEscrow = new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            address(evil),
            0, 0, 0
        );
        evil.setEscrow(evilEscrow);
        vm.prank(payer);
        usdc.approve(address(evilEscrow), type(uint256).max);

        vm.prank(payer);
        uint256 job1 = evilEscrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("a"));
        vm.prank(payer);
        uint256 job2 = evilEscrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("b"));
        vm.prank(worker);
        evilEscrow.claimBounty(job1, AGENT_ID);
        vm.prank(worker);
        evilEscrow.claimBounty(job2, AGENT_ID);
        evil.setOtherJob(job2);

        vm.expectEmit(true, true, false, true);
        emit ReputationSkipped(job1, AGENT_ID, Four02ReputationRegistryV2.EventType.DisputeOpened);
        vm.prank(payer);
        evilEscrow.raiseDispute(job1); // outer dispute succeeds

        assertEq(uint8(evilEscrow.getJob(job1).state), uint8(BountyEscrow.JobState.Disputed));
        assertEq(uint8(evilEscrow.getJob(job2).state), uint8(BountyEscrow.JobState.Funded)); // untouched
    }

    // -- fee-math overflow --------------------------------------------------------

    function test_FeeMath_HugeAmountDoesNotBrickRelease() public {
        // (amount * feeBps) overflows for amount > ~2^250 at 75 bps; the
        // naive formula would panic and strand the job in Delivered (the
        // dispute path stays open, but release must not brick). mulDiv is
        // exact here: identical to the naive formula on all small inputs.
        uint256 huge = 2 ** 250;
        usdc.mint(payer, huge);
        vm.prank(payer);
        uint256 jobId = escrow.createBounty(huge, uint64(block.timestamp + 7 days), keccak256("huge"));
        vm.prank(worker);
        escrow.claimBounty(jobId, AGENT_ID);
        vm.prank(worker);
        escrow.confirmDelivery(jobId);
        vm.prank(payer);
        escrow.release(jobId); // pre-fix: panic 0x11, job stranded

        uint256 expectedFee = Math.mulDiv(huge, FEE_BPS, 10_000);
        assertEq(escrow.claimable(jobId, feeRecipient), expectedFee);
        assertEq(escrow.claimable(jobId, worker), huge - expectedFee);
        vm.prank(worker);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(worker), huge - expectedFee);
    }

    function test_Dispute_SplitMathHugeAmount() public {
        // Same overflow class in resolveDispute's (amount * providerShareBps).
        uint256 huge = 2 ** 250;
        usdc.mint(payer, huge);
        vm.prank(payer);
        uint256 jobId = escrow.createBounty(huge, uint64(block.timestamp + 7 days), keccak256("huge"));
        vm.prank(worker);
        escrow.claimBounty(jobId, AGENT_ID);
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(arbiter);
        escrow.resolveDispute(jobId, 3333);

        uint256 expectedProvider = Math.mulDiv(huge, 3333, 10_000);
        assertEq(escrow.claimable(jobId, worker), expectedProvider);
        assertEq(escrow.claimable(jobId, payer), huge - expectedProvider);
    }

    // -- split boundaries ----------------------------------------------------------

    function test_Dispute_SplitBoundariesConserveFunds() public {
        // Odd amount (dust-prone): every boundary split must conserve funds
        // exactly, take no fee, and pick the documented arbitration side.
        uint256 amount = 9999;
        uint256[7] memory bpsCases = [uint256(0), 1, 4999, 5000, 5001, 9999, 10_000];
        uint256 expectedWins;
        uint256 expectedLosses;
        for (uint256 i = 0; i < bpsCases.length; i++) {
            uint256 bps = bpsCases[i];
            vm.prank(payer);
            uint256 jobId =
                escrow.createBounty(amount, uint64(block.timestamp + 7 days), keccak256(abi.encode(bps)));
            vm.prank(worker);
            escrow.claimBounty(jobId, AGENT_ID);
            vm.prank(payer);
            escrow.raiseDispute(jobId);
            vm.prank(arbiter);
            escrow.resolveDispute(jobId, bps);

            uint256 expectedProvider = (amount * bps) / 10_000; // small: naive math is safe here
            uint256 expectedPayer = amount - expectedProvider;
            assertEq(escrow.claimable(jobId, worker), expectedProvider, "provider split");
            assertEq(escrow.claimable(jobId, payer), expectedPayer, "payer split");
            assertEq(escrow.claimable(jobId, feeRecipient), 0, "no fee on disputes");
            assertEq(
                escrow.claimable(jobId, worker) + escrow.claimable(jobId, payer), amount, "conservation"
            );

            (uint256 wins, uint256 losses) = repRegistry.arbitrationRecord(AGENT_ID);
            if (bps >= 5000) {
                expectedWins++;
            } else {
                expectedLosses++;
            }
            assertEq(wins, expectedWins, "cumulative wins");
            assertEq(losses, expectedLosses, "cumulative losses");
        }
    }

    // -- dust ------------------------------------------------------------------------

    function test_DustBounty_OneWeiFullFlow() public {
        // 1 wei: fee rounds to zero, the provider still gets the wei, and no
        // dust locks anywhere.
        vm.prank(payer);
        uint256 jobId = escrow.createBounty(1, uint64(block.timestamp + 7 days), keccak256("dust"));
        vm.prank(worker);
        escrow.claimBounty(jobId, AGENT_ID);
        vm.prank(worker);
        escrow.confirmDelivery(jobId);
        vm.prank(payer);
        escrow.release(jobId);

        assertEq(escrow.claimable(jobId, worker), 1);
        assertEq(escrow.claimable(jobId, feeRecipient), 0);
        vm.prank(worker);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(worker), 1);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // -- sweep --------------------------------------------------------------------------

    function test_Sweep_RecoversStrayTransfer() public {
        // USDC sent directly (no job, no claim entry) had no exit path.
        vm.prank(stranger);
        usdc.mint(stranger, 5_000_000);
        vm.prank(stranger);
        require(usdc.transfer(address(escrow), 5_000_000));
        assertEq(escrow.totalReserved(), 0);

        vm.expectEmit(true, false, false, true);
        emit ExcessSwept(feeRecipient, 5_000_000);
        vm.prank(stranger); // permissionless
        escrow.sweep();

        assertEq(usdc.balanceOf(feeRecipient), 5_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_Sweep_RevertsWhenNoExcess() public {
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NoExcess.selector);
        escrow.sweep();
    }

    function test_Sweep_NeverTouchesJobFunds() public {
        uint256 jobId = _openBounty(); // 100 USDC reserved
        assertEq(escrow.totalReserved(), JOB_AMOUNT);

        vm.prank(stranger);
        usdc.mint(stranger, 5_000_000);
        vm.prank(stranger);
        require(usdc.transfer(address(escrow), 5_000_000));

        vm.prank(stranger);
        escrow.sweep();
        assertEq(usdc.balanceOf(feeRecipient), 5_000_000); // exactly the stray
        assertEq(usdc.balanceOf(address(escrow)), JOB_AMOUNT); // job funds intact

        // The job still completes in full afterwards.
        vm.prank(worker);
        escrow.claimBounty(jobId, AGENT_ID);
        vm.prank(worker);
        escrow.confirmDelivery(jobId);
        vm.prank(payer);
        escrow.release(jobId);
        vm.prank(worker);
        escrow.claim(jobId);
        vm.prank(feeRecipient);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(worker), 99_250_000);
        assertEq(usdc.balanceOf(feeRecipient), 5_000_000 + 750_000);
        assertEq(escrow.totalReserved(), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // -- refundDelay bounds -----------------------------------------------------------------

    function test_Constructor_RevertsOnZeroRefundDelay() public {
        // Zero would silently void the M3 mempool-race protection: a
        // stranger's refund could win the deadline block against the
        // provider's confirmDelivery.
        vm.expectRevert(BountyEscrow.BadRefundDelay.selector);
        _deployEscrow(address(repRegistry), 0);
    }

    function test_Constructor_RevertsOnExcessiveRefundDelay() public {
        // Unbounded delay locks payer funds in unclaimed/ghosted bounties
        // forever — refund() could never open and there is no cancelBounty.
        vm.expectRevert(BountyEscrow.BadRefundDelay.selector);
        _deployEscrow(address(repRegistry), 91 days);
    }

    function test_Constructor_AcceptsMaxRefundDelay() public {
        BountyEscrow e = _deployEscrow(address(repRegistry), 90 days);
        assertEq(e.refundDelay(), 90 days);
    }

    // -- refId namespacing ----------------------------------------------------------------------

    function test_RefId_NamespacedPerWriter() public {
        // Two deployments of this escrow share the registry's per-agent
        // refId space and both start job counters at 1. Pre-fix, both used
        // bytes32(jobId): escrowB's DisputeResolved(job 1) would neutralize
        // escrowA's DisputeOpened(job 1) for the same agent, silently
        // zeroing a live dispute signal in disputeRate.
        BountyEscrow escrowB = _deployEscrow(address(repRegistry), REFUND_DELAY);
        repRegistry.addWriter(address(escrowB));
        vm.prank(payer);
        usdc.approve(address(escrowB), type(uint256).max);

        // escrowA job 1: disputed, never resolved (live signal).
        vm.prank(payer);
        uint256 jobA = escrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("A"));
        vm.prank(worker);
        escrow.claimBounty(jobA, AGENT_ID);
        vm.prank(payer);
        escrow.raiseDispute(jobA);

        // escrowB job 1: disputed then resolved (would neutralize A's).
        vm.prank(payer);
        uint256 jobB = escrowB.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("B"));
        vm.prank(worker);
        escrowB.claimBounty(jobB, AGENT_ID);
        vm.prank(payer);
        escrowB.raiseDispute(jobB);
        vm.prank(arbiter);
        escrowB.resolveDispute(jobB, 5000);

        // A completed job so disputeRate has a denominator.
        vm.prank(payer);
        uint256 jobC = escrow.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("C"));
        vm.prank(worker);
        escrow.claimBounty(jobC, AGENT_ID);
        vm.prank(worker);
        escrow.confirmDelivery(jobC);
        vm.prank(payer);
        escrow.release(jobC);

        // Event order for the agent: A:DisputeOpened(0), B:DisputeOpened(1),
        // B:DisputeResolved(2), B:ArbitrationWon(3), A:EscrowCompleted(4).
        assertEq(uint8(_eventType(AGENT_ID, 0)), uint8(Four02ReputationRegistryV2.EventType.DisputeOpened));
        assertEq(uint8(_eventType(AGENT_ID, 2)), uint8(Four02ReputationRegistryV2.EventType.DisputeResolved));
        assertTrue(_eventRefId(AGENT_ID, 0) != _eventRefId(AGENT_ID, 2), "refIds must be writer-namespaced");

        // A's dispute is still an ACTIVE signal: pre-fix this was 0.
        assertGt(repRegistry.disputeRate(AGENT_ID), 0);
    }

    // -- registry: writer allowlist ---------------------------------------------------------------

    function test_AddWriter_RevertsForEOA() public {
        // An EOA can sign transactions directly: allowlisting one would hand
        // a single key unconstrained reputation-write power over every
        // agentId, outside the "trusted protocol contract" assumption.
        vm.expectRevert(Four02ReputationRegistryV2.NotContract.selector);
        repRegistry.addWriter(makeAddr("eoa"));
        assertFalse(repRegistry.isWriter(makeAddr("eoa")));
    }

    function test_AddWriter_AcceptsContract() public {
        address writerContract = address(new MockUSDC2());
        repRegistry.addWriter(writerContract);
        assertTrue(repRegistry.isWriter(writerContract));
    }
}
