// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {AgentEscrow} from "../../contracts/AgentEscrow.sol";
import {Reputation} from "../../contracts/Reputation.sol";

/// @notice Mock settlement token with the two FiatTokenV2 kill-switches the
/// real native USDC has: global pause and per-address blocklist. Any transfer
/// touching a blocklisted party — or occurring while paused — reverts, which
/// is exactly how Circle's USDC behaves. Used to probe what happens to
/// escrowed funds when a party gets blocklisted mid-job.
contract FlagUSDC {
    string public name = "Flag USDC";
    string public symbol = "fUSDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocklisted;
    bool public paused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Paused();
    error Blocklisted();
    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocklisted(address a, bool flag) external {
        blocklisted[a] = flag;
    }

    function setPaused(bool p) external {
        paused = p;
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
        if (allowed < amount) revert InsufficientAllowance();
        unchecked {
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (paused) revert Paused();
        if (blocklisted[from] || blocklisted[to]) revert Blocklisted();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}

// ============================================================================
// Per-run fuzz property tests
// ============================================================================

contract AgentEscrowFuzz is Test {
    FlagUSDC internal usdc;
    AgentEscrow internal escrow;
    Reputation internal reputation;

    address internal payer = makeAddr("payer");
    address internal provider = makeAddr("provider");
    address internal arbiter = makeAddr("arbiter");
    address internal guardian = makeAddr("guardian");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant FEE_BPS = 75;
    uint64 internal constant REFUND_DELAY = 1 days; // M3 grace window

    function setUp() public {
        usdc = new FlagUSDC();
        escrow = new AgentEscrow(address(usdc), arbiter, feeRecipient, FEE_BPS, REFUND_DELAY, guardian);
        reputation = escrow.reputation();
    }

    function _mintApprove(address who, uint256 amount, AgentEscrow e) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(e), amount);
    }

    /// @notice Fee math across the full legal fee range: the protocol fee is
    /// exact, provider+fee conserve the job amount, and the fee never exceeds
    /// the 1000 bps onchain cap no matter the feeBps/amount combination.
    /// H3: release records claims; funds move only via claim().
    function testFuzz_FeeNeverExceedsCap(uint256 feeBps_, uint256 amount) public {
        feeBps_ = bound(feeBps_, 0, 1_000);
        amount = bound(amount, 1, 1_000_000_000_000); // up to 1M USDC; amount*feeBps can't overflow

        AgentEscrow e = new AgentEscrow(address(usdc), arbiter, feeRecipient, feeBps_, REFUND_DELAY, guardian);
        _mintApprove(payer, amount, e);

        vm.prank(payer);
        uint256 jobId = e.createJob(provider, amount, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(provider);
        e.confirmDelivery(jobId);

        uint256 provBefore = usdc.balanceOf(provider);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);
        vm.prank(payer);
        e.release(jobId);

        // Pull: claims are recorded, nothing moved yet.
        uint256 fee = e.claimable(jobId, feeRecipient);
        uint256 providerAmount = e.claimable(jobId, provider);
        assertEq(fee, (amount * feeBps_) / 10_000, "fee exact");
        assertEq(fee + providerAmount, amount, "release conserves funds");
        assertLe(fee, (amount * 1_000) / 10_000, "fee within onchain cap");
        assertEq(usdc.balanceOf(provider), provBefore, "release pushed funds");
        assertEq(usdc.balanceOf(feeRecipient), feeBefore, "release pushed funds");

        if (providerAmount > 0) {
            vm.prank(provider);
            e.claim(jobId);
        }
        if (fee > 0) {
            vm.prank(feeRecipient);
            e.claim(jobId);
        }
        assertEq(usdc.balanceOf(provider) - provBefore, providerAmount, "provider paid wrong");
        assertEq(usdc.balanceOf(feeRecipient) - feeBefore, fee, "fee paid wrong");
        assertEq(usdc.balanceOf(address(e)), 0, "escrow drained");
    }

    /// @notice Constructor hard-cap holds for every feeBps above the cap.
    function testFuzz_ConstructorRejectsHighFee(uint256 feeBps_) public {
        feeBps_ = bound(feeBps_, 1_001, type(uint256).max);
        vm.expectRevert(AgentEscrow.FeeTooHigh.selector);
        new AgentEscrow(address(usdc), arbiter, feeRecipient, feeBps_, REFUND_DELAY, guardian);
    }

    /// @notice Dispute splits conserve funds exactly, take no fee, and only
    /// ever record claims for the job's provider and payer. H3: funds move
    /// only via claim().
    function testFuzz_DisputeSplitConservation(uint256 amount, uint256 share) public {
        amount = bound(amount, 1, 1_000_000_000_000);
        share = bound(share, 0, 10_000);

        _mintApprove(payer, amount, escrow);

        vm.prank(payer);
        uint256 jobId = escrow.createJob(provider, amount, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(payer);
        escrow.raiseDispute(jobId);

        uint256 provBefore = usdc.balanceOf(provider);
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 strangerBefore = usdc.balanceOf(stranger);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        vm.prank(arbiter);
        escrow.resolveDispute(jobId, share);

        uint256 providerAmount = escrow.claimable(jobId, provider);
        uint256 payerAmount = escrow.claimable(jobId, payer);
        assertEq(providerAmount, (amount * share) / 10_000, "provider share exact");
        assertEq(providerAmount + payerAmount, amount, "dispute conserves funds");
        assertEq(escrow.claimable(jobId, feeRecipient), 0, "fee recorded on dispute");

        if (providerAmount > 0) {
            vm.prank(provider);
            escrow.claim(jobId);
        }
        if (payerAmount > 0) {
            vm.prank(payer);
            escrow.claim(jobId);
        }

        assertEq(usdc.balanceOf(provider) - provBefore, providerAmount, "provider paid wrong");
        assertEq(usdc.balanceOf(payer) - payerBefore, payerAmount, "payer paid wrong");
        assertEq(usdc.balanceOf(stranger), strangerBefore, "stranger touched");
        assertEq(usdc.balanceOf(feeRecipient), feeBefore, "no fee on disputes");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    /// @notice REGRESSION (M2 fixed 2026-09-22): self-dealing used to be
    /// allowed, letting anyone mint reputation completions at dust cost.
    /// createJob now reverts with SelfDealing for every amount.
    function testFuzz_SelfDealReverts(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000); // up to 1000 USDC
        _mintApprove(payer, amount, escrow);

        vm.prank(payer);
        vm.expectRevert(AgentEscrow.SelfDealing.selector);
        escrow.createJob(payer, amount, uint64(block.timestamp + 1 days), bytes32(0));

        // Nothing was recorded: the farming vector is closed.
        assertEq(reputation.completedJobs(payer), 0, "self-deal recorded a completion");
    }

    /// @notice M3: refund opens at deadline + refundDelay, never before —
    /// across random warp distances on both sides of the boundary.
    function testFuzz_RefundOnlyAfterDeadlinePlusGrace(uint256 warpBy, uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000);
        warpBy = bound(warpBy, 0, 14 days);
        uint64 deadline = uint64(block.timestamp + 7 days);

        _mintApprove(payer, amount, escrow);
        vm.prank(payer);
        uint256 jobId = escrow.createJob(provider, amount, deadline, bytes32(0));

        vm.warp(block.timestamp + warpBy);
        if (warpBy >= 7 days + REFUND_DELAY) {
            vm.prank(stranger); // permissionless: anyone may trigger
            escrow.refund(jobId);
            assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Refunded));
            // H3: refund records the payer's claim; the payer withdraws.
            assertEq(escrow.claimable(jobId, payer), amount, "payer claim not recorded");
            vm.prank(payer);
            escrow.claim(jobId);
            assertEq(usdc.balanceOf(payer), amount, "payer refunded in full");
        } else {
            vm.prank(stranger);
            vm.expectRevert(AgentEscrow.TooEarly.selector);
            escrow.refund(jobId);
        }
    }

    /// @notice H3 FIXED (was: blocklisted provider bricked release): release
    /// now records claims without touching the token, so it CANNOT revert on
    /// a blocklisted party. The provider's own claim reverts while blocklisted
    /// (their problem alone); the fee recipient still gets paid; the
    /// provider's claim stays recorded and succeeds after unblocklisting.
    function testFuzz_BlocklistedProviderDoesNotBrickOthers(uint256 amount) public {
        amount = bound(amount, 1_000_000, 1_000_000_000); // ensure fee > 0
        _mintApprove(payer, amount, escrow);

        vm.prank(payer);
        uint256 jobId = escrow.createJob(provider, amount, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(provider);
        escrow.confirmDelivery(jobId);

        usdc.setBlocklisted(provider, true);

        // Release succeeds: it records claims, it never pushes.
        vm.prank(payer);
        escrow.release(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(AgentEscrow.JobState.Released));

        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 providerAmount = amount - fee;

        // Provider's own claim reverts while blocklisted — nobody else cares.
        vm.prank(provider);
        vm.expectRevert(FlagUSDC.Blocklisted.selector);
        escrow.claim(jobId);

        // Fee recipient withdraws fine.
        uint256 feeBefore = usdc.balanceOf(feeRecipient);
        vm.prank(feeRecipient);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(feeRecipient) - feeBefore, fee, "fee payout bricked");

        // Provider's claim stays recorded; works after unblocklisting.
        assertEq(escrow.claimable(jobId, provider), providerAmount, "provider claim lost");
        usdc.setBlocklisted(provider, false);
        vm.prank(provider);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(provider), providerAmount, "provider paid wrong");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    /// @notice H3 FIXED (was: blocklisted feeRecipient bricked EVERY release —
    /// protocol-wide payout DoS): the fee is now just another claim. A
    /// blocklisted feeRecipient bricks only its own fee, never providers.
    function testFuzz_BlocklistedFeeRecipientBricksOnlyItself(uint256 amount) public {
        amount = bound(amount, 1_000_000, 1_000_000_000); // ensure fee > 0
        _mintApprove(payer, amount, escrow);

        vm.prank(payer);
        uint256 jobId = escrow.createJob(provider, amount, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(provider);
        escrow.confirmDelivery(jobId);

        usdc.setBlocklisted(feeRecipient, true);

        // Release succeeds despite the blocklisted fee recipient.
        vm.prank(payer);
        escrow.release(jobId);

        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 providerAmount = amount - fee;

        // Provider is paid normally.
        vm.prank(provider);
        escrow.claim(jobId);
        assertEq(usdc.balanceOf(provider), providerAmount, "provider payout bricked");

        // Fee recipient's own claim reverts while blocklisted — contained.
        vm.prank(feeRecipient);
        vm.expectRevert(FlagUSDC.Blocklisted.selector);
        escrow.claim(jobId);
        assertEq(escrow.claimable(jobId, feeRecipient), fee, "fee claim lost");
    }

    /// @notice H3: a blocklisted payer doesn't block the provider's dispute
    /// payout — each claim is an independent transaction.
    function testFuzz_BlocklistedPayerDoesNotBlockProviderDisputeClaim(uint256 amount, uint256 share) public {
        amount = bound(amount, 1, 1_000_000_000);
        share = bound(share, 0, 10_000);
        _mintApprove(payer, amount, escrow);

        vm.prank(payer);
        uint256 jobId = escrow.createJob(provider, amount, uint64(block.timestamp + 1 days), bytes32(0));
        vm.prank(payer);
        escrow.raiseDispute(jobId);

        usdc.setBlocklisted(payer, true);

        // Resolution records claims without touching the token: no revert.
        vm.prank(arbiter);
        escrow.resolveDispute(jobId, share);

        uint256 providerAmount = (amount * share) / 10_000;
        uint256 payerAmount = amount - providerAmount;

        if (providerAmount > 0) {
            uint256 provBefore = usdc.balanceOf(provider);
            vm.prank(provider);
            escrow.claim(jobId);
            assertEq(usdc.balanceOf(provider) - provBefore, providerAmount, "provider payout bricked");
        }
        assertEq(escrow.claimable(jobId, payer), payerAmount, "payer claim lost");
        if (payerAmount > 0) {
            vm.prank(payer);
            vm.expectRevert(FlagUSDC.Blocklisted.selector);
            escrow.claim(jobId);
        }
    }
}

