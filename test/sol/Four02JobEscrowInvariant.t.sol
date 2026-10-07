// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {Four02JobEscrow} from "../../contracts/Four02JobEscrow.sol";
import {JobTestToken} from "./Four02JobEscrow.t.sol";

contract JobEscrowHandler is Test {
    Four02JobEscrow public escrow;
    JobTestToken public token;
    address public client = address(0xC1);
    address public provider = address(0xB1);
    address public evaluator = address(0xE1);
    uint256[] public ids;
    uint256 public funded;
    uint256 public paid;
    uint256 public refunded;
    uint256 public donations;
    mapping(uint256 => uint8) public terminal;

    constructor(Four02JobEscrow escrow_, JobTestToken token_) {
        escrow = escrow_;
        token = token_;
        token.mint(client, 1e18);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    function create(uint256 amount) external {
        if (ids.length >= 32) return;
        vm.prank(client);
        uint256 id = escrow.createJob(provider, evaluator, block.timestamp + 1 days, "invariant job");
        ids.push(id);
        vm.prank(client);
        escrow.setBudget(id, bound(amount, 1, 1e9));
    }

    function fund(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        Four02JobEscrow.Job memory job = escrow.getJob(id);
        if (job.status != Four02JobEscrow.JobStatus.Open || block.timestamp >= job.expiredAt) return;
        vm.prank(client);
        escrow.fund(id, job.budget);
        funded += job.budget;
    }

    function changeBudget(uint256 seed, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        if (escrow.getJob(id).status != Four02JobEscrow.JobStatus.Open) return;
        vm.prank(provider);
        escrow.setBudget(id, bound(amount, 1, 1e9));
    }

    function submit(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        Four02JobEscrow.Job memory job = escrow.getJob(id);
        if (job.status != Four02JobEscrow.JobStatus.Funded || block.timestamp >= job.expiredAt) return;
        vm.prank(provider);
        escrow.submit(id, bytes32(seed));
    }

    function complete(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        Four02JobEscrow.Job memory job = escrow.getJob(id);
        if (job.status != Four02JobEscrow.JobStatus.Submitted || block.timestamp >= job.expiredAt) return;
        vm.prank(evaluator);
        escrow.complete(id, bytes32(seed));
        paid += job.budget;
        terminal[id] = 3;
    }

    function reject(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        Four02JobEscrow.Job memory job = escrow.getJob(id);
        if (uint8(job.status) > 2) return;
        vm.prank(job.status == Four02JobEscrow.JobStatus.Open ? client : evaluator);
        escrow.reject(id, bytes32(seed));
        terminal[id] = 4;
        if (job.status != Four02JobEscrow.JobStatus.Open) refunded += job.budget;
    }

    function elapse(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 6 hours));
    }

    function refund(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        Four02JobEscrow.Job memory job = escrow.getJob(id);
        if (
            (job.status != Four02JobEscrow.JobStatus.Funded && job.status != Four02JobEscrow.JobStatus.Submitted)
                || block.timestamp < job.expiredAt
        ) return;
        escrow.claimRefund(id);
        refunded += job.budget;
        terminal[id] = 5;
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 0, 1e9);
        token.mint(address(escrow), amount);
        donations += amount;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }
}

contract Four02JobEscrowInvariantTest is Test {
    JobTestToken token;
    Four02JobEscrow escrow;
    JobEscrowHandler handler;

    function setUp() public {
        vm.warp(100 days);
        token = new JobTestToken();
        escrow = new Four02JobEscrow(address(token));
        handler = new JobEscrowHandler(escrow, token);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.create.selector;
        selectors[1] = handler.fund.selector;
        selectors[2] = handler.changeBudget.selector;
        selectors[3] = handler.submit.selector;
        selectors[4] = handler.complete.selector;
        selectors[5] = handler.reject.selector;
        selectors[6] = handler.elapse.selector;
        selectors[7] = handler.refund.selector;
        selectors[8] = handler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_liabilitiesMatchActiveJobsAndTerminalStatesStayFinal() public view {
        uint256 sum;
        for (uint256 i; i < handler.count(); ++i) {
            uint256 id = handler.ids(i);
            Four02JobEscrow.Job memory job = escrow.getJob(id);
            if (job.status == Four02JobEscrow.JobStatus.Funded || job.status == Four02JobEscrow.JobStatus.Submitted) {
                sum += job.budget;
            }
            if (handler.terminal(id) > 0) assertEq(uint8(job.status), handler.terminal(id));
        }
        assertEq(escrow.totalEscrowed(), sum);
        assertEq(token.balanceOf(address(escrow)), sum + handler.donations());
    }

    function invariant_independentLedgerConservesAllFunds() public view {
        assertEq(handler.funded(), handler.paid() + handler.refunded() + escrow.totalEscrowed());
        assertEq(token.balanceOf(handler.client()), 1e18 - handler.funded() + handler.refunded());
        assertEq(token.balanceOf(handler.provider()), handler.paid());
        assertEq(token.balanceOf(handler.evaluator()), 0);
        assertEq(
            token.totalSupply(),
            token.balanceOf(handler.client()) + token.balanceOf(handler.provider()) + token.balanceOf(address(escrow))
        );
    }
}
