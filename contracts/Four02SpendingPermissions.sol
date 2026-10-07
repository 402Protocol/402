// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Four Zero Two Labs, Inc.
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Four02SpendingPermissions
/// @notice Owner-approved, recipient-scoped USDC allowances for agents. Funds stay in the owner's wallet.
/// @dev Non-upgradeable, no admin, no custody, no arbitrary calls, signatures or relayer fees.
///      Owners approve this contract on USDC and grant an agent a permission. The token approval is
///      necessary but never sufficient to pay: every transfer also requires an active owner grant.
///      Budgets are PER PERMISSION, reset at UTC midnight, and never roll over. Other wallet approvals
///      remain independent. Deploy with native Ink USDC; the SDK checks chain and token before use.
contract Four02SpendingPermissions is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    string public constant VERSION = "1.0.0";
    uint256 public constant MAX_RECIPIENTS = 32;

    struct Permission {
        address owner;
        address agent;
        uint128 dailyLimit;
        uint48 validAfter;
        uint48 validUntil; // exclusive
        bool revoked;
    }

    mapping(bytes32 => Permission) private permissions;
    mapping(bytes32 => mapping(address => bool)) public allowedRecipient;
    mapping(bytes32 => mapping(uint256 => uint256)) public spentPerDay;
    // A payment reference cannot be reused by another agent/permission belonging to the same owner.
    mapping(address => mapping(bytes32 => bool)) public usedPaymentId;

    error InvalidConfiguration();
    error PermissionExists();
    error UnknownPermission();
    error Unauthorized();
    error InactivePermission();
    error RecipientNotAllowed();
    error InvalidPayment();
    error DuplicatePayment();
    error BudgetExceeded();
    error TransferFailed();

    event PermissionGranted(
        bytes32 indexed permissionId,
        address indexed owner,
        address indexed agent,
        uint128 dailyLimit,
        uint48 validAfter,
        uint48 validUntil,
        address[] recipients
    );
    event PermissionRevoked(bytes32 indexed permissionId, address indexed owner);
    event PaymentExecuted(
        bytes32 indexed permissionId,
        address indexed owner,
        bytes32 indexed paymentId,
        address agent,
        address recipient,
        uint256 amount,
        uint256 day
    );

    constructor(address token_) {
        if (token_.code.length == 0) revert InvalidConfiguration();
        token = IERC20(token_);
    }

    function permissionIdFor(address owner, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, owner, salt));
    }

    /// @notice Called by the fund owner. This does not itself approve USDC; token approval is separate.
    /// @dev Permissions are immutable and salts cannot be reused, including after revocation/expiry.
    function grant(
        address agent,
        uint128 dailyLimit,
        uint48 validAfter,
        uint48 validUntil,
        address[] calldata recipients,
        bytes32 salt
    ) external nonReentrant returns (bytes32 id) {
        if (
            agent == address(0) || agent == msg.sender || agent == address(this) || agent == address(token)
                || dailyLimit == 0 || validUntil <= block.timestamp || validUntil <= validAfter || recipients.length == 0
                || recipients.length > MAX_RECIPIENTS || salt == bytes32(0)
        ) {
            revert InvalidConfiguration();
        }
        id = permissionIdFor(msg.sender, salt);
        if (permissions[id].owner != address(0)) revert PermissionExists();
        permissions[id] = Permission(msg.sender, agent, dailyLimit, validAfter, validUntil, false);
        for (uint256 i; i < recipients.length; ++i) {
            address recipient = recipients[i];
            if (
                recipient == address(0) || recipient == msg.sender || recipient == address(this)
                    || recipient == address(token) || allowedRecipient[id][recipient]
            ) revert InvalidConfiguration();
            allowedRecipient[id][recipient] = true;
        }
        emit PermissionGranted(id, msg.sender, agent, dailyLimit, validAfter, validUntil, recipients);
    }

    function revoke(bytes32 id) external nonReentrant {
        Permission storage permission = permissions[id];
        if (permission.owner == address(0)) revert UnknownPermission();
        if (msg.sender != permission.owner) revert Unauthorized();
        permission.revoked = true;
        emit PermissionRevoked(id, msg.sender);
    }

    /// @notice Called directly by the delegated agent. paymentId should be a stable invoice/order digest.
    /// @dev A retry with the same reference always reverts. Confirm the original receipt instead.
    function pay(bytes32 id, address recipient, uint256 amount, bytes32 paymentId) external nonReentrant {
        Permission memory permission = permissions[id];
        if (permission.owner == address(0)) revert UnknownPermission();
        if (msg.sender != permission.agent) revert Unauthorized();
        if (!_active(permission)) revert InactivePermission();
        if (!allowedRecipient[id][recipient]) revert RecipientNotAllowed();
        if (amount == 0 || paymentId == bytes32(0)) revert InvalidPayment();
        if (usedPaymentId[permission.owner][paymentId]) revert DuplicatePayment();
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentPerDay[id][day];
        if (amount > uint256(permission.dailyLimit) - spent) revert BudgetExceeded();
        spentPerDay[id][day] = spent + amount;
        usedPaymentId[permission.owner][paymentId] = true;

        uint256 beforeOwner = token.balanceOf(permission.owner);
        uint256 beforeRecipient = token.balanceOf(recipient);
        token.safeTransferFrom(permission.owner, recipient, amount);
        // USDC has exact transfers. A successful call alone is not proof that the payment happened.
        if (
            beforeOwner < amount || token.balanceOf(permission.owner) != beforeOwner - amount
                || token.balanceOf(recipient) != beforeRecipient + amount
        ) revert TransferFailed();
        emit PaymentExecuted(id, permission.owner, paymentId, msg.sender, recipient, amount, day);
    }

    function getPermission(bytes32 id) external view returns (Permission memory) {
        return permissions[id];
    }

    /// @notice Policy allowance only; Owner balance and token approval must also be checked or simulated.
    function remainingToday(bytes32 id) external view returns (uint256) {
        Permission memory permission = permissions[id];
        if (!_active(permission)) return 0;
        return uint256(permission.dailyLimit) - spentPerDay[id][block.timestamp / 1 days];
    }

    function _active(Permission memory permission) private view returns (bool) {
        return permission.owner != address(0) && !permission.revoked && block.timestamp >= permission.validAfter
            && block.timestamp < permission.validUntil;
    }
}
