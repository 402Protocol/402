// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {AgentEscrow} from "../../contracts/AgentEscrow.sol";
import {Reputation} from "../../contracts/Reputation.sol";

/// @notice Minimal mock USDC (6 decimals, mintable) for local testing.
contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
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
        emit Transfer(from, to, amount);
    }
}

/// @notice Malicious token: tries to reenter escrow.claim() when the escrow
/// pays the claim out. The reentry must fail and the outer claim must pay
/// exactly once.
/// @dev In the test below the CLAIMANT is the token contract itself, so the
/// reentrant claim() comes from the TRUE claimant — only the
/// zero-before-transfer ordering (plus nonReentrant) blocks the double pay.
/// reentrySucceeded is set only if the inner claim ever succeeds.
contract ReentrantUSDC is MockUSDC {
    AgentEscrow public target;
    uint256 public targetJob;
    bool public reentrySucceeded;

    function arm(AgentEscrow target_, uint256 jobId) external {
        target = target_;
        targetJob = jobId;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (address(target) != address(0)) {
            // Attempt the reentry; it must revert. Swallow the revert so the
            // outer call can proceed, then disarm to avoid looping.
            try target.claim(targetJob) {
                reentrySucceeded = true;
            } catch {}
            target = AgentEscrow(address(0));
        }
        _move(msg.sender, to, amount);
        return true;
    }
}

