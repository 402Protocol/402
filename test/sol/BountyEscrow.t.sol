// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {BountyEscrow, IIdentityRegistry} from "../../contracts/BountyEscrow.sol";
import {Four02ReputationRegistryV2} from "../../contracts/Four02ReputationRegistryV2.sol";

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
        emit Transfer(from, to, amount);
    }
}

/// @notice Mock ERC-8004 identity registry: ownerOf is a test-controlled map.
/// Unknown agentIds return address(0) (the real ERC-721 reverts; either way
/// the escrow's claimBounty fails closed).
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) internal owners;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view override returns (address) {
        return owners[agentId];
    }
}

contract BountyEscrowTest is Test {
    MockUSDC internal usdc;
    MockIdentityRegistry internal identityRegistry;
    Four02ReputationRegistryV2 internal repRegistry;
    BountyEscrow internal escrow;
    BountyEscrow internal escrowNoRep; // same registries, NOT allowlisted as a writer

    address internal payer = makeAddr("payer");
    address internal worker = makeAddr("worker");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AGENT_ID = 42;
    uint256 internal constant FEE_BPS = 75; // proposed, not final
    uint64 internal constant REFUND_DELAY = 1 days; // M3 grace window
    uint256 internal constant JOB_AMOUNT = 100_000_000; // 100 USDC (6dp)
    uint256 internal constant EXPECTED_FEE = 750_000; // 100 USDC * 75 bps
    uint256 internal constant EXPECTED_PROVIDER = 99_250_000;

    event BountyCreated(
        uint256 indexed jobId, address indexed payer, uint256 amount, uint64 deadline, bytes32 termsHash
    );
    event BountyClaimed(uint256 indexed jobId, address indexed provider, uint256 indexed agentId);

    function setUp() public {
        usdc = new MockUSDC();
        identityRegistry = new MockIdentityRegistry();
        repRegistry = new Four02ReputationRegistryV2(address(this));
        escrow = new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            address(repRegistry)
        );
        // escrowNoRep proves the try/catch: payouts work even when the
        // registry never allowlisted this writer.
        escrowNoRep = new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            address(repRegistry)
        );
        repRegistry.addWriter(address(escrow));
        identityRegistry.setOwner(AGENT_ID, worker);
        usdc.mint(payer, 10_000_000_000);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(payer);
        usdc.approve(address(escrowNoRep), type(uint256).max);
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

    function _repEventType(uint256 agentId, uint256 idx)
        internal
        view
        returns (Four02ReputationRegistryV2.EventType)
    {
        (Four02ReputationRegistryV2.EventType t,,,,,) = repRegistry.events(agentId, idx);
        return t;
    }

    function _repEventValue(uint256 agentId, uint256 idx) internal view returns (uint256) {
        (, uint256 v,,,,) = repRegistry.events(agentId, idx);
        return v;
    }

    function _repEventCounterparty(uint256 agentId, uint256 idx) internal view returns (address) {
        (,,,,, address cp) = repRegistry.events(agentId, idx);
        return cp;
    }

    // -- constructor ----------------------------------------------------------

    function test_Constructor_RevertsOnFeeTooHigh() public {
        vm.expectRevert(BountyEscrow.FeeTooHigh.selector);
        new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            1001,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            address(repRegistry)
        );
    }

    function test_Constructor_RevertsOnZeroIdentityRegistry() public {
        vm.expectRevert(BountyEscrow.ZeroAddress.selector);
        new BountyEscrow(
            address(usdc), arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, guardian, address(0), address(repRegistry)
        );
    }

    function test_Constructor_RevertsOnCodelessRegistry() public {
        vm.expectRevert(BountyEscrow.NotContract.selector);
        new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            makeAddr("eoa-no-code")
        );
    }

    // -- createBounty ----------------------------------------------------------

    function test_CreateBounty_HappyPath() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 terms = keccak256("spec-v1");
        vm.expectEmit(true, true, false, true);
        emit BountyCreated(1, payer, JOB_AMOUNT, deadline, terms);
        vm.prank(payer);
        uint256 jobId = escrow.createBounty(JOB_AMOUNT, deadline, terms);

        BountyEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.payer, payer);
        assertEq(job.provider, address(0)); // no provider until claimed
        assertEq(job.agentId, 0);
        assertEq(job.amount, JOB_AMOUNT);
        assertEq(uint8(job.state), uint8(BountyEscrow.JobState.Open));
        assertEq(usdc.balanceOf(address(escrow)), JOB_AMOUNT);
        assertEq(usdc.balanceOf(payer), 10_000_000_000 - JOB_AMOUNT);
    }

    function test_CreateBounty_RevertsOnZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.ZeroAmount.selector);
        escrow.createBounty(0, uint64(block.timestamp + 1 days), bytes32(0));
    }

    function test_CreateBounty_RevertsOnPastDeadline() public {
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.BadDeadline.selector);
        escrow.createBounty(JOB_AMOUNT, uint64(block.timestamp), bytes32(0));
    }

    function test_CreateBounty_RevertsOnUnknownJob() public {
        vm.expectRevert(BountyEscrow.UnknownJob.selector);
        escrow.getJob(999);
    }

    // -- claimBounty ------------------------------------------------------------

    function test_ClaimBounty_HappyPath() public {
        uint256 jobId = _openBounty();
        vm.expectEmit(true, true, true, true);
        emit BountyClaimed(jobId, worker, AGENT_ID);
        vm.prank(worker);
        escrow.claimBounty(jobId, AGENT_ID);

        BountyEscrow.Job memory job = escrow.getJob(jobId);
        assertEq(job.provider, worker);
        assertEq(job.agentId, AGENT_ID);
        assertEq(uint8(job.state), uint8(BountyEscrow.JobState.Funded));
    }

    function test_ClaimBounty_RevertsOnWrongBinding() public {
        uint256 jobId = _openBounty();
        identityRegistry.setOwner(AGENT_ID, stranger); // bound to someone else
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.BadIdentityBinding.selector);
        escrow.claimBounty(jobId, AGENT_ID);
    }

    function test_ClaimBounty_RevertsOnUnknownAgent() public {
        uint256 jobId = _openBounty();
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.BadIdentityBinding.selector);
        escrow.claimBounty(jobId, 777); // never registered in the mock
    }

    function test_ClaimBounty_RevertsOnDoubleClaim() public {
        uint256 jobId = _fundedBounty();
        identityRegistry.setOwner(43, stranger);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.BadState.selector);
        escrow.claimBounty(jobId, 43);
    }

    function test_ClaimBounty_RevertsOnSelfClaim() public {
        uint256 jobId = _openBounty();
        identityRegistry.setOwner(7, payer); // payer owns a real identity...
        vm.prank(payer); // ...but still cannot claim their own bounty (M2)
        vm.expectRevert(BountyEscrow.SelfDealing.selector);
        escrow.claimBounty(jobId, 7);
    }

    function test_ClaimBounty_RevertsOnUnknownJob() public {
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.UnknownJob.selector);
        escrow.claimBounty(999, AGENT_ID);
    }

    function test_ClaimBounty_RevertsOnZeroAgentId() public {
        uint256 jobId = _openBounty();
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.ZeroAgentId.selector);
        escrow.claimBounty(jobId, 0);
    }

    // -- confirmDelivery ---------------------------------------------------------

    function test_ConfirmDelivery_HappyPath() public {
        uint256 jobId = _fundedBounty();
        vm.prank(worker);
        escrow.confirmDelivery(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(BountyEscrow.JobState.Delivered));
    }

    function test_ConfirmDelivery_RevertsWhenOpen() public {
        uint256 jobId = _openBounty(); // no provider yet
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.NotProvider.selector);
        escrow.confirmDelivery(jobId);
    }

    // -- release ------------------------------------------------------------------

    function test_Release_FeeMathAndPullClaims() public {
        uint256 jobId = _deliveredBounty();
        vm.prank(payer);
        escrow.release(jobId);

        // Pull-payment ledger recorded exactly once.
        assertEq(escrow.claimable(jobId, worker), EXPECTED_PROVIDER);
        assertEq(escrow.claimable(jobId, feeRecipient), EXPECTED_FEE);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(BountyEscrow.JobState.Released));

        // Provider withdraws.
        vm.prank(worker);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(worker), EXPECTED_PROVIDER);
        assertEq(escrow.claimable(jobId, worker), 0);

        // Fee recipient withdraws independently.
        vm.prank(feeRecipient);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(feeRecipient), EXPECTED_FEE);
    }

    function test_Release_RecordsEscrowCompleted() public {
        uint256 jobId = _deliveredBounty();
        vm.prank(payer);
        escrow.release(jobId);

        assertEq(repRegistry.getEventCount(AGENT_ID), 1);
        assertEq(uint8(_repEventType(AGENT_ID, 0)), uint8(Four02ReputationRegistryV2.EventType.EscrowCompleted));
        assertEq(_repEventValue(AGENT_ID, 0), JOB_AMOUNT); // value = gross bounty
        assertEq(_repEventCounterparty(AGENT_ID, 0), payer);
    }

    function test_Release_ReputationNoopWhenNotAllowlisted() public {
        // escrowNoRep was never addWriter'd: recordCommerceEvent reverts
        // with NotWriter, the try/catch swallows it, and the payout proceeds.
        vm.prank(payer);
        uint256 jobId = escrowNoRep.createBounty(JOB_AMOUNT, uint64(block.timestamp + 7 days), keccak256("s"));
        vm.prank(worker);
        escrowNoRep.claimBounty(jobId, AGENT_ID);
        vm.prank(worker);
        escrowNoRep.confirmDelivery(jobId);
        vm.prank(payer);
        escrowNoRep.release(jobId);

        assertEq(escrowNoRep.claimable(jobId, worker), EXPECTED_PROVIDER);
        vm.prank(worker);
        escrowNoRep.claim(jobId);
        assertEq(usdc.balanceOf(worker), EXPECTED_PROVIDER);
        assertEq(repRegistry.getEventCount(AGENT_ID), 0); // nothing recorded
    }

    function test_Release_RevertsForNonPayer() public {
        uint256 jobId = _deliveredBounty();
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotPayer.selector);
        escrow.release(jobId);
    }

    function test_Release_RevertsWhenNotDelivered() public {
        uint256 jobId = _fundedBounty();
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.BadState.selector);
        escrow.release(jobId);
    }

    // -- dispute -------------------------------------------------------------------

    function test_Dispute_FullProviderWin() public {
        uint256 jobId = _deliveredBounty();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(BountyEscrow.JobState.Disputed));

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, 10_000); // provider keeps everything

        assertEq(escrow.claimable(jobId, worker), JOB_AMOUNT);
        assertEq(escrow.claimable(jobId, payer), 0);
        assertEq(escrow.claimable(jobId, feeRecipient), 0); // no fee on disputes

        // Reputation: DisputeOpened + DisputeResolved + ArbitrationWon.
        assertEq(repRegistry.getEventCount(AGENT_ID), 3);
        assertEq(uint8(_repEventType(AGENT_ID, 0)), uint8(Four02ReputationRegistryV2.EventType.DisputeOpened));
        assertEq(uint8(_repEventType(AGENT_ID, 1)), uint8(Four02ReputationRegistryV2.EventType.DisputeResolved));
        assertEq(uint8(_repEventType(AGENT_ID, 2)), uint8(Four02ReputationRegistryV2.EventType.ArbitrationWon));
        assertEq(_repEventValue(AGENT_ID, 2), JOB_AMOUNT);
        (uint256 wins, uint256 losses) = repRegistry.arbitrationRecord(AGENT_ID);
        assertEq(wins, 1);
        assertEq(losses, 0);

        vm.prank(worker);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(worker), JOB_AMOUNT);
    }

    function test_Dispute_ThirtySeventySplit_ArbitrationLost() public {
        uint256 jobId = _fundedBounty();
        vm.prank(worker); // worker can raise too
        escrow.raiseDispute(jobId);

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, 3000); // provider keeps 30% < 50% -> lost

        assertEq(escrow.claimable(jobId, worker), 30_000_000);
        assertEq(escrow.claimable(jobId, payer), 70_000_000);

        assertEq(uint8(_repEventType(AGENT_ID, 2)), uint8(Four02ReputationRegistryV2.EventType.ArbitrationLost));
        assertEq(_repEventValue(AGENT_ID, 2), 70_000_000); // value = payer's share
        (uint256 wins, uint256 losses) = repRegistry.arbitrationRecord(AGENT_ID);
        assertEq(wins, 0);
        assertEq(losses, 1);
    }

    function test_Dispute_RaiseRevertsForStranger() public {
        uint256 jobId = _fundedBounty();
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotParty.selector);
        escrow.raiseDispute(jobId);
    }

    function test_Dispute_ResolveRevertsForNonArbiter() public {
        uint256 jobId = _fundedBounty();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotArbiter.selector);
        escrow.resolveDispute(jobId, 5000);
    }

    function test_Dispute_ResolveRevertsOnShareTooHigh() public {
        uint256 jobId = _fundedBounty();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(arbiter);
        vm.expectRevert(BountyEscrow.ShareTooHigh.selector);
        escrow.resolveDispute(jobId, 10_001);
    }

    // -- refund ---------------------------------------------------------------------

    function test_Refund_OpenBounty_NoReputationEvent() public {
        uint256 jobId = _openBounty();
        uint64 deadline = escrow.getJob(jobId).deadline;
        vm.warp(deadline + REFUND_DELAY + 1);

        vm.prank(stranger); // permissionless trigger
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(BountyEscrow.JobState.Refunded));
        assertEq(escrow.claimable(jobId, payer), JOB_AMOUNT);

        // Unclaimed bounty: no worker bound, no reputation recorded.
        assertEq(repRegistry.getEventCount(AGENT_ID), 0);

        vm.prank(payer);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(payer), 10_000_000_000);
    }

    function test_Refund_GhostPath_DingsAgent() public {
        uint256 jobId = _fundedBounty(); // claimed, never delivered
        uint64 deadline = escrow.getJob(jobId).deadline;
        vm.warp(deadline + REFUND_DELAY + 1);

        vm.prank(stranger);
        escrow.refund(jobId);

        vm.prank(payer);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(payer), 10_000_000_000);

        // Ghost ding: a single WorkerGhosted event, value 0, keyed to agent.
        assertEq(repRegistry.getEventCount(AGENT_ID), 1);
        assertEq(uint8(_repEventType(AGENT_ID, 0)), uint8(Four02ReputationRegistryV2.EventType.WorkerGhosted));
        assertEq(uint8(Four02ReputationRegistryV2.EventType.WorkerGhosted), 9); // appended last, no shift
        assertEq(_repEventValue(AGENT_ID, 0), 0);
    }

    function test_Refund_RevertsTooEarly() public {
        uint256 jobId = _fundedBounty();
        uint64 deadline = escrow.getJob(jobId).deadline;
        vm.warp(deadline + REFUND_DELAY - 1); // one second before the window opens
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.refund(jobId);
    }

    function test_Refund_RevertsWhenDelivered() public {
        uint256 jobId = _deliveredBounty();
        uint64 deadline = escrow.getJob(jobId).deadline;
        vm.warp(deadline + REFUND_DELAY + 1);
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.BadState.selector);
        escrow.refund(jobId);
    }

    // -- M3 grace window --------------------------------------------------------------

    function test_M3_ConfirmDeliveryInsideGraceWindow() public {
        uint256 jobId = _fundedBounty();
        uint64 deadline = escrow.getJob(jobId).deadline;
        vm.warp(deadline + 1); // deadline passed, still inside the grace window

        // Nobody can refund yet while the job is still Funded...
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.refund(jobId);

        // ...and the provider can still deliver late.
        vm.prank(worker);
        escrow.confirmDelivery(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(BountyEscrow.JobState.Delivered));

        // And the payer can still release after a late delivery.
        vm.warp(deadline + REFUND_DELAY + 1);
        vm.prank(payer);
        escrow.release(jobId);
        assertEq(escrow.claimable(jobId, worker), EXPECTED_PROVIDER);
    }

    // -- arbiter rotation (H4) -----------------------------------------------------------

    function test_Rotation_Timelock() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(guardian);
        escrow.proposeRotation(newArbiter);
        assertEq(escrow.pendingArbiter(), newArbiter);

        // Too early: confirm reverts.
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.RotationTooEarly.selector);
        escrow.confirmRotation();

        // After the delay, anyone can finalize.
        vm.warp(block.timestamp + escrow.ROTATION_DELAY() + 1);
        vm.prank(stranger);
        escrow.confirmRotation();
        assertEq(escrow.arbiter(), newArbiter);
        assertEq(escrow.pendingArbiter(), address(0));

        // Old arbiter is powerless; new arbiter resolves.
        uint256 jobId = _fundedBounty();
        vm.prank(payer);
        escrow.raiseDispute(jobId);
        vm.prank(arbiter);
        vm.expectRevert(BountyEscrow.NotArbiter.selector);
        escrow.resolveDispute(jobId, 5000);
        vm.prank(newArbiter);
        escrow.resolveDispute(jobId, 5000);
        assertEq(escrow.claimable(jobId, worker), 50_000_000);
    }

    function test_Rotation_Cancel() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(arbiter);
        escrow.proposeRotation(newArbiter);
        vm.prank(guardian);
        escrow.cancelRotation();
        assertEq(escrow.pendingArbiter(), address(0));

        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NoRotationPending.selector);
        escrow.confirmRotation();
    }

    function test_Rotation_RevertsForNonProposer() public {
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotProposer.selector);
        escrow.proposeRotation(makeAddr("newArbiter"));
    }

    // -- claim -----------------------------------------------------------------------------

    function test_Claim_RevertsOnNothingToClaim() public {
        uint256 jobId = _fundedBounty();
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.NothingToClaim.selector);
        escrow.claim(jobId);
    }

    function test_Claim_CannotDoubleClaim() public {
        uint256 jobId = _deliveredBounty();
        vm.prank(payer);
        escrow.release(jobId);
        vm.prank(worker);
        escrow.claim(jobId);
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.NothingToClaim.selector);
        escrow.claim(jobId);
    }
}