// ============================================================================
// Stateful invariant suite: random op sequences against a blocklist/pausable
// token, with ghost accounting mirroring every wei. H3: terminal transitions
// RECORD claims; only claim() moves funds.
// ============================================================================

/// @notice Stateful handler driving random AgentEscrow op sequences.
/// Every op is attempted with fuzzed actors/args; reverts (wrong caller, bad
/// state, blocklisted/paused token) are swallowed and the mirror state is
/// asserted UNCHANGED. On success the mirror + ghost books are updated and
/// asserted to match the contract. Any divergence = a real bug.
contract EscrowHandler is Test {
    FlagUSDC public usdc;
    AgentEscrow public escrow;
    Reputation public reputation;

    address public arbiter;
    address public guardian;
    address public feeRecipient;
    address public bystander;
    address[] public actors;
    uint256 public nActors = 5;
    uint64 public refundDelay = 1 days; // M3 grace window

    uint256 public constant FEE_BPS = 75;

    // -- ghost books -------------------------------------------------------
    uint256 public ghostDeposited; // sum of amounts of all created jobs
    uint256 public ghostClaimed; // sum withdrawn via claim()
    uint256 public ghostFees; // sum of protocol fees RECORDED on releases
    uint256 public ghostFeesClaimed; // sum of fees withdrawn by feeRecipient
    uint256 public jobCount;
    mapping(uint256 => AgentEscrow.JobState) public expectedState;
    mapping(uint256 => bool) public settled; // terminal transition executed exactly once
    mapping(uint256 => address) public jobPayer;
    mapping(uint256 => address) public jobProvider;
    mapping(uint256 => uint256) public jobAmount;
    mapping(uint256 => uint256) public recordedFor; // total claims recorded at terminal
    mapping(uint256 => uint256) public claimedOut; // total withdrawn via claim()
    mapping(uint256 => mapping(address => uint256)) public expectedClaims;
    mapping(address => uint256) public expectedBal; // exact expected token balance per actor

    constructor() {
        usdc = new FlagUSDC();
        arbiter = makeAddr("arbiter");
        guardian = makeAddr("guardian");
        feeRecipient = makeAddr("feeRecipient");
        bystander = makeAddr("bystander");
        escrow = new AgentEscrow(address(usdc), arbiter, feeRecipient, FEE_BPS, refundDelay, guardian);
        reputation = escrow.reputation();
        for (uint256 i = 0; i < nActors; i++) {
            address a = makeAddr(string.concat("actor-", vm.toString(i)));
            actors.push(a);
            usdc.mint(a, 1_000_000_000_000); // 1M USDC each
            expectedBal[a] = 1_000_000_000_000;
            vm.prank(a);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Mirror check: contract job fields must equal the handler's books.
    function _checkJob(uint256 jobId) internal view {
        AgentEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(uint8(j.state), uint8(expectedState[jobId]), "state mirror diverged");
        assertEq(j.payer, jobPayer[jobId], "payer mirror diverged");
        assertEq(j.provider, jobProvider[jobId], "provider mirror diverged");
        assertEq(j.amount, jobAmount[jobId], "amount mirror diverged");
    }

    /// @dev Mirror check: recorded claims must equal the handler's books.
    function _checkClaims(uint256 jobId) internal view {
        assertEq(
            escrow.claimable(jobId, jobPayer[jobId]),
            expectedClaims[jobId][jobPayer[jobId]],
            "payer claim mirror diverged"
        );
        assertEq(
            escrow.claimable(jobId, jobProvider[jobId]),
            expectedClaims[jobId][jobProvider[jobId]],
            "provider claim mirror diverged"
        );
        assertEq(
            escrow.claimable(jobId, feeRecipient), expectedClaims[jobId][feeRecipient], "fee claim mirror diverged"
        );
    }

    /// @notice Sum of still-unclaimed wei for a job (handler's books).
    function unclaimedTotal(uint256 jobId) external view returns (uint256) {
        return expectedClaims[jobId][jobPayer[jobId]] + expectedClaims[jobId][jobProvider[jobId]]
            + expectedClaims[jobId][feeRecipient];
    }

    function opCreate(uint256 s1, uint256 s2, uint256 s3) public {
        address payer_ = _actor(s1);
        // sometimes self-deal (payer == provider), sometimes a different actor
        address provider_ = ((s1 >> 3) & 1 == 1) ? payer_ : _actor(s1 / 7 + 1);
        uint256 amount = bound(s2, 1, 1_000_000_000); // up to 1000 USDC
        uint64 deadline = uint64(block.timestamp + bound(s3, 1, 30 days));

        vm.prank(payer_);
        try escrow.createJob(provider_, amount, deadline, bytes32(s1)) returns (uint256 jobId) {
            jobCount++;
            assertEq(jobId, jobCount, "job ids must be sequential, no gaps");
            jobPayer[jobId] = payer_;
            jobProvider[jobId] = provider_;
            jobAmount[jobId] = amount;
            expectedState[jobId] = AgentEscrow.JobState.Funded;
            ghostDeposited += amount;
            expectedBal[payer_] -= amount;
            _checkJob(jobId);
        } catch {
            _checkJobSafe();
        }
    }

    function _checkJobSafe() internal view {
        // createJob reverted: no new job exists, nothing to check.
        // (jobCount unchanged, so all existing jobs were checked by other ops)
    }

    function opDeliver(uint256 seed) public {
        if (jobCount == 0) return;
        uint256 jobId = bound(seed, 1, jobCount);
        address caller = (seed & 1 == 1) ? jobProvider[jobId] : _actor(seed >> 1);
        vm.prank(caller);
        try escrow.confirmDelivery(jobId) {
            assertEq(caller, jobProvider[jobId], "deliver succeeded for non-provider");
            assertEq(
                uint8(expectedState[jobId]),
                uint8(AgentEscrow.JobState.Funded),
                "deliver succeeded from non-Funded state"
            );
            expectedState[jobId] = AgentEscrow.JobState.Delivered;
            _checkJob(jobId);
        } catch {
            _checkJob(jobId);
        }
    }

    function opRelease(uint256 seed) public {
        if (jobCount == 0) return;
        uint256 jobId = bound(seed, 1, jobCount);
        address caller = (seed & 1 == 1) ? jobPayer[jobId] : _actor(seed >> 1);
        vm.prank(caller);
        try escrow.release(jobId) {
            assertEq(caller, jobPayer[jobId], "release succeeded for non-payer");
            assertEq(
                uint8(expectedState[jobId]),
                uint8(AgentEscrow.JobState.Delivered),
                "release succeeded from non-Delivered state"
            );
            assertFalse(settled[jobId], "DOUBLE RECORD via release");
            settled[jobId] = true;
            expectedState[jobId] = AgentEscrow.JobState.Released;
            uint256 fee = (jobAmount[jobId] * FEE_BPS) / 10_000;
            assertLe(fee, jobAmount[jobId] / 10, "fee exceeded onchain cap");
            // H3: release records claims but moves NO funds.
            recordedFor[jobId] = jobAmount[jobId];
            expectedClaims[jobId][jobProvider[jobId]] += jobAmount[jobId] - fee;
            expectedClaims[jobId][feeRecipient] += fee;
            ghostFees += fee;
            _checkJob(jobId);
            _checkClaims(jobId);
        } catch {
            _checkJob(jobId);
        }
    }

    function opDispute(uint256 seed) public {
        if (jobCount == 0) return;
        uint256 jobId = bound(seed, 1, jobCount);
        uint256 pick = (seed >> 1) % 3;
        address caller = pick == 0 ? jobPayer[jobId] : pick == 1 ? jobProvider[jobId] : _actor(seed >> 2);
        vm.prank(caller);
        try escrow.raiseDispute(jobId) {
            assertTrue(caller == jobPayer[jobId] || caller == jobProvider[jobId], "dispute succeeded for third party");
            uint8 st = uint8(expectedState[jobId]);
            assertTrue(
                st == uint8(AgentEscrow.JobState.Funded) || st == uint8(AgentEscrow.JobState.Delivered),
                "dispute succeeded from illegal state"
            );
            expectedState[jobId] = AgentEscrow.JobState.Disputed;
            _checkJob(jobId);
        } catch {
            _checkJob(jobId);
        }
    }

    function opResolve(uint256 seed, uint256 shareSeed) public {
        if (jobCount == 0) return;
        uint256 jobId = bound(seed, 1, jobCount);
        uint256 share = bound(shareSeed, 0, 10_000);
        address caller = (seed & 1 == 1) ? arbiter : _actor(seed >> 1);
        vm.prank(caller);
        try escrow.resolveDispute(jobId, share) {
            assertEq(caller, arbiter, "resolve succeeded for non-arbiter");
            assertEq(
                uint8(expectedState[jobId]),
                uint8(AgentEscrow.JobState.Disputed),
                "resolve succeeded from non-Disputed state"
            );
            assertFalse(settled[jobId], "DOUBLE RECORD via resolveDispute");
            settled[jobId] = true;
            expectedState[jobId] = AgentEscrow.JobState.Resolved;
            uint256 providerAmount = (jobAmount[jobId] * share) / 10_000;
            uint256 payerAmount = jobAmount[jobId] - providerAmount;
            // H3: resolution records claims but moves NO funds.
            recordedFor[jobId] = jobAmount[jobId];
            expectedClaims[jobId][jobProvider[jobId]] += providerAmount;
            expectedClaims[jobId][jobPayer[jobId]] += payerAmount;
            _checkJob(jobId);
            _checkClaims(jobId);
        } catch {
            _checkJob(jobId);
        }
    }

    function opRefund(uint256 seed) public {
        if (jobCount == 0) return;
        uint256 jobId = bound(seed, 1, jobCount);
        address caller = _actor(seed); // permissionless: anyone may trigger
        vm.prank(caller);
        try escrow.refund(jobId) {
            assertEq(
                uint8(expectedState[jobId]),
                uint8(AgentEscrow.JobState.Funded),
                "refund succeeded from non-Funded state"
            );
            // M3: refund opens at deadline + refundDelay.
            assertGe(
                block.timestamp,
                uint256(escrow.getJob(jobId).deadline) + refundDelay,
                "refund succeeded before deadline+grace"
            );
            assertFalse(settled[jobId], "DOUBLE RECORD via refund");
            settled[jobId] = true;
            expectedState[jobId] = AgentEscrow.JobState.Refunded;
            // H3: refund records the payer's claim but moves NO funds.
            recordedFor[jobId] = jobAmount[jobId];
            expectedClaims[jobId][jobPayer[jobId]] += jobAmount[jobId];
            _checkJob(jobId);
            _checkClaims(jobId);
        } catch {
            _checkJob(jobId);
        }
    }

    /// @notice H3: the only fund-moving op. Withdraws the caller's recorded
    /// claim; reverts leave the books untouched (NothingToClaim, or the
    /// token blocking a blocklisted/paused claimant).
    function opClaim(uint256 seed) public {
        if (jobCount == 0) return;
        uint256 jobId = bound(seed, 1, jobCount);
        // Usually the rightful payee, sometimes a random actor (must revert).
        uint256 pick = (seed >> 8) % 4;
        address caller =
            pick == 0 ? jobProvider[jobId] : pick == 1 ? jobPayer[jobId] : pick == 2 ? feeRecipient : _actor(seed >> 2);
        uint256 recorded = expectedClaims[jobId][caller];
        uint256 balBefore = usdc.balanceOf(caller);
        vm.prank(caller);
        try escrow.claim(jobId) {
            assertGt(recorded, 0, "claim succeeded with no recorded claim");
            assertEq(escrow.claimable(jobId, caller), 0, "claim not zeroed");
            assertEq(usdc.balanceOf(caller), balBefore + recorded, "claim paid wrong amount");
            expectedClaims[jobId][caller] = 0;
            claimedOut[jobId] += recorded;
            ghostClaimed += recorded;
            if (caller == feeRecipient) {
                ghostFeesClaimed += recorded;
            } else {
                expectedBal[caller] += recorded;
            }
            _checkJob(jobId);
            _checkClaims(jobId);
        } catch {
            // Either no claim was recorded, or the token blocked the payout
            // (blocklisted/paused). Either way the recorded claim is untouched.
            assertEq(escrow.claimable(jobId, caller), recorded, "failed claim altered books");
            _checkJob(jobId);
        }
    }

    function opWarp(uint256 seed) public {
        vm.warp(block.timestamp + bound(seed, 0, 30 days));
    }

    function opBlocklistActor(uint256 seed, bool flag) public {
        usdc.setBlocklisted(_actor(seed), flag);
    }

    function opBlocklistFeeRecipient(bool flag) public {
        usdc.setBlocklisted(feeRecipient, flag);
    }

    function opPause(bool p) public {
        usdc.setPaused(p);
    }
}

contract AgentEscrowInvariants is Test {
    EscrowHandler internal h;

    function setUp() public {
        h = new EscrowHandler();
        targetContract(address(h));
    }

    /// @notice Conservation of funds: every wei deposited is either still in
    /// escrow (including unclaimed claims) or was withdrawn via claim().
    /// Holds across blocklists, pauses, reverts, and adversarial interleavings.
    function invariant_ConservationOfFunds() public view {
        assertEq(
            h.usdc().balanceOf(address(h.escrow())) + h.ghostClaimed(), h.ghostDeposited(), "conservation violated"
        );
    }

    /// @notice Exact per-accounting: every actor's real balance equals the
    /// ghost books to the wei. Any payment to an unexpected address
    /// (misdirected payout, fee skim, third-party leak) breaks this.
    /// In particular the bystander and arbiter must never receive anything.
    function invariant_ActorBalancesExact() public view {
        for (uint256 i = 0; i < h.nActors(); i++) {
            address a = h.actors(i);
            assertEq(h.usdc().balanceOf(a), h.expectedBal(a), "actor balance diverged");
        }
        assertEq(h.usdc().balanceOf(h.feeRecipient()), h.ghostFeesClaimed(), "feeRecipient balance diverged");
        assertEq(h.usdc().balanceOf(h.bystander()), 0, "bystander received funds");
        assertEq(h.usdc().balanceOf(h.arbiter()), 0, "arbiter received funds");
    }

    /// @notice State machine integrity: contract state always matches the
    /// legal-transition mirror, and settled <=> terminal state (no terminal
    /// transition can execute twice, no payout recording from a
    /// non-terminal state).
    function invariant_StateMachineIntegrity() public view {
        uint256 n = h.jobCount();
        for (uint256 id = 1; id <= n; id++) {
            AgentEscrow.Job memory j = h.escrow().getJob(id);
            assertEq(uint8(j.state), uint8(h.expectedState(id)), "state mirror diverged");
            bool terminal = j.state == AgentEscrow.JobState.Released || j.state == AgentEscrow.JobState.Resolved
                || j.state == AgentEscrow.JobState.Refunded;
            assertEq(h.settled(id), terminal, "settled must equal terminal");
        }
    }

    /// @notice Pull-payment claim accounting: for every job, recorded claims
    /// always equal withdrawn + still-unclaimed, and recorded claims can never
    /// exceed the job amount. A claim can never pay more than recorded, and
    /// double-claim is impossible (zeroed before transfer).
    function invariant_ClaimAccounting() public view {
        uint256 n = h.jobCount();
        for (uint256 id = 1; id <= n; id++) {
            assertEq(h.recordedFor(id), h.claimedOut(id) + h.unclaimedTotal(id), "claim books diverged");
            assertLe(h.recordedFor(id), h.jobAmount(id), "recorded claims exceed job amount");
        }
    }

    /// @notice Total protocol fees can never exceed the 10% onchain cap of
    /// total deposits, regardless of interleaving; claimed fees can never
    /// exceed recorded fees.
    function invariant_FeesWithinCap() public view {
        assertLe(h.ghostFees(), h.ghostDeposited() / 10, "fees exceeded onchain cap");
        assertLe(h.ghostFeesClaimed(), h.ghostFees(), "claimed fees exceeded recorded fees");
    }

    /// @notice Reputation scores stay within bps bounds for all actors.
    function invariant_ReputationScoreBounded() public view {
        for (uint256 i = 0; i < h.nActors(); i++) {
            assertLe(h.reputation().score(h.actors(i)), 10_000, "score out of bps bounds");
        }
    }
}
