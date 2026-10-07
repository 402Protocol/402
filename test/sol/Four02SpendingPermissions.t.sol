// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Four02SpendingPermissions} from "../../contracts/Four02SpendingPermissions.sol";

contract SpendingTestToken is ERC20 {
    uint8 public mode;
    address public callback;

    constructor() ERC20("Test USDC", "USDC") {}

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

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) return true;
        if (mode == 3) revert("blocked recipient");
        if (callback != address(0)) SpendingReentrantAgent(callback).reenter();
        return super.transferFrom(from, to, value);
    }
}

contract SpendingReentrantAgent {
    Four02SpendingPermissions public manager;
    bytes32 public id;
    address public recipient;
    bool public entered;

    function arm(Four02SpendingPermissions manager_, bytes32 id_, address recipient_) external {
        manager = manager_;
        id = id_;
        recipient = recipient_;
    }

    function run() external {
        manager.pay(id, recipient, 1e6, keccak256("outer"));
    }

    function reenter() external {
        try manager.pay(id, recipient, 1e6, keccak256("inner")) {
            entered = true;
        } catch {}
    }
}

contract Four02SpendingPermissionsTest is Test {
    SpendingTestToken token;
    Four02SpendingPermissions manager;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address service = makeAddr("service");
    address other = makeAddr("other");
    bytes32 id;

    function setUp() public {
        vm.chainId(57073);
        vm.warp(10 days + 12 hours);
        token = new SpendingTestToken();
        manager = new Four02SpendingPermissions(address(token));
        token.mint(owner, 1000e6);
        vm.prank(owner);
        token.approve(address(manager), 100e6);
        id = _grant(owner, agent, 20e6, uint48(block.timestamp), uint48(block.timestamp + 3 days), bytes32(uint256(1)));
    }

    function _grant(address payer, address delegate, uint128 limit, uint48 start, uint48 end, bytes32 salt)
        internal
        returns (bytes32)
    {
        address[] memory recipients = new address[](1);
        recipients[0] = service;
        vm.prank(payer);
        return manager.grant(delegate, limit, start, end, recipients, salt);
    }

    function _pay(uint256 amount, bytes32 paymentRef) internal {
        vm.prank(agent);
        manager.pay(id, service, amount, paymentRef);
    }

    function test_ownerFundsStayInWalletUntilAgentPays() public {
        assertEq(token.balanceOf(address(manager)), 0);
        assertEq(token.balanceOf(owner), 1000e6);
        _pay(8e6, keccak256("invoice"));
        assertEq(token.balanceOf(owner), 992e6);
        assertEq(token.balanceOf(service), 8e6);
        assertEq(manager.remainingToday(id), 12e6);
        assertEq(token.allowance(owner, address(manager)), 92e6);
        assertTrue(manager.usedPaymentId(owner, keccak256("invoice")));
    }

    function test_cumulativeCapAndExactLimit() public {
        _pay(12e6, bytes32(uint256(1)));
        _pay(8e6, bytes32(uint256(2)));
        vm.expectRevert(Four02SpendingPermissions.BudgetExceeded.selector);
        _pay(1, bytes32(uint256(3)));
        assertEq(token.balanceOf(service), 20e6);
        assertEq(manager.remainingToday(id), 0);
    }

    function test_utcMidnightResetDoesNotCarryUnusedBudget() public {
        _pay(8e6, bytes32(uint256(1)));
        vm.warp(11 days - 1);
        assertEq(manager.remainingToday(id), 12e6);
        vm.warp(11 days);
        assertEq(manager.remainingToday(id), 20e6);
        _pay(20e6, bytes32(uint256(2)));
        assertEq(manager.spentPerDay(id, 10), 8e6);
        assertEq(manager.spentPerDay(id, 11), 20e6);
    }

    function test_startInclusiveExpiryExclusive() public {
        bytes32 future = _grant(
            owner, agent, 20e6, uint48(block.timestamp + 1 days), uint48(block.timestamp + 2 days), bytes32(uint256(2))
        );
        assertEq(manager.remainingToday(future), 0);
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.InactivePermission.selector);
        manager.pay(future, service, 1, bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        manager.pay(future, service, 1, bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.InactivePermission.selector);
        manager.pay(future, service, 1, bytes32(uint256(2)));
        assertEq(manager.remainingToday(future), 0);
    }

    function test_onlyAgentMayPayAndOnlyOwnerMayRevoke() public {
        vm.prank(other);
        vm.expectRevert(Four02SpendingPermissions.Unauthorized.selector);
        manager.pay(id, service, 1, bytes32(uint256(1)));
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.Unauthorized.selector);
        manager.revoke(id);
        vm.prank(owner);
        manager.revoke(id);
        vm.expectRevert(Four02SpendingPermissions.InactivePermission.selector);
        _pay(1, bytes32(uint256(1)));
        assertEq(manager.remainingToday(id), 0);
        vm.prank(owner);
        manager.revoke(id); // idempotent
    }

    function test_approvedTokenAloneDoesNotAuthorizePayment() public {
        bytes32 malicious =
            _grant(other, agent, 20e6, uint48(block.timestamp), uint48(block.timestamp + 1 days), bytes32(uint256(1)));
        vm.prank(agent);
        vm.expectRevert();
        manager.pay(malicious, service, 1, bytes32(uint256(1)));
        assertEq(token.balanceOf(owner), 1000e6);
    }

    function test_recipientAllowlistCannotBeBypassed() public {
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.RecipientNotAllowed.selector);
        manager.pay(id, other, 1, bytes32(uint256(1)));
        assertEq(manager.remainingToday(id), 20e6);
    }

    function test_duplicatePaymentBlockedAcrossDaysAndReplacementPermissions() public {
        bytes32 paymentRef = keccak256("order-1");
        _pay(1e6, paymentRef);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(Four02SpendingPermissions.DuplicatePayment.selector);
        _pay(1e6, paymentRef);
        vm.prank(owner);
        manager.revoke(id);
        bytes32 replacement =
            _grant(owner, other, 20e6, uint48(block.timestamp), uint48(block.timestamp + 1 days), bytes32(uint256(2)));
        vm.prank(other);
        vm.expectRevert(Four02SpendingPermissions.DuplicatePayment.selector);
        manager.pay(replacement, service, 1e6, paymentRef);
    }

    function test_noBudgetResetByRegrantingSameSalt() public {
        _pay(20e6, keccak256("invoice"));
        vm.expectRevert(Four02SpendingPermissions.PermissionExists.selector);
        _grant(owner, agent, 20e6, uint48(block.timestamp), uint48(block.timestamp + 3 days), bytes32(uint256(1)));
        vm.prank(owner);
        manager.revoke(id);
        vm.expectRevert(Four02SpendingPermissions.PermissionExists.selector);
        _grant(owner, agent, 20e6, uint48(block.timestamp), uint48(block.timestamp + 3 days), bytes32(uint256(1)));
    }

    function test_tokenApprovalCanIndependentlyStopPayments() public {
        vm.prank(owner);
        token.approve(address(manager), 0);
        vm.expectRevert();
        _pay(1e6, bytes32(uint256(1)));
        assertEq(manager.remainingToday(id), 20e6);
        assertFalse(manager.usedPaymentId(owner, bytes32(uint256(1))));
    }

    function test_failedTransferRollsBackBudgetAndPaymentId() public {
        for (uint8 mode = 1; mode <= 3; ++mode) {
            token.setMode(mode);
            vm.expectRevert();
            _pay(1e6, bytes32(uint256(1)));
            assertEq(manager.remainingToday(id), 20e6);
            assertFalse(manager.usedPaymentId(owner, bytes32(uint256(1))));
        }
        token.setMode(0);
        _pay(1e6, bytes32(uint256(1)));
        assertEq(token.balanceOf(service), 1e6);
    }

    function test_reentrantAgentCannotSpendDuringTokenCallback() public {
        SpendingReentrantAgent callback = new SpendingReentrantAgent();
        bytes32 callbackId = _grant(
            owner,
            address(callback),
            20e6,
            uint48(block.timestamp),
            uint48(block.timestamp + 1 days),
            bytes32(uint256(2))
        );
        callback.arm(manager, callbackId, service);
        token.setCallback(address(callback));
        callback.run();
        assertFalse(callback.entered());
        assertEq(token.balanceOf(service), 1e6);
        assertFalse(manager.usedPaymentId(owner, keccak256("inner")));
    }

    function test_permissionIdBoundToChainManagerOwner() public {
        bytes32 salt = bytes32(uint256(1));
        assertEq(manager.permissionIdFor(owner, salt), id);
        assertNotEq(manager.permissionIdFor(other, salt), id);
        vm.chainId(1);
        assertNotEq(manager.permissionIdFor(owner, salt), id);
        vm.chainId(57073);
        Four02SpendingPermissions second = new Four02SpendingPermissions(address(token));
        assertNotEq(second.permissionIdFor(owner, salt), id);
    }

    function test_invalidPaymentsAndUnknownPermissions() public {
        vm.expectRevert(Four02SpendingPermissions.InvalidPayment.selector);
        _pay(0, bytes32(uint256(1)));
        vm.expectRevert(Four02SpendingPermissions.InvalidPayment.selector);
        _pay(1, bytes32(0));
        vm.expectRevert(Four02SpendingPermissions.UnknownPermission.selector);
        manager.revoke(bytes32(0));
        vm.prank(agent);
        vm.expectRevert(Four02SpendingPermissions.UnknownPermission.selector);
        manager.pay(bytes32(0), service, 1, bytes32(uint256(1)));
    }

    function test_invalidGrants() public {
        vm.expectRevert(Four02SpendingPermissions.InvalidConfiguration.selector);
        _grant(owner, address(0), 20e6, 0, uint48(block.timestamp + 1), bytes32(uint256(2)));
        vm.expectRevert(Four02SpendingPermissions.InvalidConfiguration.selector);
        _grant(owner, agent, 0, 0, uint48(block.timestamp + 1), bytes32(uint256(2)));
        vm.expectRevert(Four02SpendingPermissions.InvalidConfiguration.selector);
        _grant(owner, agent, 20e6, 0, uint48(block.timestamp), bytes32(uint256(2)));
        address[] memory recipients = new address[](2);
        recipients[0] = service;
        recipients[1] = service;
        vm.prank(owner);
        vm.expectRevert(Four02SpendingPermissions.InvalidConfiguration.selector);
        manager.grant(agent, 20e6, 0, uint48(block.timestamp + 1), recipients, bytes32(uint256(2)));
        recipients[1] = owner;
        vm.prank(owner);
        vm.expectRevert(Four02SpendingPermissions.InvalidConfiguration.selector);
        manager.grant(agent, 20e6, 0, uint48(block.timestamp + 1), recipients, bytes32(uint256(2)));
        vm.expectRevert(Four02SpendingPermissions.InvalidConfiguration.selector);
        new Four02SpendingPermissions(address(0));
    }

    function testFuzz_sumOfPaymentsCannotExceedDailyBudget(uint128 first, uint128 second) public {
        uint256 a = bound(first, 1, 20e6);
        uint256 b = bound(second, 1, 20e6);
        _pay(a, bytes32(uint256(1)));
        if (a + b > 20e6) vm.expectRevert(Four02SpendingPermissions.BudgetExceeded.selector);
        _pay(b, bytes32(uint256(2)));
        assertLe(token.balanceOf(service), 20e6);
        assertEq(manager.remainingToday(id) + token.balanceOf(service), 20e6);
    }
}
