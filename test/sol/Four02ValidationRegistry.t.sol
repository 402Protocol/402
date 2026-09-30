// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {Four02ValidationRegistry} from "../../contracts/Four02ValidationRegistry.sol";

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

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "mUSDC: balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}

/// @notice Mock ERC-8004 identity registry: ownerOf is a test-controlled map.
contract MockIdentityRegistry {
    mapping(uint256 => address) internal owners;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }
}

/// @notice Mock BountyEscrow: test-controlled jobs, records resolveDispute calls.
/// @dev Exposes getJob (NOT jobs) to mirror the real BountyEscrow, whose
///      `jobs` mapping is private. A mock implementing a non-existent `jobs()`
///      once concealed a ship-blocking interface bug — never again.
contract MockEscrow {
    struct JobData {
        address payer;
        address provider;
        uint256 agentId;
        uint8 state;
    }

    mapping(uint256 => JobData) public jobData;
    address public arbiterAddr;

    uint256 public lastResolvedJob;
    uint256 public lastResolvedBps;
    uint256 public resolveCount;

    function setArbiter(address a) external {
        arbiterAddr = a;
    }

    function arbiter() external view returns (address) {
        return arbiterAddr;
    }

    function setJob(uint256 jobId, address payer, address provider, uint256 agentId, uint8 state) external {
        jobData[jobId] = JobData(payer, provider, agentId, state);
    }

    function setJobState(uint256 jobId, uint8 state) external {
        jobData[jobId].state = state;
    }

    function getJob(uint256 jobId)
        external
        view
        returns (
            address payer,
            address provider,
            uint256 agentId,
            uint256 amount,
            uint64 deadline,
            bytes32 termsHash,
            uint8 state,
            uint64 disputedAt,
            address disputeRaiser,
            uint8 preDisputeState
        )
    {
        JobData storage j = jobData[jobId];
        return (j.payer, j.provider, j.agentId, 0, 0, bytes32(0), j.state, 0, address(0), 0);
    }

    function resolveDispute(uint256 jobId, uint256 providerShareBps) external {
        require(msg.sender == arbiterAddr, "mock: not arbiter");
        require(jobData[jobId].state == 5, "mock: not disputed");
        lastResolvedJob = jobId;
        lastResolvedBps = providerShareBps;
        resolveCount += 1;
        jobData[jobId].state = 6; // Resolved
    }
}

/// @notice Malicious token: tries to reenter claimRewards() once when armed.
contract ReenteringUSDC is MockUSDC {
    Four02ValidationRegistry internal reg;
    bool internal attackNext;

    function setRegistry(Four02ValidationRegistry r) external {
        reg = r;
    }

    function armAttack() external {
        attackNext = true;
    }

    function _move(address from, address to, uint256 amount) internal override {
        if (attackNext) {
            attackNext = false;
            // Attempt reentry; the guard must make this fail while the outer call survives.
            (bool ok,) = address(reg).call(abi.encodeWithSignature("claimRewards()"));
            require(!ok, "reentry guard failed");
        }
        super._move(from, to, amount);
    }
}

