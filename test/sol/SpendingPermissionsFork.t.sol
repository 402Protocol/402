// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "forge-std/src/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Four02SpendingPermissions} from "../../contracts/Four02SpendingPermissions.sol";

/// @notice Opt-in rehearsal against native USDC's actual Ink implementation. Fork writes are local only.
contract SpendingPermissionsForkTest is Test {
    function test_nativeInkUsdcGrantPayRevoke() public {
        vm.createSelectFork("https://rpc-gel.inkonchain.com");
        assertEq(block.chainid, 57073);
        IERC20 usdc = IERC20(0x2D270e6886d130D724215A266106e6832161EAEd);
        Four02SpendingPermissions manager = new Four02SpendingPermissions(address(usdc));
        address owner = makeAddr("permissions-fork-owner");
        address agent = makeAddr("permissions-fork-agent");
        address service = makeAddr("permissions-fork-service");
        deal(address(usdc), owner, 50e6);
        address[] memory recipients = new address[](1);
        recipients[0] = service;
        vm.startPrank(owner);
        assertTrue(usdc.approve(address(manager), 40e6));
        bytes32 id = manager.grant(agent, 20e6, uint48(block.timestamp), uint48(block.timestamp + 1 days), recipients, bytes32(uint256(1)));
        vm.stopPrank();
        vm.prank(agent);
        manager.pay(id, service, 12e6, keccak256("fork-invoice"));
        assertEq(usdc.balanceOf(service), 12e6);
        assertEq(usdc.balanceOf(owner), 38e6);
        assertEq(manager.remainingToday(id), 8e6);
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.BudgetExceeded.selector);
        manager.pay(id, service, 9e6, keccak256("fork-over-budget"));
        vm.prank(owner);
        manager.revoke(id);
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.InactivePermission.selector);
        manager.pay(id, service, 1e6, keccak256("fork-revoked"));
    }
}
