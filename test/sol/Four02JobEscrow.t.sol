// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Four02JobEscrow} from "../../contracts/Four02JobEscrow.sol";
import {Four02SpendingPermissions} from "../../contracts/Four02SpendingPermissions.sol";

contract JobTestToken is ERC20 {
    uint8 public mode;
    address public callback;

    constructor() ERC20("Local job USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function setCallback(address value) external {
        callback = value;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) return true;
        if (mode == 3) revert("token blocked");
        if (callback != address(0)) JobReenter(callback).reenter();
        return super.transferFrom(from, to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) return true;
        if (mode == 3) revert("token blocked");
        if (callback != address(0)) JobReenter(callback).reenter();
        return super.transfer(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (mode == 4 && from != address(0) && to != address(0)) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

contract JobReenter {
    address public target;
    bytes public payload;
    bool public attempted;
    bool public succeeded;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function reenter() external {
        attempted = true;
        (succeeded,) = target.call(payload);
    }
}

contract Four02JobEscrowTest is Test {
    JobTestToken token;
    Four02JobEscrow escrow;
    address client = makeAddr("external buyer");
    address provider = makeAddr("external provider");
    address evaluator = makeAddr("external evaluator");
    address outsider = makeAddr("keeper");
    uint256 constant BUDGET = 10e6;
    bytes32 constant DELIVERABLE = keccak256("deliverable");
    bytes32 constant REASON = keccak256("evaluation");

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    function setUp() public {
        vm.warp(100 days);
        token = new JobTestToken();
        escrow = new Four02JobEscrow(address(token));
        token.mint(client, 1e15);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    function _create(address p, address e, uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = escrow.createJob(p, e, block.timestamp + 1 days, "External work specification");
        vm.prank(client);
        escrow.setBudget(id, amount);
    }

    function _fund(uint256 id, uint256 amount) internal {
        vm.prank(client);
        escrow.fund(id, amount);
    }

    function _submit(uint256 id) internal {
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
    }

    function test_createAndLateAssignmentEvents() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobCreated(1, client, address(0), evaluator, block.timestamp + 1 days);
        vm.prank(client);
        uint256 id = escrow.createJob(address(0), evaluator, block.timestamp + 1 days, "brief");
        Four02JobEscrow.Job memory job = escrow.getJob(id);
        assertEq(job.id, 1);
        assertEq(job.client, client);
        assertEq(job.evaluator, evaluator);
        assertEq(job.provider, address(0));
        assertEq(job.description, "brief");
        assertEq(job.budget, 0);
        assertEq(uint8(job.status), 0);
        assertEq(escrow.PROFILE(), "erc8183-a078cab5-no-hooks-v1");
        vm.expectEmit(true, true, false, true, address(escrow));
        emit ProviderSet(id, provider);
        vm.prank(client);
        escrow.setProvider(id, provider);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit BudgetSet(id, BUDGET);
        vm.prank(provider);
        escrow.setBudget(id, BUDGET);
        vm.prank(client);
        vm.expectRevert(Four02JobEscrow.ProviderAlreadySet.selector);
        escrow.setProvider(id, outsider);
    }

    function test_fullBudgetCompletionAndEvidenceEvents() public {
        uint256 beforeClient = token.balanceOf(client);
        uint256 id = _create(provider, evaluator, BUDGET);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobFunded(id, client, BUDGET);
        _fund(id, BUDGET);
        assertEq(escrow.totalEscrowed(), BUDGET);
        assertEq(token.balanceOf(client), beforeClient - BUDGET);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobSubmitted(id, provider, DELIVERABLE);
        _submit(id);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobCompleted(id, evaluator, REASON);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit PaymentReleased(id, provider, BUDGET);
        vm.prank(evaluator);
        escrow.complete(id, REASON);
        assertEq(token.balanceOf(provider), BUDGET);
        assertEq(token.balanceOf(evaluator), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(uint8(escrow.getJob(id).status), uint8(Four02JobEscrow.JobStatus.Completed));
    }

    function test_rejectionInAllThreeStatesPaysOnlyFundedBudget() public {
        uint256 beforeClient = token.balanceOf(client);
        for (uint256 s; s < 3; ++s) {
            uint256 id = _create(provider, evaluator, BUDGET);
            if (s > 0) _fund(id, BUDGET);
            if (s == 2) _submit(id);
            address rejector = s == 0 ? client : evaluator;
            if (s > 0) {
                vm.expectEmit(true, true, false, true, address(escrow));
                emit Refunded(id, client, BUDGET);
            }
            vm.expectEmit(true, true, false, true, address(escrow));
            emit JobRejected(id, rejector, REASON);
            vm.prank(rejector);
            escrow.reject(id, REASON);
            assertEq(token.balanceOf(client), beforeClient);
            assertEq(escrow.totalEscrowed(), 0);
        }
    }

    function test_fundingRejectsMissingProviderZeroBudgetAndChangedQuote() public {
        uint256 id = _create(address(0), evaluator, BUDGET);
        vm.expectRevert(Four02JobEscrow.ProviderNotSet.selector);
        _fund(id, BUDGET);
        vm.prank(client);
        escrow.setProvider(id, provider);
        vm.prank(provider);
        escrow.setBudget(id, BUDGET + 1);
        vm.expectRevert(Four02JobEscrow.BudgetMismatch.selector);
        _fund(id, BUDGET);
        vm.prank(client);
        escrow.setBudget(id, 0);
        vm.expectRevert(Four02JobEscrow.ZeroBudget.selector);
        _fund(id, 0);
        vm.prank(provider);
        vm.expectRevert(Four02JobEscrow.WrongStatus.selector);
        escrow.submit(id, bytes32(0));
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_creationValidationAndNoFiveMinuteMinimum() public {
        vm.expectRevert(Four02JobEscrow.InvalidToken.selector);
        new Four02JobEscrow(address(0));
        vm.expectRevert(Four02JobEscrow.InvalidToken.selector);
        new Four02JobEscrow(outsider);
        vm.expectRevert(Four02JobEscrow.InvalidParty.selector);
        escrow.createJob(provider, address(0), block.timestamp + 1, "");
        vm.expectRevert(Four02JobEscrow.InvalidParty.selector);
        escrow.createJob(address(escrow), evaluator, block.timestamp + 1, "");
        vm.expectRevert(Four02JobEscrow.InvalidParty.selector);
        escrow.createJob(provider, address(token), block.timestamp + 1, "");
        vm.prank(client);
        vm.expectRevert(Four02JobEscrow.InvalidExpiry.selector);
        escrow.createJob(provider, evaluator, block.timestamp, "past");
        vm.prank(client);
        escrow.createJob(provider, evaluator, block.timestamp + 1, "one second");
        uint256 id = _create(address(0), evaluator, BUDGET);
        vm.prank(client);
        vm.expectRevert(Four02JobEscrow.InvalidParty.selector);
        escrow.setProvider(id, address(0));
        vm.prank(outsider);
        vm.expectRevert(Four02JobEscrow.Unauthorized.selector);
        escrow.setProvider(id, provider);
    }

    function test_unknownIdsRevertEveryAction() public {
        for (uint256 action; action < 7; ++action) {
            vm.prank(client);
            (bool ok, bytes memory reason) = address(escrow).call(_data(999, action));
            assertFalse(ok);
            assertEq(bytes4(reason), Four02JobEscrow.InvalidJob.selector);
        }
        vm.expectRevert(Four02JobEscrow.InvalidJob.selector);
        escrow.getJob(0);
        vm.expectRevert(Four02JobEscrow.InvalidJob.selector);
        escrow.getJob(999);
    }

    function _data(uint256 id, uint256 action) internal view returns (bytes memory) {
        if (action == 0) return abi.encodeCall(escrow.setBudget, (id, BUDGET));
        if (action == 1) return abi.encodeCall(escrow.fund, (id, BUDGET));
        if (action == 2) return abi.encodeCall(escrow.submit, (id, DELIVERABLE));
        if (action == 3) return abi.encodeCall(escrow.complete, (id, REASON));
        if (action == 4) return abi.encodeCall(escrow.reject, (id, REASON));
        if (action == 5) return abi.encodeCall(escrow.claimRefund, (id));
        return abi.encodeCall(escrow.setProvider, (id, outsider));
    }

    function _inState(uint256 state) internal returns (uint256 id) {
        id = _create(provider, evaluator, BUDGET);
        if (state == 4) {
            vm.prank(client);
            escrow.reject(id, REASON);
            return id;
        }
        if (state > 0) _fund(id, BUDGET);
        if (state == 2 || state == 3) _submit(id);
        if (state == 3) {
            vm.prank(evaluator);
            escrow.complete(id, REASON);
        }
        if (state == 5) {
            vm.warp(block.timestamp + 1 days);
            escrow.claimRefund(id);
        }
    }

    // Exhaustive role x state x action matrix. Correct roles cannot bypass invalid states.
    function test_allRolesAllStatesAllActions() public {
        address[4] memory actors = [client, provider, evaluator, outsider];
        for (uint256 state; state < 6; ++state) {
            for (uint256 role; role < 4; ++role) {
                for (uint256 action; action < 7; ++action) {
                    uint256 id = _inState(state);
                    bool expected = (state == 0 && action == 0 && role < 2) || (state == 0 && action == 1 && role == 0)
                        || (state == 1 && action == 2 && role == 1) || (state == 2 && action == 3 && role == 2)
                        || (state == 0 && action == 4 && role == 0)
                        || ((state == 1 || state == 2) && action == 4 && role == 2);
                    vm.prank(actors[role]);
                    (bool ok,) = address(escrow).call(_data(id, action));
                    assertEq(ok, expected, "role/state/action matrix");
                }
            }
        }
    }

    function test_expiryBoundaryAndNoCompletionRefundRace() public {
        uint256 open = _create(provider, evaluator, BUDGET);
        uint256 funded = _inState(1);
        uint256 submitted = _inState(2);
        uint256 completed = _inState(2);
        uint256 expiry = escrow.getJob(funded).expiredAt;
        vm.warp(expiry - 1);
        vm.expectRevert(Four02JobEscrow.NotExpired.selector);
        escrow.claimRefund(funded);
        vm.prank(evaluator);
        escrow.complete(completed, bytes32(0));
        vm.warp(expiry);
        vm.expectRevert(Four02JobEscrow.DeadlinePassed.selector);
        _fund(open, BUDGET);
        vm.prank(provider);
        vm.expectRevert(Four02JobEscrow.DeadlinePassed.selector);
        escrow.submit(funded, DELIVERABLE);
        vm.prank(evaluator);
        vm.expectRevert(Four02JobEscrow.DeadlinePassed.selector);
        escrow.complete(submitted, REASON);
        vm.expectRevert(Four02JobEscrow.WrongStatus.selector);
        escrow.claimRefund(open);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Refunded(funded, client, BUDGET);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit JobExpired(funded);
        vm.prank(outsider);
        escrow.claimRefund(funded);
        vm.prank(provider);
        escrow.claimRefund(submitted);
        vm.expectRevert(Four02JobEscrow.WrongStatus.selector);
        escrow.claimRefund(submitted);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_postExpiryRejectionAndOpenEdits() public {
        uint256 open = _create(address(0), evaluator, BUDGET);
        uint256 funded = _inState(1);
        uint256 submitted = _inState(2);
        vm.warp(block.timestamp + 1 days);
        vm.prank(client);
        escrow.setProvider(open, provider);
        vm.prank(provider);
        escrow.setBudget(open, 1);
        vm.prank(client);
        escrow.reject(open, bytes32(0));
        vm.prank(evaluator);
        escrow.reject(funded, bytes32(0));
        vm.prank(evaluator);
        escrow.reject(submitted, bytes32(0));
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_clientEvaluatorAndOverlappingRoles() public {
        uint256 id = _create(provider, client, BUDGET);
        _fund(id, BUDGET);
        _submit(id);
        vm.prank(client);
        escrow.complete(id, bytes32(0));
        id = _create(client, client, BUDGET);
        uint256 beforeClient = token.balanceOf(client);
        _fund(id, BUDGET);
        vm.prank(client);
        escrow.submit(id, bytes32(0));
        vm.prank(client);
        escrow.complete(id, bytes32(0));
        assertEq(token.balanceOf(client), beforeClient);
    }

    function test_missingAllowanceOrBalanceRollsBack() public {
        uint256 id = _create(provider, evaluator, BUDGET);
        vm.prank(client);
        token.approve(address(escrow), BUDGET - 1);
        vm.expectRevert();
        _fund(id, BUDGET);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
        uint256 tooMuch = token.balanceOf(client) + 1;
        vm.prank(client);
        escrow.setBudget(id, tooMuch);
        vm.expectRevert();
        _fund(id, tooMuch);
        assertEq(uint8(escrow.getJob(id).status), 0);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_falseNoopRevertingAndTaxedFundingRollBack() public {
        uint256 id = _create(provider, evaluator, BUDGET);
        uint256 balance = token.balanceOf(client);
        for (uint8 mode = 1; mode <= 4; ++mode) {
            token.setMode(mode);
            vm.expectRevert();
            _fund(id, BUDGET);
            assertEq(token.balanceOf(client), balance);
            assertEq(token.balanceOf(address(escrow)), 0);
            assertEq(escrow.totalEscrowed(), 0);
            assertEq(uint8(escrow.getJob(id).status), 0);
        }
        token.setMode(0);
        _fund(id, BUDGET);
    }

    function test_badPayoutsAndRefundsRollBackThenCanRetry() public {
        uint256 completed = _inState(2);
        uint256 rejected = _inState(1);
        uint256 expired = _inState(1);
        for (uint8 mode = 1; mode <= 4; ++mode) {
            token.setMode(mode);
            vm.prank(evaluator);
            vm.expectRevert();
            escrow.complete(completed, REASON);
            vm.prank(evaluator);
            vm.expectRevert();
            escrow.reject(rejected, REASON);
            assertEq(uint8(escrow.getJob(completed).status), 2);
            assertEq(uint8(escrow.getJob(rejected).status), 1);
            assertEq(escrow.totalEscrowed(), 3 * BUDGET);
            assertEq(token.balanceOf(provider), 0);
        }
        token.setMode(0);
        vm.prank(evaluator);
        escrow.complete(completed, REASON);
        vm.prank(evaluator);
        escrow.reject(rejected, REASON);
        vm.warp(block.timestamp + 1 days);
        for (uint8 mode = 1; mode <= 4; ++mode) {
            token.setMode(mode);
            vm.expectRevert();
            escrow.claimRefund(expired);
            assertEq(uint8(escrow.getJob(expired).status), 1);
            assertEq(escrow.totalEscrowed(), BUDGET);
        }
        token.setMode(0);
        escrow.claimRefund(expired);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_reentrancyBlockedDuringFundingAndSettlement() public {
        JobReenter actor = new JobReenter();
        uint256 target = _create(provider, address(actor), BUDGET);
        _fund(target, BUDGET);
        _submit(target);
        actor.arm(address(escrow), abi.encodeCall(escrow.complete, (target, REASON)));
        token.setCallback(address(actor));
        uint256 second = _create(provider, evaluator, BUDGET);
        _fund(second, BUDGET);
        assertTrue(actor.attempted());
        assertFalse(actor.succeeded());
        assertEq(uint8(escrow.getJob(target).status), 2);
        _submit(second);
        vm.prank(evaluator);
        escrow.complete(second, REASON);
        assertFalse(actor.succeeded());
        assertEq(escrow.totalEscrowed(), BUDGET);
        token.setCallback(address(0));
        vm.prank(address(actor));
        escrow.complete(target, REASON);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_spendingPermissionTransferIsNotJobFunding() public {
        Four02SpendingPermissions permissions = new Four02SpendingPermissions(address(token));
        address[] memory recipients = new address[](1);
        recipients[0] = address(escrow);
        vm.startPrank(client);
        token.approve(address(permissions), BUDGET);
        bytes32 permission = permissions.grant(
            outsider,
            uint128(BUDGET),
            uint48(block.timestamp),
            uint48(block.timestamp + 1 days),
            recipients,
            bytes32(uint256(1))
        );
        vm.stopPrank();
        uint256 id = _create(provider, evaluator, BUDGET);
        vm.prank(outsider);
        permissions.pay(permission, address(escrow), BUDGET, REASON);
        assertEq(uint8(escrow.getJob(id).status), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(token.balanceOf(address(escrow)), BUDGET);
        uint256 beforeClient = token.balanceOf(client);
        _fund(id, BUDGET);
        assertEq(token.balanceOf(client), beforeClient - BUDGET);
        _submit(id);
        vm.prank(evaluator);
        escrow.complete(id, REASON);
        assertEq(token.balanceOf(provider), BUDGET);
        assertEq(token.balanceOf(address(escrow)), BUDGET);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function testFuzz_independentJobsConserveExactBudgets(uint96 a, uint96 b, uint96 surplus, uint8 outcome) public {
        uint256 first = bound(uint256(a), 1, 1e12);
        uint256 second = bound(uint256(b), 1, 1e12);
        token.mint(address(escrow), surplus);
        uint256 beforeClient = token.balanceOf(client);
        uint256 one = _create(provider, evaluator, first);
        uint256 two = _create(provider, evaluator, second);
        _fund(one, first);
        _fund(two, second);
        _submit(one);
        assertEq(escrow.totalEscrowed(), first + second);
        if (outcome % 3 == 0) {
            vm.prank(evaluator);
            escrow.complete(one, REASON);
        } else if (outcome % 3 == 1) {
            vm.prank(evaluator);
            escrow.reject(one, REASON);
        } else {
            vm.warp(block.timestamp + 1 days);
            escrow.claimRefund(one);
        }
        assertEq(escrow.totalEscrowed(), second);
        assertEq(token.balanceOf(address(escrow)), second + surplus);
        vm.warp(escrow.getJob(two).expiredAt);
        escrow.claimRefund(two);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(token.balanceOf(address(escrow)), surplus);
        uint256 paid = outcome % 3 == 0 ? first : 0;
        assertEq(token.balanceOf(provider), paid);
        assertEq(token.balanceOf(client), beforeClient - paid);
    }
}