contract Four02ValidationRegistryTest is Test {
    MockUSDC internal usdc;
    MockIdentityRegistry internal identityRegistry;
    MockEscrow internal escrow;
    Four02ValidationRegistry internal reg;

    address internal humanFallback = makeAddr("humanFallback");
    address internal v1 = makeAddr("v1");
    address internal v2 = makeAddr("v2");
    address internal v3 = makeAddr("v3");
    address internal v4 = makeAddr("v4");
    address internal v5 = makeAddr("v5");
    address internal requester = makeAddr("requester");
    address internal payer = makeAddr("payer");
    address internal provider = makeAddr("provider");

    uint256 internal constant MIN_STAKE = 100_000_000; // $100
    uint256 internal constant CASE_FEE = 1_000_000; // $1
    uint256 internal constant VOTE_BOND = 5_000_000; // $5
    uint8 internal constant DISPUTED = 5;

    function setUp() public {
        usdc = new MockUSDC();
        identityRegistry = new MockIdentityRegistry();
        escrow = new MockEscrow();

        reg = new Four02ValidationRegistry(
            address(usdc),
            address(escrow),
            address(identityRegistry),
            humanFallback,
            MIN_STAKE,
            7 days,
            3 days,
            4 days,
            3, // quorum
            20, // honest band
            1000, // 10% slash
            CASE_FEE,
            VOTE_BOND
        );

        // Fund validators and bind agentIds 1..5.
        address[5] memory vs = [v1, v2, v3, v4, v5];
        for (uint256 i = 0; i < 5; i++) {
            usdc.mint(vs[i], 10_000_000_000);
            identityRegistry.setOwner(i + 1, vs[i]);
            vm.startPrank(vs[i]);
            usdc.approve(address(reg), type(uint256).max);
            reg.stake(MIN_STAKE, i + 1);
            vm.stopPrank();
        }
        usdc.mint(requester, 10_000_000_000);
        vm.prank(requester);
        usdc.approve(address(reg), type(uint256).max);
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _commit(address voter, uint256 requestId, uint8 score, bytes32 salt) internal {
        vm.prank(voter);
        reg.commitVote(requestId, keccak256(abi.encodePacked(score, salt)));
    }

    function _reveal(address voter, uint256 requestId, uint8 score, bytes32 salt) internal {
        vm.prank(voter);
        reg.revealVote(requestId, score, salt);
    }

    /// @notice Run a full validation round; returns requestId.
    function _fullRound(uint8[5] memory scores) internal returns (uint256 requestId) {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        requestId = reg.requestValidation(99, "ipfs://evidence");
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xdead));
        for (uint256 i = 0; i < 5; i++) {
            _commit(vs[i], requestId, scores[i], salt);
        }
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) {
            _reveal(vs[i], requestId, scores[i], salt);
        }
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(requestId);
    }

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(Four02ValidationRegistry.ZeroAddress.selector);
        new Four02ValidationRegistry(
            address(0), address(escrow), address(identityRegistry), humanFallback, MIN_STAKE, 7 days, 3 days, 4 days,
            3, 20, 1000, CASE_FEE, VOTE_BOND
        );
    }

    function test_constructor_rejectsZeroWindows() public {
        vm.expectRevert(Four02ValidationRegistry.ZeroAddress.selector);
        new Four02ValidationRegistry(
            address(usdc), address(escrow), address(identityRegistry), humanFallback, MIN_STAKE, 7 days, 0, 4 days,
            3, 20, 1000, CASE_FEE, VOTE_BOND
        );
    }

    function test_constructor_rejectsSlashOver10000() public {
        vm.expectRevert(Four02ValidationRegistry.SlashTooHigh.selector);
        new Four02ValidationRegistry(
            address(usdc), address(escrow), address(identityRegistry), humanFallback, MIN_STAKE, 7 days, 3 days, 4 days,
            3, 20, 10001, CASE_FEE, VOTE_BOND
        );
    }

    // ------------------------------------------------------------------------
    // Staking
    // ------------------------------------------------------------------------

    function test_stake_belowMinReverts() public {
        address fresh = makeAddr("fresh");
        usdc.mint(fresh, MIN_STAKE);
        identityRegistry.setOwner(77, fresh);
        vm.startPrank(fresh);
        usdc.approve(address(reg), type(uint256).max);
        vm.expectRevert(Four02ValidationRegistry.BelowMinStake.selector);
        reg.stake(MIN_STAKE - 1, 77);
        vm.stopPrank();
    }

    function test_stake_zeroAgentReverts() public {
        address fresh = makeAddr("fresh");
        usdc.mint(fresh, MIN_STAKE);
        vm.startPrank(fresh);
        usdc.approve(address(reg), type(uint256).max);
        vm.expectRevert(Four02ValidationRegistry.AgentNotFound.selector);
        reg.stake(MIN_STAKE, 0);
        vm.stopPrank();
    }

    function test_stake_unownedAgentReverts() public {
        address fresh = makeAddr("fresh");
        usdc.mint(fresh, MIN_STAKE);
        identityRegistry.setOwner(78, makeAddr("someoneElse"));
        vm.startPrank(fresh);
        usdc.approve(address(reg), type(uint256).max);
        vm.expectRevert(Four02ValidationRegistry.NotAgentOwner.selector);
        reg.stake(MIN_STAKE, 78);
        vm.stopPrank();
    }

    function test_stake_secondIdentityReverts() public {
        identityRegistry.setOwner(100, v1);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.NotAgentOwner.selector);
        reg.stake(MIN_STAKE, 100); // v1 already bound to agent 1
    }

    function test_stake_topUpWorks() public {
        uint256 before = usdc.balanceOf(address(reg));
        vm.prank(v1);
        reg.stake(MIN_STAKE, 1);
        (uint256 stake,,,) = reg.validators(v1);
        assertEq(stake, 2 * MIN_STAKE);
        assertEq(usdc.balanceOf(address(reg)), before + MIN_STAKE);
    }

    function test_unstake_fullCycle() public {
        vm.prank(v1);
        reg.requestUnstake();
        vm.warp(block.timestamp + 7 days);
        uint256 balBefore = usdc.balanceOf(v1);
        vm.prank(v1);
        reg.withdrawUnstake();
        assertEq(usdc.balanceOf(v1), balBefore + MIN_STAKE);
        (uint256 stake,,,) = reg.validators(v1);
        assertEq(stake, 0);
    }

    function test_unstake_tooEarlyReverts() public {
        vm.prank(v1);
        reg.requestUnstake();
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.UnstakeTooEarly.selector);
        reg.withdrawUnstake();
    }

    function test_unstake_blockedByActiveCommitment() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        _commit(v1, rid, 80, bytes32(uint256(1)));

        vm.prank(v1);
        reg.requestUnstake();
        vm.warp(block.timestamp + 30 days); // delay long passed
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.HasActiveCommitments.selector);
        reg.withdrawUnstake();

        // v1 can finalize the stuck request themselves (permissionless resolve)...
        // still in commit window here, so warp past reveal end with no reveals -> Failed
        vm.warp(block.timestamp + 8 days);
        reg.resolveRequest(rid);
        // ...then withdraw works
        vm.prank(v1);
        reg.withdrawUnstake();
        (uint256 stake,,,) = reg.validators(v1);
        assertEq(stake, 0);
    }

    function test_stake_cancelsPendingUnstake() public {
        vm.prank(v1);
        reg.requestUnstake();
        vm.prank(v1);
        reg.stake(MIN_STAKE, 1); // cancels
        vm.warp(block.timestamp + 30 days);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.NotUnstaking.selector);
        reg.withdrawUnstake();
    }

    function test_unstakingValidatorCannotCommit() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        vm.prank(v1);
        reg.requestUnstake();
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.AlreadyUnstaking.selector);
        reg.commitVote(rid, bytes32(uint256(1)));
    }

    // ------------------------------------------------------------------------
    // requestValidation
    // ------------------------------------------------------------------------

    function test_requestValidation_unknownAgentReverts() public {
        vm.prank(requester);
        vm.expectRevert(Four02ValidationRegistry.AgentNotFound.selector);
        reg.requestValidation(12345, "ipfs://e");
    }

    function test_requestValidation_collectsFee() public {
        identityRegistry.setOwner(99, requester);
        uint256 regBal = usdc.balanceOf(address(reg));
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        assertEq(rid, 1);
        assertEq(usdc.balanceOf(address(reg)), regBal + CASE_FEE);
    }

    // ------------------------------------------------------------------------
    // openDisputeCase
    // ------------------------------------------------------------------------

    function _disputedJob(uint256 jobId) internal {
        escrow.setJob(jobId, payer, provider, 42, DISPUTED);
        identityRegistry.setOwner(42, provider);
    }

    function test_openDisputeCase_nonDisputedReverts() public {
        escrow.setJob(7, payer, provider, 42, 2); // Funded, not Disputed
        vm.prank(requester);
        vm.expectRevert(Four02ValidationRegistry.JobNotDisputed.selector);
        reg.openDisputeCase(7);
    }

    function test_openDisputeCase_doubleOpenReverts() public {
        _disputedJob(7);
        vm.prank(requester);
        reg.openDisputeCase(7);
        vm.prank(requester);
        vm.expectRevert(Four02ValidationRegistry.CaseAlreadyOpen.selector);
        reg.openDisputeCase(7);
    }

    function test_openDisputeCase_afterFailedAllowsNew() public {
        _disputedJob(7);
        vm.prank(requester);
        uint256 rid1 = reg.openDisputeCase(7);
        // no votes -> Failed
        vm.warp(block.timestamp + 8 days);
        reg.resolveRequest(rid1);
        vm.prank(requester);
        usdc.approve(address(reg), type(uint256).max);
        vm.prank(requester);
        uint256 rid2 = reg.openDisputeCase(7);
        assertTrue(rid2 != rid1);
    }

    // ------------------------------------------------------------------------
    // Commit / reveal
    // ------------------------------------------------------------------------

    function test_commit_nonValidatorReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        vm.prank(requester);
        vm.expectRevert(Four02ValidationRegistry.NotValidator.selector);
        reg.commitVote(rid, bytes32(uint256(1)));
    }

    function test_commit_doubleCommitReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        _commit(v1, rid, 80, bytes32(uint256(1)));
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.AlreadyCommitted.selector);
        reg.commitVote(rid, bytes32(uint256(2)));
    }

    function test_commit_afterWindowReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.CommitClosed.selector);
        reg.commitVote(rid, bytes32(uint256(1)));
    }

    function test_reveal_beforeCommitEndReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        _commit(v1, rid, 80, bytes32(uint256(1)));
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.RevealNotOpen.selector);
        reg.revealVote(rid, 80, bytes32(uint256(1)));
    }

    function test_reveal_wrongSaltReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        _commit(v1, rid, 80, bytes32(uint256(1)));
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.BadCommitment.selector);
        reg.revealVote(rid, 80, bytes32(uint256(2)));
    }

    function test_reveal_scoreTooHighReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        _commit(v1, rid, 101, bytes32(uint256(1)));
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.ScoreTooHigh.selector);
        reg.revealVote(rid, 101, bytes32(uint256(1)));
    }

    function test_commit_selfValidationReverts() public {
        _disputedJob(7);
        // payer is not a validator; make payer a validator via provider's agent? Use provider:
        // provider owns agent 42; stake provider as validator
        usdc.mint(provider, MIN_STAKE);
        vm.startPrank(provider);
        usdc.approve(address(reg), type(uint256).max);
        reg.stake(MIN_STAKE, 42);
        vm.stopPrank();

        vm.prank(requester);
        uint256 rid = reg.openDisputeCase(7);
        vm.prank(provider);
        vm.expectRevert(Four02ValidationRegistry.SelfValidation.selector);
        reg.commitVote(rid, bytes32(uint256(1)));
    }

    // ------------------------------------------------------------------------
    // Resolution: median + incentives
    // ------------------------------------------------------------------------

    function test_resolve_medianOdd() public {
        // scores: 60 70 80 90 100 -> median 80
        uint256 rid = _fullRound([uint8(60), uint8(70), uint8(80), uint8(90), uint8(100)]);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 80);
    }

    function test_resolve_medianEvenCount() public {
        // 4 reveals (v5 doesn't reveal): 60 70 80 90 -> median (70+80)/2 = 75
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        address[4] memory vs = [v1, v2, v3, v4];
        uint8[4] memory scores = [uint8(60), uint8(70), uint8(80), uint8(90)];
        bytes32 salt = bytes32(uint256(0xbeef));
        for (uint256 i = 0; i < 4; i++) _commit(vs[i], rid, scores[i], salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 4; i++) _reveal(vs[i], rid, scores[i], salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 75);
    }

    function test_resolve_medianEvenRoundsDown() public {
        // 60 61 80 90 -> (61+80)/2 = 70.5 -> 70
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        address[4] memory vs = [v1, v2, v3, v4];
        uint8[4] memory scores = [uint8(60), uint8(61), uint8(80), uint8(90)];
        bytes32 salt = bytes32(uint256(0xbeef));
        for (uint256 i = 0; i < 4; i++) _commit(vs[i], rid, scores[i], salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 4; i++) _reveal(vs[i], rid, scores[i], salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 70);
    }

    function test_resolve_outlierCannotMoveMedian() public {
        // 4 honest at 70, 1 bribed at 0 -> median still 70
        uint256 rid = _fullRound([uint8(70), uint8(70), uint8(70), uint8(70), uint8(0)]);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 70);
    }

    function test_resolve_bribedMinoritySlashes() public {
        // median 70; the 0-voter is 70 away -> slashed 10% of $100 = $10
        _fullRound([uint8(70), uint8(70), uint8(70), uint8(70), uint8(0)]);
        (uint256 stake5,,,) = reg.validators(v5);
        assertEq(stake5, MIN_STAKE - MIN_STAKE / 10);
    }

    function test_resolve_honestBandBoundary() public {
        // median 70; band 20: score 50 honest (distance 20), score 49 slashed (21)
        // scores: 50 70 70 90 49 -> sorted 49 50 70 70 90 -> median 70
        _fullRound([uint8(50), uint8(70), uint8(70), uint8(90), uint8(49)]);
        (uint256 stake1,,,) = reg.validators(v1); // scored 50 -> honest, no slash
        (uint256 stake5,,,) = reg.validators(v5); // scored 49 -> slashed
        assertEq(stake1, MIN_STAKE);
        assertEq(stake5, MIN_STAKE - MIN_STAKE / 10);
    }

    function test_resolve_rewardsEqualSplit() public {
        // 4 honest (70), 1 dishonest (0): pool = $1 fee + $10 slash = $11; share = $11/4
        uint256 rid = _fullRound([uint8(70), uint8(70), uint8(70), uint8(70), uint8(0)]);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 70);
        uint256 expected = (CASE_FEE + MIN_STAKE / 10) / 4;
        assertEq(reg.pendingRewards(v1), expected);
        assertEq(reg.pendingRewards(v5), 0); // dishonest gets nothing
    }

    function test_claimRewards_pullPayment() public {
        _fullRound([uint8(70), uint8(70), uint8(70), uint8(70), uint8(0)]);
        uint256 expected = reg.pendingRewards(v1);
        uint256 balBefore = usdc.balanceOf(v1);
        vm.prank(v1);
        reg.claimRewards();
        assertEq(usdc.balanceOf(v1), balBefore + expected);
        assertEq(reg.pendingRewards(v1), 0);
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.NothingToClaim.selector);
        reg.claimRewards();
    }

    function test_resolve_noQuorumRefundsFee() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        // only 2 reveals < quorum 3
        _commit(v1, rid, 70, bytes32(uint256(1)));
        _commit(v2, rid, 70, bytes32(uint256(1)));
        vm.warp(block.timestamp + 3 days + 1);
        _reveal(v1, rid, 70, bytes32(uint256(1)));
        _reveal(v2, rid, 70, bytes32(uint256(1)));
        vm.warp(block.timestamp + 4 days + 1);
        uint256 balBefore = usdc.balanceOf(requester);
        reg.resolveRequest(rid);
        (,, Four02ValidationRegistry.RequestStatus status) = reg.getRequestResult(rid);
        assertTrue(status == Four02ValidationRegistry.RequestStatus.Failed);
        assertEq(usdc.balanceOf(requester), balBefore + CASE_FEE);
    }

    function test_resolve_tooEarlyReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        vm.expectRevert(Four02ValidationRegistry.ResolveTooEarly.selector);
        reg.resolveRequest(rid);
    }

    // ------------------------------------------------------------------------
    // Dispute integration
    // ------------------------------------------------------------------------

    function test_dispute_resolveCallsEscrowWhenArbiter() public {
        _disputedJob(7);
        escrow.setArbiter(address(reg)); // registry IS the arbiter
        vm.prank(requester);
        uint256 rid = reg.openDisputeCase(7);
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xaaa));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid);
        assertEq(escrow.lastResolvedJob(), 7);
        assertEq(escrow.lastResolvedBps(), 7000); // median 70 * 100
        assertEq(escrow.resolveCount(), 1);
    }

    function test_dispute_advisoryWhenNotArbiter() public {
        _disputedJob(7);
        escrow.setArbiter(humanFallback); // human still arbiter: phased rollout
        vm.prank(requester);
        uint256 rid = reg.openDisputeCase(7);
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xaaa));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid); // must NOT revert; escrow untouched
        assertEq(escrow.resolveCount(), 0);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 70);
    }

    function test_dispute_jobWithdrawnVoidsInsteadOfRevert() public {
        _disputedJob(7);
        escrow.setArbiter(address(reg));
        vm.prank(requester);
        uint256 rid = reg.openDisputeCase(7);
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xaaa));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid, 70, salt);
        // parties reconcile offchain; escrow job leaves Disputed (mock: back to Delivered=3)
        escrow.setJobState(7, 3);
        vm.warp(block.timestamp + 4 days + 1);
        uint256 balBefore = usdc.balanceOf(requester);
        reg.resolveRequest(rid); // voids instead of reverting on the escrow call
        (,, Four02ValidationRegistry.RequestStatus status) = reg.getRequestResult(rid);
        assertTrue(status == Four02ValidationRegistry.RequestStatus.Voided);
        assertEq(usdc.balanceOf(requester), balBefore + CASE_FEE); // fee refunded
        assertEq(escrow.resolveCount(), 0);
    }

    // ------------------------------------------------------------------------
    // Human fallback
    // ------------------------------------------------------------------------

    function test_humanFallback_nonHumanReverts() public {
        _disputedJob(7);
        escrow.setArbiter(address(reg));
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.NotHumanFallback.selector);
        reg.resolveAsHuman(7, 5000);
    }

    function test_humanFallback_blockedWhileVoting() public {
        _disputedJob(7);
        escrow.setArbiter(address(reg));
        vm.prank(requester);
        reg.openDisputeCase(7);
        vm.prank(humanFallback);
        vm.expectRevert(Four02ValidationRegistry.VotingActive.selector);
        reg.resolveAsHuman(7, 5000);
    }

    function test_humanFallback_worksAfterFailedQuorum() public {
        _disputedJob(7);
        escrow.setArbiter(address(reg));
        vm.prank(requester);
        uint256 rid = reg.openDisputeCase(7);
        vm.warp(block.timestamp + 8 days);
        reg.resolveRequest(rid); // Failed, fee refunded
        vm.prank(humanFallback);
        reg.resolveAsHuman(7, 5000);
        assertEq(escrow.lastResolvedJob(), 7);
        assertEq(escrow.lastResolvedBps(), 5000);
    }

    function test_humanFallback_worksWithNoCase() public {
        _disputedJob(9);
        escrow.setArbiter(address(reg));
        vm.prank(humanFallback);
        reg.resolveAsHuman(9, 10000);
        assertEq(escrow.lastResolvedBps(), 10000);
    }

    function test_humanFallback_cannotOverrideConsensus() public {
        _disputedJob(7);
        escrow.setArbiter(address(reg));
        vm.prank(requester);
        uint256 rid = reg.openDisputeCase(7);
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xaaa));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid); // validators resolved at 7000; mock escrow marks Resolved
        vm.prank(humanFallback);
        vm.expectRevert(); // mock escrow: job no longer Disputed... (mock resolveDispute doesn't check state)
        reg.resolveAsHuman(7, 0);
    }

    // ------------------------------------------------------------------------
    // Adversarial
    // ------------------------------------------------------------------------

    function test_adversarial_bribedMajorityNeededToMoveMedian() public {
        // 3 of 5 bribed to 100, 2 honest at 70 -> median 100 (briber wins this round,
        // but paid 3 stakes + risks slash if honest majority had held)
        uint256 rid = _fullRound([uint8(70), uint8(70), uint8(100), uint8(100), uint8(100)]);
        (uint8 median,,) = reg.getRequestResult(rid);
        assertEq(median, 100);
        // the 2 honest are now "dishonest" vs the corrupt median -> slashed.
        // This documents the 51% assumption: median is safe iff a majority is honest.
        (uint256 stake1,,,) = reg.validators(v1);
        assertEq(stake1, MIN_STAKE - MIN_STAKE / 10);
    }

    function test_adversarial_lastMinuteTopUpDoesNotFarmRewards() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xaaa));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid, 70, salt);
        // v1 tops up 10x right before resolution to try to farm a bigger share
        usdc.mint(v1, 10 * MIN_STAKE);
        vm.startPrank(v1);
        usdc.approve(address(reg), type(uint256).max);
        reg.stake(10 * MIN_STAKE, 1);
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid);
        // commit-time snapshot: v1 gets exactly the same as v2 despite the 11x
        // top-up after commit — pro-rata uses the snapshot, not live stake.
        assertEq(reg.pendingRewards(v1), reg.pendingRewards(v2));
    }

    function test_adversarial_reentrancyOnClaim() public {
        ReenteringUSDC evil = new ReenteringUSDC();
        Four02ValidationRegistry regEvil = new Four02ValidationRegistry(
            address(evil),
            address(escrow),
            address(identityRegistry),
            humanFallback,
            MIN_STAKE,
            7 days,
            3 days,
            4 days,
            3,
            20,
            1000,
            CASE_FEE,
            VOTE_BOND
        );
        evil.setRegistry(regEvil);
        evil.mint(v1, 10_000_000_000);
        evil.mint(requester, 10_000_000_000);
        identityRegistry.setOwner(99, requester);
        vm.startPrank(v1);
        evil.approve(address(regEvil), type(uint256).max);
        regEvil.stake(MIN_STAKE, 1);
        vm.stopPrank();
        vm.startPrank(requester);
        evil.approve(address(regEvil), type(uint256).max);
        uint256 rid = regEvil.requestValidation(99, "ipfs://e");
        vm.stopPrank();
        bytes32 salt = bytes32(uint256(1));
        vm.prank(v1);
        regEvil.commitVote(rid, keccak256(abi.encodePacked(uint8(70), salt)));
        // need 2 more validators for quorum (funded with stake + vote bond)
        address[2] memory extra = [v2, v3];
        for (uint256 i = 0; i < 2; i++) {
            evil.mint(extra[i], MIN_STAKE + VOTE_BOND);
            identityRegistry.setOwner(10 + i, extra[i]);
            vm.startPrank(extra[i]);
            evil.approve(address(regEvil), type(uint256).max);
            regEvil.stake(MIN_STAKE, 10 + i);
            regEvil.commitVote(rid, keccak256(abi.encodePacked(uint8(70), salt)));
            vm.stopPrank();
        }
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(v1);
        regEvil.revealVote(rid, 70, salt);
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(extra[i]);
            regEvil.revealVote(rid, 70, salt);
        }
        vm.warp(block.timestamp + 4 days + 1);
        regEvil.resolveRequest(rid);
        uint256 reward = regEvil.pendingRewards(v1);
        assertTrue(reward > 0);
        uint256 balBefore = evil.balanceOf(v1);
        evil.armAttack();
        vm.prank(v1);
        regEvil.claimRewards(); // inner reentry must fail; outer claim pays exactly once
        assertEq(evil.balanceOf(v1), balBefore + reward);
        assertEq(regEvil.pendingRewards(v1), 0);
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------

    function test_views() public {
        uint256 rid = _fullRound([uint8(60), uint8(70), uint8(80), uint8(90), uint8(100)]);
        (uint256 subjectAgentId, uint8 score, string memory uri, uint64 validatedAt) =
            reg.getValidation(rid, v3);
        assertEq(subjectAgentId, 99);
        assertEq(score, 80);
        assertEq(uri, "ipfs://evidence");
        assertTrue(validatedAt > 0);
        (uint8 median, uint256 revealCount, Four02ValidationRegistry.RequestStatus status) =
            reg.getRequestResult(rid);
        assertEq(median, 80);
        assertEq(revealCount, 5);
        assertTrue(status == Four02ValidationRegistry.RequestStatus.Resolved);
    }

    // ------------------------------------------------------------------------
    // Audit regression tests (2026-09-27: two adversarial audits)
    // ------------------------------------------------------------------------

    function test_audit_constructor_rejectsLowQuorum() public {
        vm.expectRevert(Four02ValidationRegistry.BadQuorum.selector);
        new Four02ValidationRegistry(
            address(usdc), address(escrow), address(identityRegistry), humanFallback, MIN_STAKE, 7 days, 3 days, 4 days,
            2, 20, 1000, CASE_FEE, VOTE_BOND
        );
        vm.expectRevert(Four02ValidationRegistry.BadQuorum.selector);
        new Four02ValidationRegistry(
            address(usdc), address(escrow), address(identityRegistry), humanFallback, MIN_STAKE, 7 days, 3 days, 4 days,
            0, 20, 1000, CASE_FEE, VOTE_BOND
        );
    }

    function test_audit_constructor_rejectsBandOver100() public {
        vm.expectRevert(Four02ValidationRegistry.BadHonestBand.selector);
        new Four02ValidationRegistry(
            address(usdc), address(escrow), address(identityRegistry), humanFallback, MIN_STAKE, 7 days, 3 days, 4 days,
            3, 101, 1000, CASE_FEE, VOTE_BOND
        );
    }

    function test_audit_commit_zeroCommitmentReverts() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.BadCommitment.selector);
        reg.commitVote(rid, bytes32(0));
    }

    function test_audit_commit_selfValidationGeneralReverts() public {
        // v1 owns agent 1; requesting validation of agent 1 then committing as v1
        // would manufacture a staked 100/100 record for $1. Must revert.
        identityRegistry.setOwner(1, v1); // already true from setUp; explicit for clarity
        vm.prank(requester);
        uint256 rid = reg.requestValidation(1, "ipfs://my-own-work");
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.SelfValidation.selector);
        reg.commitVote(rid, bytes32(uint256(1)));
        // another validator may still validate it
        _commit(v2, rid, 80, bytes32(uint256(1)));
    }

    function test_audit_commit_belowMinStakeCannotVote() public {
        // Slash v1 below MIN_STAKE in one round (v1 scores 0 vs median 70)...
        _fullRound([uint8(0), uint8(70), uint8(70), uint8(70), uint8(70)]);
        (uint256 stakeAfterSlash,,,) = reg.validators(v1);
        assertTrue(stakeAfterSlash < MIN_STAKE);
        // ...then v1 cannot vote until topping back up.
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e2");
        vm.prank(v1);
        vm.expectRevert(Four02ValidationRegistry.NotValidator.selector);
        reg.commitVote(rid, bytes32(uint256(1)));
        // top up back to MIN_STAKE restores voting rights
        usdc.mint(v1, MIN_STAKE);
        vm.startPrank(v1);
        usdc.approve(address(reg), type(uint256).max);
        reg.stake(MIN_STAKE - stakeAfterSlash, 1);
        reg.commitVote(rid, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_audit_bond_pulledOnCommitRefundedOnReveal() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        uint256 balBefore = usdc.balanceOf(v1);
        uint256 regBalBefore = usdc.balanceOf(address(reg));
        _commit(v1, rid, 80, bytes32(uint256(1)));
        assertEq(usdc.balanceOf(v1), balBefore - VOTE_BOND);
        assertEq(usdc.balanceOf(address(reg)), regBalBefore + VOTE_BOND);
        vm.warp(block.timestamp + 3 days + 1);
        _reveal(v1, rid, 80, bytes32(uint256(1)));
        assertEq(usdc.balanceOf(v1), balBefore); // bond refunded in full
    }

    function test_audit_bond_forfeitedToPoolOnNonReveal() public {
        // 4 honest reveal 70; v5 commits but never reveals -> its $5 bond joins the pool.
        // Pool = $1 fee + $5 bond = $6; 4 honest, equal snapshots -> $1.5 each.
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xc10c));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 4; i++) _reveal(vs[i], rid, 70, salt);
        // v5 stays silent: the selective-reveal free option now costs $5
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid);
        uint256 expected = (CASE_FEE + VOTE_BOND) / 4;
        assertEq(reg.pendingRewards(v1), expected);
        assertEq(reg.pendingRewards(v5), 0);
        // v5's stake is untouched (bond is separate from stake); only the bond was taken
        (uint256 stake5,,,) = reg.validators(v5);
        assertEq(stake5, MIN_STAKE);
    }

    function test_audit_bond_refundedOnFailed() public {
        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        uint256 balBefore = usdc.balanceOf(v1);
        _commit(v1, rid, 70, bytes32(uint256(1))); // only 1 commit < quorum 3
        vm.warp(block.timestamp + 8 days);
        reg.resolveRequest(rid); // Failed
        assertEq(usdc.balanceOf(v1), balBefore); // bond back, nothing lost
    }

    function test_audit_rewards_proRataBySnapshot() public {
        // v1 stakes 3x the others. All honest at 70. Pool = $1 fee.
        // v1 snapshot 3u, others 1u each; total 7u -> v1 gets 3/7, each other 1/7.
        usdc.mint(v1, 2 * MIN_STAKE);
        vm.startPrank(v1);
        usdc.approve(address(reg), type(uint256).max);
        reg.stake(2 * MIN_STAKE, 1); // v1 now at 3x MIN_STAKE
        vm.stopPrank();

        identityRegistry.setOwner(99, requester);
        vm.prank(requester);
        uint256 rid = reg.requestValidation(99, "ipfs://e");
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xb0b));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid, 70, salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid);
        assertEq(reg.pendingRewards(v1), (CASE_FEE * 3) / 7);
        assertEq(reg.pendingRewards(v2), CASE_FEE / 7);
    }

    function test_audit_dispute_advisoryReddisputeAllowed() public {
        // Advisory mode: case resolves as a record; job re-disputed; a FRESH case opens.
        _disputedJob(7);
        escrow.setArbiter(humanFallback);
        vm.prank(requester);
        uint256 rid1 = reg.openDisputeCase(7);
        address[5] memory vs = [v1, v2, v3, v4, v5];
        bytes32 salt = bytes32(uint256(0xaaa));
        for (uint256 i = 0; i < 5; i++) _commit(vs[i], rid1, 70, salt);
        vm.warp(block.timestamp + 3 days + 1);
        for (uint256 i = 0; i < 5; i++) _reveal(vs[i], rid1, 70, salt);
        vm.warp(block.timestamp + 4 days + 1);
        reg.resolveRequest(rid1);
        assertEq(escrow.resolveCount(), 0); // advisory: escrow untouched

        // parties re-dispute on the escrow; registry must accept a fresh case
        escrow.setJob(7, payer, provider, 42, DISPUTED);
        vm.prank(requester);
        uint256 rid2 = reg.openDisputeCase(7);
        assertTrue(rid2 != rid1);
    }

    function test_audit_dispute_doubleOpenWhileLiveReverts() public {
        _disputedJob(7);
        vm.prank(requester);
        reg.openDisputeCase(7);
        vm.prank(requester);
        vm.expectRevert(Four02ValidationRegistry.CaseAlreadyOpen.selector);
        reg.openDisputeCase(7);
    }

    /// @notice C1 regression: the registry's escrow interface must match the REAL
    ///         BountyEscrow. On a fork, calling getJob on the deployed escrow must
    ///         reach the function (reverting UnknownJob for a missing job) — the
    ///         old `jobs()` selector hit no function and reverted with empty data.
    function test_audit_fork_getJobExistsOnRealEscrow() public {
        vm.createSelectFork("https://rpc-gel.inkonchain.com");
        address realEscrow = 0xDF319a060EAA361AA906855c64CCbc941159C01C;
        vm.expectRevert(abi.encodeWithSignature("UnknownJob()"));
        Four02ValidationRegistryTest_escrowView(realEscrow).getJob(999_999);
        // Reaching UnknownJob proves the selector exists: a missing selector
        // reverts with no returndata, never with the contract's custom error.
    }
}

/// @notice Thin view wrapper so the fork test can call getJob on the real escrow
///         without deploying the registry on the fork.
interface Four02ValidationRegistryTest_escrowView {
    function getJob(uint256 jobId)
        external
        view
        returns (
            address payer,
            address provider,
            uint256 agentId,
            uint256 amount,
            uint64 deadline,
            bytes32 termsHash,
            uint8 state,
            uint64 disputedAt,
            address disputeRaiser,
            uint8 preDisputeState
        );
}
