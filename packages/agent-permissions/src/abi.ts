import { parseAbi } from 'viem';

export const spendingPermissionsAbi = parseAbi([
  'struct Permission { address owner; address agent; uint128 dailyLimit; uint48 validAfter; uint48 validUntil; bool revoked; }',
  'function token() view returns (address)',
  'function VERSION() view returns (string)',
  'function permissionIdFor(address owner, bytes32 salt) view returns (bytes32)',
  'function grant(address agent, uint128 dailyLimit, uint48 validAfter, uint48 validUntil, address[] recipients, bytes32 salt) returns (bytes32 id)',
  'function revoke(bytes32 id)',
  'function pay(bytes32 id, address recipient, uint256 amount, bytes32 paymentId)',
  'function getPermission(bytes32 id) view returns (Permission permission)',
  'function remainingToday(bytes32 id) view returns (uint256)',
  'function allowedRecipient(bytes32 id, address recipient) view returns (bool)',
  'function usedPaymentId(address owner, bytes32 paymentId) view returns (bool)',
  'event PermissionGranted(bytes32 indexed permissionId, address indexed owner, address indexed agent, uint128 dailyLimit, uint48 validAfter, uint48 validUntil, address[] recipients)',
  'event PermissionRevoked(bytes32 indexed permissionId, address indexed owner)',
  'event PaymentExecuted(bytes32 indexed permissionId, address indexed owner, bytes32 indexed paymentId, address agent, address recipient, uint256 amount, uint256 day)',
  'error InvalidConfiguration()', 'error PermissionExists()', 'error UnknownPermission()',
  'error Unauthorized()', 'error InactivePermission()', 'error RecipientNotAllowed()',
  'error InvalidPayment()', 'error DuplicatePayment()', 'error BudgetExceeded()', 'error TransferFailed()',
]);
