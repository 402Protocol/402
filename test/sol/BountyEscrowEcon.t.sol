// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {BountyEscrow, IIdentityRegistry} from "../../contracts/BountyEscrow.sol";
import {Four02ReputationRegistryV2} from "../../contracts/Four02ReputationRegistryV2.sol";

/// @notice Minimal mock USDC (6 decimals, mintable) for the econ tests.
contract EconUSDC {
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
contract EconIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) internal owners;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view override returns (address) {
        return owners[agentId];
    }
}

/// @notice Minimal authorized-writer contract for registry-direct tests
/// (the registry rejects EOA writers).
contract EconWriter {
    Four02ReputationRegistryV2 internal reg;

    constructor(address r) {
        reg = Four02ReputationRegistryV2(r);
    }

    function record(
        uint256 agentId,
        Four02ReputationRegistryV2.EventType t,
        uint256 value,
        bytes32 refId,
        address counterparty
    ) external {
        reg.recordCommerceEvent(agentId, t, value, refId, counterparty);
    }
}

/// @notice Economics-audit fixes F1-F6:
/// F1 pair cap on counted completions, F2 disputeRate zero-denominator,
/// F3 claim stake, F4 dispute bond + dispute timeout, F5 dispute
/// withdrawal, F6 payer cancel of unclaimed bounties.
contract BountyEscrowEconTest is Test {
    EconUSDC internal usdc;
    EconIdentityRegistry internal identityRegistry;
    Four02ReputationRegistryV2 internal repRegistry;
    EconWriter internal writer;

    address internal payer = makeAddr("payer");
    address internal payer2 = makeAddr("payer2");
    address internal worker = makeAddr("worker");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AGENT_ID = 42;
    uint256 internal constant FEE_BPS = 75;
    uint64 internal constant REFUND_DELAY = 1 days;
    uint256 internal constant JOB_AMOUNT = 100_000_000; // 100 USDC (6dp)
    uint256 internal constant EXPECTED_FEE = 750_000;
    uint256 internal constant EXPECTED_PROVIDER = 99_250_000;

    // F3/F4 recommended values from the audit.
    uint256 internal constant STAKE = 2_000_000; // $2 claim stake
    uint256 internal constant BOND = 1_000_000; // $1 dispute bond
    uint64 internal constant TIMEOUT = 30 days; // dispute timeout

    function setUp() public {
        usdc = new EconUSDC();
        identityRegistry = new EconIdentityRegistry();
        repRegistry = new Four02ReputationRegistryV2(address(this));
        writer = new EconWriter(address(repRegistry));
        repRegistry.addWriter(address(writer));
        identityRegistry.setOwner(AGENT_ID, worker);
    }

    function _deploy(uint256 stake, uint256 bond, uint64 timeout) internal returns (BountyEscrow e) {
        e = new BountyEscrow(
            address(usdc),
            arbiter,
            feeRecipient,
            FEE_BPS,
            REFUND_DELAY,
            guardian,
            address(identityRegistry),
            address(repRegistry),
            stake,
            bond,
            timeout
        );
        repRegistry.addWriter(address(e));
    }

    /// @notice createBounty + claimBounty with stake/bond approvals handled.
    function _fundedJob(BountyEscrow e, uint256 stake, uint256 bond) internal returns (uint256 jobId) {
        usdc.mint(payer, JOB_AMOUNT);
        vm.prank(payer);
        usdc.approve(address(e), JOB_AMOUNT);
        vm.prank(payer);
        jobId = e.createBounty(JOB_AMOUNT, uint64(block.timestamp + 1 days), keccak256("spec"));
        uint256 workerPull = stake + bond;
        if (workerPull > 0) {
            usdc.mint(worker, workerPull);
            vm.prank(worker);
            usdc.approve(address(e), workerPull);
        }
        vm.prank(worker);
        e.claimBounty(jobId, AGENT_ID);
    }

    function _complete(BountyEscrow e, uint256 jobId) internal {
        vm.prank(worker);
        e.confirmDelivery(jobId);
        vm.prank(payer);
        e.release(jobId);
    }

    // ------------------------------------------------------------------------
    // F1 — pair cap
    // ------------------------------------------------------------------------

    function test_PairCap_SixthCompletionUncounted() public {
        for (uint256 i = 1; i <= 6; i++) {
            writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.EscrowCompleted, 1_000_000, bytes32(i), payer);
        }
        // One live dispute: numerator 1 weight, denominator 5 weights
        // (the 6th completion is appended but uncounted).
        writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(7)), payer);
        assertEq(repRegistry.getEventCount(AGENT_ID), 7, "raw events all appended (sunlight)");
        assertEq(repRegistry.disputeRate(AGENT_ID), 2_000, "6th same-pair completion uncounted: 10000/5");
    }

    /// @notice The actual farming scenario: one payer + one worker recycle
    /// bounty capital through 6 full escrow cycles, then a live dispute.
    /// Pre-fix this showed 10000/6 ~= 1666; the cap holds it at 10000/5.
    function test_PairCap_FarmingScenarioThroughEscrow() public {
        BountyEscrow e = _deploy(0, 0, 0);
        for (uint256 i; i < 6; i++) {
            uint256 jobId = _fundedJob(e, 0, 0);
            _complete(e, jobId);
        }
        // 7th job: claimed, then disputed and left open.
        uint256 disputed = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.raiseDispute(disputed);

        assertEq(repRegistry.getEventCount(AGENT_ID), 7, "6 completions + 1 dispute opened");
        assertEq(repRegistry.disputeRate(AGENT_ID), 2_000, "farmed 6th completion does not dilute the rate");
    }

    function test_PairCap_DifferentCounterpartyNotCapped() public {
        for (uint256 i = 1; i <= 6; i++) {
            writer.record(
                AGENT_ID,
                Four02ReputationRegistryV2.EventType.EscrowCompleted,
                1_000_000,
                bytes32(i),
                address(uint160(i)) // distinct counterparty each time
            );
        }
        writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(7)), payer);
        assertEq(repRegistry.disputeRate(AGENT_ID), 1_666, "6 distinct pairs all counted: 10000/6");
    }

    function test_PairCap_GhostsNeverCapped() public {
        writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.EscrowCompleted, 1_000_000, bytes32(uint256(1)), payer);
        for (uint256 i = 2; i <= 7; i++) {
            writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, bytes32(i), address(0));
        }
        // 6 ghost signals, 1 completion: accountability is uncapped.
        assertEq(repRegistry.disputeRate(AGENT_ID), 60_000, "ghosts never capped");
    }

    function test_PairCap_DisputeSignalsNeverCapped() public {
        writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.EscrowCompleted, 1_000_000, bytes32(uint256(1)), payer);
        for (uint256 i = 2; i <= 7; i++) {
            writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(i), payer);
        }
        assertEq(repRegistry.disputeRate(AGENT_ID), 60_000, "dispute signals never capped");
    }

    function test_PairCap_SetCap() public {
        repRegistry.setPairCompletionCap(2);
        assertEq(repRegistry.pairCompletionCap(), 2);
        for (uint256 i = 1; i <= 3; i++) {
            writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.EscrowCompleted, 1_000_000, bytes32(i), payer);
        }
        writer.record(AGENT_ID, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, bytes32(uint256(4)), payer);
        assertEq(repRegistry.disputeRate(AGENT_ID), 5_000, "cap 2: 10000/2");

        vm.expectRevert(Four02ReputationRegistryV2.BadPairCap.selector);
        repRegistry.setPairCompletionCap(1001);

        vm.prank(stranger);
        vm.expectRevert();
        repRegistry.setPairCompletionCap(2);
    }

    // ------------------------------------------------------------------------
    // F2 — disputeRate zero-denominator
    // ------------------------------------------------------------------------

    function test_DisputeRate_GhostOnlyThroughEscrowIsMaxed() public {
        BountyEscrow e = _deploy(0, 0, 0);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.warp(block.timestamp + 1 days + REFUND_DELAY + 1);
        e.refund(jobId); // ghost: WorkerGhosted, zero completed commerce
        assertEq(repRegistry.disputeRate(AGENT_ID), 10_000, "ghost-only worker shows max, not 0");
    }

    // ------------------------------------------------------------------------
    // F3 — claim stake
    // ------------------------------------------------------------------------

    function test_Stake_HonestReleaseReturnsStake() public {
        BountyEscrow e = _deploy(STAKE, 0, 0);
        uint256 jobId = _fundedJob(e, STAKE, 0);
        _complete(e, jobId);
        assertEq(e.claimable(jobId, worker), EXPECTED_PROVIDER + STAKE, "provider gets share + stake back");
        assertEq(e.claimable(jobId, feeRecipient), EXPECTED_FEE, "fee unaffected");
        assertEq(e.totalReserved(), JOB_AMOUNT + STAKE, "reserve covers bounty + stake until claimed");
    }

    function test_Stake_ClaimRevertsWithoutStakeApproval() public {
        BountyEscrow e = _deploy(STAKE, 0, 0);
        usdc.mint(payer, JOB_AMOUNT);
        vm.prank(payer);
        usdc.approve(address(e), JOB_AMOUNT);
        vm.prank(payer);
        uint256 jobId = e.createBounty(JOB_AMOUNT, uint64(block.timestamp + 1 days), keccak256("spec"));
        // Worker never approved the stake pull.
        vm.prank(worker);
        vm.expectRevert("mUSDC: allowance");
        e.claimBounty(jobId, AGENT_ID);
    }

    function test_Stake_GhostSlashesStakeToPayer() public {
        BountyEscrow e = _deploy(STAKE, 0, 0);
        uint256 jobId = _fundedJob(e, STAKE, 0);
        vm.warp(block.timestamp + 1 days + REFUND_DELAY + 1);
        e.refund(jobId);
        assertEq(e.claimable(jobId, payer), JOB_AMOUNT + STAKE, "payer gets refund + slashed stake");
        assertEq(e.claimable(jobId, worker), 0, "ghost keeps nothing");
    }

    function test_Stake_DisputeWinnerTakesStake() public {
        BountyEscrow e = _deploy(STAKE, 0, 0);
        // Provider wins (>= 5000 bps) -> stake to provider.
        uint256 jobA = _fundedJob(e, STAKE, 0);
        vm.prank(worker);
        e.raiseDispute(jobA);
        vm.prank(arbiter);
        e.resolveDispute(jobA, 6000);
        assertEq(e.claimable(jobA, worker), 60_000_000 + STAKE, "6000 bps: provider takes stake");

        // Payer wins (< 5000 bps) -> stake to payer.
        uint256 jobB = _fundedJob(e, STAKE, 0);
        vm.prank(worker);
        e.raiseDispute(jobB);
        vm.prank(arbiter);
        e.resolveDispute(jobB, 4000);
        assertEq(e.claimable(jobB, payer), 60_000_000 + STAKE, "4000 bps: payer takes stake");
    }

    // ------------------------------------------------------------------------
    // F4 — dispute bond + timeout
    // ------------------------------------------------------------------------

    function test_Bond_RaiserPostsBond() public {
        BountyEscrow e = _deploy(0, BOND, 0);
        uint256 jobId = _fundedJob(e, 0, BOND);
        uint256 balBefore = usdc.balanceOf(worker);
        vm.prank(worker);
        e.raiseDispute(jobId);
        assertEq(usdc.balanceOf(worker), balBefore - BOND, "bond pulled from raiser");
        assertEq(e.totalReserved(), JOB_AMOUNT + BOND, "reserve covers bounty + bond");
    }

    function test_Bond_WinnerTakesBond() public {
        BountyEscrow e = _deploy(0, BOND, 0);
        // Provider wins outright (> 5000) -> bond to provider.
        uint256 jobA = _fundedJob(e, 0, BOND);
        vm.prank(worker);
        e.raiseDispute(jobA);
        vm.prank(arbiter);
        e.resolveDispute(jobA, 6000);
        assertEq(e.claimable(jobA, worker), 60_000_000 + BOND, "6000 bps: provider takes bond");

        // Payer wins outright (< 5000) -> bond to payer.
        uint256 jobB = _fundedJob(e, 0, BOND);
        vm.prank(worker);
        e.raiseDispute(jobB);
        vm.prank(arbiter);
        e.resolveDispute(jobB, 4000);
        assertEq(e.claimable(jobB, payer), 60_000_000 + BOND, "4000 bps: payer takes bond");

        // Exact tie (5000) -> bond to the protocol feeRecipient.
        uint256 jobC = _fundedJob(e, 0, BOND);
        vm.prank(worker);
        e.raiseDispute(jobC);
        vm.prank(arbiter);
        e.resolveDispute(jobC, 5000);
        assertEq(e.claimable(jobC, feeRecipient), BOND, "5000 bps tie: bond to feeRecipient");
        assertEq(e.claimable(jobC, worker), 50_000_000, "5000 bps: no stake configured");
    }

    function test_Timeout_ResolvesFiftyFifty() public {
        BountyEscrow e = _deploy(STAKE, BOND, TIMEOUT);
        uint256 jobId = _fundedJob(e, STAKE, BOND);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.warp(block.timestamp + TIMEOUT + 1);

        // Either party may trigger; the provider does here.
        vm.prank(worker);
        e.resolveDisputeTimeout(jobId);

        assertEq(e.claimable(jobId, worker), 50_000_000 + STAKE, "provider: half + stake (5000 rule)");
        assertEq(e.claimable(jobId, payer), 50_000_000, "payer: half");
        assertEq(e.claimable(jobId, feeRecipient), BOND, "feeRecipient: bond on the exact tie");
        assertEq(repRegistry.disputeRate(AGENT_ID), 0, "DisputeResolved neutralizes the opened signal");
        (uint256 wins,) = repRegistry.arbitrationRecord(AGENT_ID);
        assertEq(wins, 1, "timeout split records an arbitration win (5000)");
    }

    function test_Timeout_RevertsTooEarly() public {
        BountyEscrow e = _deploy(0, 0, TIMEOUT);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.warp(block.timestamp + TIMEOUT - 1);
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        e.resolveDisputeTimeout(jobId);
    }

    function test_Timeout_RevertsWhenDisabled() public {
        BountyEscrow e = _deploy(0, 0, 0); // timeout == 0
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.warp(block.timestamp + 365 days);
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.TimeoutDisabled.selector);
        e.resolveDisputeTimeout(jobId);
    }

    function test_Timeout_RevertsForStranger() public {
        BountyEscrow e = _deploy(0, 0, TIMEOUT);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotParty.selector);
        e.resolveDisputeTimeout(jobId);
    }

    // ------------------------------------------------------------------------
    // F5 — dispute withdrawal
    // ------------------------------------------------------------------------

    function test_WithdrawDispute_RestoresFundedAndReturnsBond() public {
        BountyEscrow e = _deploy(0, BOND, 0);
        uint256 jobId = _fundedJob(e, 0, BOND);
        uint256 balBefore = usdc.balanceOf(worker);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.prank(worker);
        e.withdrawDispute(jobId);

        assertEq(uint8(e.getJob(jobId).state), uint8(BountyEscrow.JobState.Funded), "pre-dispute Funded restored");
        assertEq(usdc.balanceOf(worker), balBefore, "bond refunded to raiser");
        assertEq(repRegistry.disputeRate(AGENT_ID), 0, "DisputeWithdrawn neutralizes the signal");

        // The job is alive again: deliver + release works.
        _complete(e, jobId);
        assertEq(e.claimable(jobId, worker), EXPECTED_PROVIDER);
    }

    function test_WithdrawDispute_RestoresDelivered() public {
        BountyEscrow e = _deploy(0, 0, 0);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.confirmDelivery(jobId);
        vm.prank(payer);
        e.raiseDispute(jobId); // payer disputes a delivered job
        vm.prank(payer);
        e.withdrawDispute(jobId);

        assertEq(uint8(e.getJob(jobId).state), uint8(BountyEscrow.JobState.Delivered), "pre-dispute Delivered restored");

        vm.prank(payer);
        e.release(jobId);
        assertEq(e.claimable(jobId, worker), EXPECTED_PROVIDER, "release proceeds after withdrawal");
    }

    function test_WithdrawDispute_RevertsForNonRaiser() public {
        BountyEscrow e = _deploy(0, 0, 0);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.prank(payer); // payer is not the raiser
        vm.expectRevert(BountyEscrow.NotRaiser.selector);
        e.withdrawDispute(jobId);
    }

    function test_WithdrawDispute_RevertsWhenNotDisputed() public {
        BountyEscrow e = _deploy(0, 0, 0);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.BadState.selector);
        e.withdrawDispute(jobId);
    }

    function test_WithdrawDispute_ReDisputeAfterWithdrawal() public {
        BountyEscrow e = _deploy(0, 0, 0);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(worker);
        e.raiseDispute(jobId);
        vm.prank(worker);
        e.withdrawDispute(jobId);
        // Fresh dispute cycle works with fresh bookkeeping.
        vm.prank(payer);
        e.raiseDispute(jobId);
        vm.prank(arbiter);
        e.resolveDispute(jobId, 0);
        assertEq(e.claimable(jobId, payer), JOB_AMOUNT, "payer wins the re-raised dispute");
    }

    // ------------------------------------------------------------------------
    // F6 — payer cancel of unclaimed bounties
    // ------------------------------------------------------------------------

    function test_CancelBounty_HappyPath() public {
        BountyEscrow e = _deploy(0, 0, 0);
        usdc.mint(payer, JOB_AMOUNT);
        vm.prank(payer);
        usdc.approve(address(e), JOB_AMOUNT);
        vm.prank(payer);
        uint256 jobId = e.createBounty(JOB_AMOUNT, uint64(block.timestamp + 30 days), keccak256("spec"));

        vm.prank(payer);
        e.cancelBounty(jobId);

        assertEq(uint8(e.getJob(jobId).state), uint8(BountyEscrow.JobState.Cancelled), "state Cancelled");
        assertEq(e.claimable(jobId, payer), JOB_AMOUNT, "full funding claimable");
        assertEq(repRegistry.getEventCount(AGENT_ID), 0, "no reputation event (no worker bound)");

        uint256 balBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        e.claim(jobId);
        assertEq(usdc.balanceOf(payer), balBefore + JOB_AMOUNT, "payer recovers funds");
    }

    function test_CancelBounty_RevertsWhenClaimed() public {
        BountyEscrow e = _deploy(0, 0, 0);
        uint256 jobId = _fundedJob(e, 0, 0);
        vm.prank(payer);
        vm.expectRevert(BountyEscrow.BadState.selector);
        e.cancelBounty(jobId);
    }

    function test_CancelBounty_RevertsForNonPayer() public {
        BountyEscrow e = _deploy(0, 0, 0);
        usdc.mint(payer, JOB_AMOUNT);
        vm.prank(payer);
        usdc.approve(address(e), JOB_AMOUNT);
        vm.prank(payer);
        uint256 jobId = e.createBounty(JOB_AMOUNT, uint64(block.timestamp + 30 days), keccak256("spec"));
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotPayer.selector);
        e.cancelBounty(jobId);
    }

    function test_CancelBounty_ClaimBountyAfterCancelReverts() public {
        BountyEscrow e = _deploy(0, 0, 0);
        usdc.mint(payer, JOB_AMOUNT);
        vm.prank(payer);
        usdc.approve(address(e), JOB_AMOUNT);
        vm.prank(payer);
        uint256 jobId = e.createBounty(JOB_AMOUNT, uint64(block.timestamp + 30 days), keccak256("spec"));
        vm.prank(payer);
        e.cancelBounty(jobId);
        vm.prank(worker);
        vm.expectRevert(BountyEscrow.BadState.selector);
        e.claimBounty(jobId, AGENT_ID);
    }

}