contract AgentEscrowTest is Test {
    MockUSDC internal usdc;
    AgentEscrow internal escrow;
    Reputation internal reputation;

    address internal payer = makeAddr("payer");
    address internal provider = makeAddr("provider");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant FEE_BPS = 75; // proposed, not final
    uint64 internal constant REFUND_DELAY = 1 days; // M3 grace window
    uint256 internal constant JOB_AMOUNT = 100_000_000; // 100 USDC (6dp)

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new AgentEscrow(address(usdc), arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, guardian);
        reputation = escrow.reputation();
        usdc.mint(payer, 1_000_000_000);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // -- helpers -------------------------------------------------------------

    function _fundedJob() internal returns (uint256 jobId) {
        vm.prank(payer);
        jobId = escrow.createJob(provider, JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("terms"));
    }

    function _deliveredJob() internal returns (uint256 jobId) {
        jobId = _fundedJob();
        vm.prank(provider);
        escrow.confirmDelivery(jobId);
    }

    // -- createJob ------------------------------------------------------------

    function test_CreateJob_HappyPath() public {
        vm.prank(payer);
        uint256 jobId = escrow.createJob(provider, JOB_AMOUNT, uint64(block.timestamp + 1 days), keccak256("t"));

        AgentEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.payer, payer);
        assertEq(job.provider, provider);
        assertEq(job.amount, JOB_AMOUNT);
        assertEq(uint8(job.state), uint8(AgentEscrow.JobState.Funded));
        assertEq(usdc.balanceOf(address(escrow)), JOB_AMOUNT);
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - JOB_AMOUNT);
    }

    function test_CreateJob_RevertsOnZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.ZeroAmount.selector);
        escrow.createJob(provider, 0, uint64(block.timestamp + 1 days), bytes32(0));
    }

    function test_CreateJob_RevertsOnPastDeadline() public {
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.BadDeadline.selector);
        escrow.createJob(provider, JOB_AMOUNT, uint64(block.timestamp - 1), bytes32(0));
    }

    function test_CreateJob_RevertsOnZeroProvider() public {
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.ZeroAddress.selector);
        escrow.createJob(address(0), JOB_AMOUNT, uint64(block.timestamp + 1 days), bytes32(0));
    }

    function test_CreateJob_RevertsOnUnknownJob() public {
        vm.expectRevert(AgentEscrow.UnknownJob.selector);
        escrow.getJob(999);
    }

    // -- confirmDelivery -------------------------------------------------------

    function test_ConfirmDelivery_HappyPath() public {
        uint256 jobId = _fundedJob();
        vm.prank(provider);
        escrow.confirmDelivery(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Delivered));
    }

    function test_ConfirmDelivery_RevertsForNonProvider() public {
        uint256 jobId = _fundedJob();
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotProvider.selector);
        escrow.confirmDelivery(jobId);
    }

    function test_ConfirmDelivery_RevertsWhenNotFunded() public {
        uint256 jobId = _deliveredJob();
        vm.prank(provider);
        vm.expectRevert(AgentEscrow.BadState.selector);
        escrow.confirmDelivery(jobId);
    }

    // -- release (pull payments: records claims, moves nothing) ----------------

    function test_Release_HappyPath_FeeMathExact() public {
        uint256 jobId = _deliveredJob();

        uint256 expectedFee = (JOB_AMOUNT * FEE_BPS) / 10_000; // 750_000 (0.75 USDC)
        uint256 expectedProvider = JOB_AMOUNT - expectedFee; // 99_250_000
        assertEq(expectedFee, 750_000);
        assertEq(expectedProvider, 99_250_000);

        vm.prank(payer);
        escrow.release(jobId);

        // H3: release records claims but moves NOTHING.
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Released));
        assertEq(usdc.balanceOf(provider), 0, "release pushed funds");
        assertEq(usdc.balanceOf(feeRecipient), 0, "release pushed funds");
        assertEq(usdc.balanceOf(address(escrow)), JOB_AMOUNT, "funds left escrow on release");
        assertEq(escrow.claimable(jobId, provider), expectedProvider);
        assertEq(escrow.claimable(jobId, feeRecipient), expectedFee);

        // Each payee withdraws independently.
        vm.prank(provider);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(provider), expectedProvider);
        assertEq(escrow.claimable(jobId, provider), 0, "claim not zeroed");

        vm.prank(feeRecipient);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(feeRecipient), expectedFee);
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow not drained");

        assertEq(reputation.completedJobs(provider), 1);
        assertEq(reputation.score(provider), 10_000);
    }

    function test_Release_RevertsForNonPayer() public {
        uint256 jobId = _deliveredJob();
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotPayer.selector);
        escrow.release(jobId);
    }

    function test_Release_RevertsWhenNotDelivered() public {
        uint256 jobId = _fundedJob(); // never delivered
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.BadState.selector);
        escrow.release(jobId);
    }

    function test_Release_RevertsOnDoubleRelease() public {
        uint256 jobId = _deliveredJob();
        vm.prank(payer);
        escrow.release(jobId);
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.BadState.selector);
        escrow.release(jobId);
    }

    // -- claim -----------------------------------------------------------------

    function test_Claim_RevertsWithNothingToClaim() public {
        uint256 jobId = _fundedJob();
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NothingToClaim.selector);
        escrow.claim(jobId);
    }

    function test_Claim_DoubleClaimReverts() public {
        uint256 jobId = _deliveredJob();
        vm.prank(payer);
        escrow.release(jobId);
        vm.prank(provider);
        escrow.claim(jobId);
        vm.prank(provider);
        vm.expectRevert(AgentEscrow.NothingToClaim.selector);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(provider), 99_250_000, "double claim paid out");
    }

    function test_Claim_OnlyClaimantMovesTheirEntry() public {
        uint256 jobId = _deliveredJob();
        vm.prank(payer);
        escrow.release(jobId);
        // The payer has no claim on a released job: their call reverts and
        // touches nothing.
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.NothingToClaim.selector);
        escrow.claim(jobId);
        assertEq(escrow.claimable(jobId, provider), 99_250_000);
        assertEq(escrow.claimable(jobId, feeRecipient), 750_000);
    }

    // -- disputes (pull payments: records claims, moves nothing) ---------------

    function test_Dispute_WonByPayer() public {
        uint256 jobId = _fundedJob();
        vm.prank(payer);
        escrow.raiseDispute(jobId);

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, 0); // payer keeps everything

        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Resolved));
        // Nothing moved yet — the payer withdraws via claim().
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - JOB_AMOUNT);
        assertEq(escrow.claimable(jobId, payer), JOB_AMOUNT);
        assertEq(escrow.claimable(jobId, provider), 0);

        vm.prank(payer);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(payer), 1_000_000_000); // full refund
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(reputation.lostDisputes(provider), 1);
        assertEq(reputation.completedJobs(provider), 0);
        assertEq(reputation.score(provider), 0);
    }

    function test_Dispute_Split_ProviderKeepsMajority() public {
        uint256 jobId = _deliveredJob();
        vm.prank(provider);
        escrow.raiseDispute(jobId);

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, 7_000); // provider 70%, payer 30%

        assertEq(escrow.claimable(jobId, provider), 70_000_000);
        assertEq(escrow.claimable(jobId, payer), 30_000_000);
        assertEq(escrow.claimable(jobId, feeRecipient), 0, "fee taken on dispute");

        vm.prank(provider);
        escrow.claim(jobId);
        vm.prank(payer);
        escrow.claim(jobId);

        assertEq(usdc.balanceOf(provider), 70_000_000);
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - JOB_AMOUNT + 30_000_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(reputation.completedJobs(provider), 1); // >= 50% counts as completion
        assertEq(reputation.score(provider), 10_000);
    }

    function test_Dispute_RevertsForNonArbiter() public {
        uint256 jobId = _fundedJob();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotArbiter.selector);
        escrow.resolveDispute(jobId, 5_000);
    }

    function test_Dispute_RevertsShareTooHigh() public {
        uint256 jobId = _fundedJob();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(arbiter);
        vm.expectRevert(AgentEscrow.ShareTooHigh.selector);
        escrow.resolveDispute(jobId, 10_001);
    }

    function test_RaiseDispute_RevertsForThirdParty() public {
        uint256 jobId = _fundedJob();
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotParty.selector);
        escrow.raiseDispute(jobId);
    }

    function test_RaiseDispute_FromDelivered_ByPayer() public {
        uint256 jobId = _deliveredJob();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Disputed));
    }

    // -- refund (M3 grace window + H3 pull) --------------------------------------

    // H3 edge case: founder sets feeRecipient == provider. Pull-payment claims
    // must accumulate in the shared slot — assignment would overwrite the
    // provider's share and lock amount - fee forever.
    function test_Release_FeeRecipientIsProvider_ClaimsAccumulate() public {
        AgentEscrow e = new AgentEscrow(address(usdc), arbiter, provider, FEE_BPS, REFUND_DELAY, guardian);
        usdc.mint(payer, 1_000_000_000);
        vm.prank(payer);
        usdc.approve(address(e), type(uint256).max);

        vm.prank(payer);
        uint256 jobId = e.createJob(provider, JOB_AMOUNT, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(provider);
        e.confirmDelivery(jobId);
        vm.prank(payer);
        e.release(jobId);

        assertEq(e.claimable(jobId, provider), JOB_AMOUNT, "claims overwritten");
        vm.prank(provider);
        e.claim(jobId);
        assertEq(usdc.balanceOf(provider), JOB_AMOUNT, "provider not paid in full");
        assertEq(usdc.balanceOf(address(e)), 0, "funds left in escrow");
    }

    function test_Refund_AfterGraceWindow() public {
        uint256 jobId = _fundedJob();
        vm.warp(block.timestamp + 7 days + REFUND_DELAY + 1);
        // anyone may trigger; records the payer's claim, moves nothing
        vm.prank(stranger);
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Refunded));
        assertEq(usdc.balanceOf(payer), 1_000_000_000 - JOB_AMOUNT, "refund pushed funds");
        assertEq(escrow.claimable(jobId, payer), JOB_AMOUNT);

        vm.prank(payer);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(payer), 1_000_000_000);
    }

    function test_Refund_RevertsBeforeDeadline() public {
        uint256 jobId = _fundedJob();
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.TooEarly.selector);
        escrow.refund(jobId);
    }

    // M3: refund opens at deadline + refundDelay, not at the deadline.
    function test_Refund_RevertsDuringGraceWindow() public {
        uint256 jobId = _fundedJob(); // deadline = now + 7 days
        vm.warp(block.timestamp + 7 days + 12 hours); // past deadline, inside the 24h grace
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.TooEarly.selector);
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Funded));
    }

    function test_Refund_OpensExactlyAtDeadlinePlusDelay() public {
        uint256 jobId = _fundedJob();
        vm.warp(block.timestamp + 7 days + REFUND_DELAY); // exactly at the boundary
        vm.prank(stranger);
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Refunded));
    }

    // M3/L5: during the grace window the provider may still deliver and
    // either party may dispute — late delivery is specified behavior now.
    function test_ConfirmDelivery_AllowedDuringGraceWindow() public {
        uint256 jobId = _fundedJob();
        vm.warp(block.timestamp + 7 days + 12 hours);
        vm.prank(provider);
        escrow.confirmDelivery(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Delivered));
    }

    function test_RaiseDispute_AllowedDuringGraceWindow() public {
        uint256 jobId = _fundedJob();
        vm.warp(block.timestamp + 7 days + 12 hours);
        vm.prank(provider);
        escrow.raiseDispute(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Disputed));
    }

    function test_Refund_RevertsWhenDelivered() public {
        uint256 jobId = _deliveredJob();
        vm.warp(block.timestamp + 8 days);
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.BadState.selector);
        escrow.refund(jobId);
        // payer can still release after a good delivery; provider claims
        vm.prank(payer);
        escrow.release(jobId);
        vm.prank(provider);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(provider), 99_250_000);
    }

    // -- arbiter rotation (H4) ---------------------------------------------------

    function test_Rotation_GuardianProposes_AnyoneConfirmsAfterDelay() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(guardian);
        escrow.proposeRotation(newArbiter);
        assertEq(escrow.pendingArbiter(), newArbiter);
        assertEq(escrow.rotationReadyAt(), block.timestamp + 14 days);

        // Premature confirm reverts, even by the guardian.
        vm.prank(guardian);
        vm.expectRevert(AgentEscrow.RotationTooEarly.selector);
        escrow.confirmRotation();

        // After the timelock, ANYONE can finalize the rotation.
        vm.warp(block.timestamp + 14 days);
        vm.prank(stranger);
        escrow.confirmRotation();
        assertEq(escrow.arbiter(), newArbiter);
        assertEq(escrow.pendingArbiter(), address(0));
        assertEq(escrow.rotationReadyAt(), 0);

        // The new arbiter resolves disputes; the old one cannot.
        uint256 jobId = _fundedJob();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(arbiter);
        vm.expectRevert(AgentEscrow.NotArbiter.selector);
        escrow.resolveDispute(jobId, 0);
        vm.prank(newArbiter);
        escrow.resolveDispute(jobId, 0);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Resolved));
    }

    function test_Rotation_ArbiterItselfCanPropose() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(arbiter);
        escrow.proposeRotation(newArbiter);
        assertEq(escrow.pendingArbiter(), newArbiter);
        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(stranger);
        escrow.confirmRotation();
        assertEq(escrow.arbiter(), newArbiter);
    }

    function test_Rotation_RevertsForNonProposer() public {
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotProposer.selector);
        escrow.proposeRotation(makeAddr("evil"));
        // the payer is not a proposer either
        vm.prank(payer);
        vm.expectRevert(AgentEscrow.NotProposer.selector);
        escrow.proposeRotation(makeAddr("evil"));
    }

    function test_Rotation_RevertsOnZeroAddress() public {
        vm.prank(guardian);
        vm.expectRevert(AgentEscrow.ZeroAddress.selector);
        escrow.proposeRotation(address(0));
    }

    function test_Rotation_ConfirmWithoutProposalReverts() public {
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NoRotationPending.selector);
        escrow.confirmRotation();
    }

    function test_Rotation_CancelClearsProposal() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(guardian);
        escrow.proposeRotation(newArbiter);
        // The arbiter can cancel a proposal it disagrees with.
        vm.prank(arbiter);
        escrow.cancelRotation();
        assertEq(escrow.pendingArbiter(), address(0));

        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NoRotationPending.selector);
        escrow.confirmRotation();
        assertEq(escrow.arbiter(), arbiter, "arbiter changed despite cancel");
    }

    function test_Rotation_CancelRevertsForNonProposer() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(guardian);
        escrow.proposeRotation(newArbiter);
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotProposer.selector);
        escrow.cancelRotation();
    }

    function test_Rotation_ReproposeRestartsTimelock() public {
        address first = makeAddr("first");
        address second = makeAddr("second");
        vm.prank(guardian);
        escrow.proposeRotation(first);
        vm.warp(block.timestamp + 13 days);
        // Re-proposing overwrites and RESTARTS the clock.
        vm.prank(guardian);
        escrow.proposeRotation(second);
        vm.warp(block.timestamp + 13 days);
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.RotationTooEarly.selector);
        escrow.confirmRotation();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(stranger);
        escrow.confirmRotation();
        assertEq(escrow.arbiter(), second);
    }

    // -- reentrancy (H3: the payout surface is now claim()) ----------------------

    function test_Reentrancy_AttackFails() public {
        ReentrantUSDC evil = new ReentrantUSDC();
        AgentEscrow evilEscrow = new AgentEscrow(address(evil), arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, guardian);
        // The CLAIMANT is the malicious token contract itself: the reentrant
        // claim() during payout comes from the TRUE claimant, so only the
        // zero-before-transfer ordering (plus nonReentrant) blocks it.
        address evilProvider = address(evil);
        evil.mint(payer, 1_000_000_000);
        vm.prank(payer);
        evil.approve(address(evilEscrow), type(uint256).max);

        vm.prank(payer);
        uint256 jobId = evilEscrow.createJob(evilProvider, JOB_AMOUNT, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(evilProvider);
        evilEscrow.confirmDelivery(jobId);
        vm.prank(payer);
        evilEscrow.release(jobId); // records claims; no transfers

        evil.arm(evilEscrow, jobId); // token will try to reenter claim() on payout

        vm.prank(evilProvider);
        evilEscrow.claim(jobId); // must NOT revert; reentry is blocked

        // Claimant paid exactly once — no double spend from the reentry.
        assertFalse(evil.reentrySucceeded(), "reentrant claim paid out");
        assertEq(evil.balanceOf(evilProvider), 99_250_000);
        assertEq(evilEscrow.claimable(jobId, evilProvider), 0, "claim not zeroed");
        assertEq(evil.balanceOf(address(evilEscrow)), 750_000, "fee leg disturbed");
    }

    // -- constructor guards ------------------------------------------------------------

    function test_Constructor_RevertsOnHighFee() public {
        vm.expectRevert(AgentEscrow.FeeTooHigh.selector);
        new AgentEscrow(address(usdc), arbiter, feeRecipient, 1_001, REFUND_DELAY, guardian);
    }

    function test_Constructor_RevertsOnZeroAddress() public {
        vm.expectRevert(AgentEscrow.ZeroAddress.selector);
        new AgentEscrow(address(0), arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, guardian);
        // H4: a zero guardian would permanently disable the rotation recovery
        // path — the contract fails closed, not just the deploy script.
        vm.expectRevert(AgentEscrow.ZeroAddress.selector);
        new AgentEscrow(address(usdc), arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, address(0));
    }

    // H5: deploying against an address with no contract code must revert —
    // otherwise SafeERC20 treats empty returndata as success and jobs become
    // accounting fiction backed by zero tokens.
    function test_Constructor_RevertsWhenTokenHasNoCode() public {
        address eoa = makeAddr("not-a-contract");
        vm.expectRevert(AgentEscrow.NotContract.selector);
        new AgentEscrow(eoa, arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, guardian);
    }

    function test_Constructor_SetsNewParams() public {
        assertEq(escrow.refundDelay(), REFUND_DELAY);
        assertEq(escrow.guardian(), guardian);
        assertEq(escrow.arbiter(), arbiter);
        assertEq(escrow.pendingArbiter(), address(0));
        assertEq(escrow.rotationReadyAt(), 0);
        assertEq(escrow.ROTATION_DELAY(), 14 days);
    }

    // M2: self-dealing (payer == provider) must revert — one self-job used to
    // mint a perfect reputation score at dust cost (fee rounds to zero).
    function test_CreateJob_RevertsOnSelfDealing() public {
        vm.expectRevert(AgentEscrow.SelfDealing.selector);
        vm.prank(payer);
        escrow.createJob(payer, JOB_AMOUNT, uint64(block.timestamp + 1 days), keccak256("self"));
    }

    // M2: the self-dealing guard also holds at dust amounts, where the fee
    // would have rounded to zero and farming would have cost only gas.
    function test_CreateJob_RevertsOnSelfDealing_AtDustAmount() public {
        vm.expectRevert(AgentEscrow.SelfDealing.selector);
        vm.prank(payer);
        escrow.createJob(payer, 1, uint64(block.timestamp + 1 days), keccak256("self"));
    }
}

contract ReputationTest is Test {
    Reputation internal reputation;
    address internal provider = makeAddr("provider");

    function setUp() public {
        // In production only the escrow records; here the test contract plays
        // the escrow role to exercise the ledger math directly.
        reputation = new Reputation(address(this));
    }

    function test_OnlyEscrowCanRecord() public {
        Reputation locked = new Reputation(makeAddr("escrow"));
        vm.expectRevert(Reputation.OnlyEscrow.selector);
        locked.recordCompletion(provider);
        vm.expectRevert(Reputation.OnlyEscrow.selector);
        locked.recordLostDispute(provider);
    }

    function test_ScoreMath() public {
        // 3 completions, 1 lost dispute -> 7500 bps
        reputation.recordCompletion(provider);
        reputation.recordCompletion(provider);
        reputation.recordCompletion(provider);
        reputation.recordLostDispute(provider);
        assertEq(reputation.score(provider), 7_500);

        (uint256 c, uint256 l, uint256 s, bool hasHistory) = reputation.stats(provider);
        assertEq(c, 3);
        assertEq(l, 1);
        assertEq(s, 7_500);
        assertTrue(hasHistory);
    }

    function test_ScoreZeroWithNoHistory() public {
        address fresh = makeAddr("fresh");
        assertEq(reputation.score(fresh), 0);
        (,,, bool hasHistory) = reputation.stats(fresh);
        assertFalse(hasHistory);
    }
}
