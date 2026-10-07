import {
  type Address, type Hex, type PublicClient, type TransactionReceipt,
  decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, erc20Abi,
  getAddress, isAddress, keccak256, parseUnits, zeroAddress,
} from 'viem';
import { spendingPermissionsAbi } from './abi.js';
export { spendingPermissionsAbi } from './abi.js';

export const INK_CHAIN_ID = 57073;
export const INK_USDC = getAddress('0x2D270e6886d130D724215A266106e6832161EAEd');
export const ink = defineChain({ id: INK_CHAIN_ID, name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-gel.inkonchain.com'] } },
  blockExplorers: { default: { name: 'Ink Explorer', url: 'https://explorer.inkonchain.com' } },
});
export type Call = { to: Address; data: Hex; value: bigint };
export type OwnerPlan = { chainId: typeof INK_CHAIN_ID; owner: Address; calls: Call[]; kind: 'grant' | 'revoke' | 'revoke-token-approval' };
export interface GrantInput {
  owner: Address; agent: Address; dailyLimitUsdc: string;
  validAfter: number; validUntil: number; recipients: Address[]; salt: Hex;
}
export interface PaymentInput { permissionId: Hex; recipient: Address; amountUsdc: string; paymentId: Hex }
export interface ExpectedPayment { permissionId: Hex; owner: Address; agent: Address; recipient: Address; amount: bigint; paymentId: Hex }

export function address(value: string): Address {
  if (!isAddress(value) || getAddress(value) === zeroAddress) throw new Error('A nonzero EVM address is required');
  return getAddress(value);
}
export function bytes32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new Error('A nonzero bytes32 reference is required');
  return value.toLowerCase() as Hex;
}
export function usdcAmount(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('USDC must be a decimal string with at most 6 decimal places');
  const amount = parseUnits(value, 6);
  if (amount <= 0n || amount > (1n << 128n) - 1n) throw new Error('USDC amount is outside the supported range');
  return amount;
}
export function permissionIdFor(manager: Address, owner: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
    [address(manager), BigInt(INK_CHAIN_ID), address(owner), bytes32(salt)]));
}
export function buildGrant(manager: Address, input: GrantInput, now: number) {
  manager = address(manager);
  const owner = address(input.owner); const agent = address(input.agent);
  const forbidden = [owner, manager, INK_USDC];
  if (forbidden.includes(agent)) throw new Error('Agent must be distinct from owner, manager and USDC');
  const dailyLimit = usdcAmount(input.dailyLimitUsdc);
  for (const time of [now, input.validAfter, input.validUntil]) {
    if (!Number.isSafeInteger(time) || time < 0 || time >= 2 ** 48) throw new Error('Timestamps must be uint48 Unix seconds');
  }
  if (input.validUntil <= now || input.validUntil <= input.validAfter) throw new Error('Permission must have a future expiry after its start');
  const recipients = input.recipients.map(address);
  if (recipients.length === 0 || recipients.length > 32 || new Set(recipients).size !== recipients.length
    || recipients.some((r) => forbidden.includes(r))) throw new Error('Provide 1–32 unique, valid service recipients');
  const salt = bytes32(input.salt);
  // Maximum possible spend across ALL UTC day buckets touched by this grant. Finite, never unlimited.
  const firstDay = Math.floor(Math.max(now, input.validAfter) / 86400);
  const lastDay = Math.floor((input.validUntil - 1) / 86400);
  const maximumApproval = BigInt(lastDay - firstDay + 1) * dailyLimit;
  return { owner, permissionId: permissionIdFor(manager, owner, salt), dailyLimit, maximumApproval,
    call: { to: manager, value: 0n, data: encodeFunctionData({ abi: spendingPermissionsAbi, functionName: 'grant',
      args: [agent, dailyLimit, input.validAfter, input.validUntil, recipients, salt] }) } satisfies Call };
}
export function approvalCall(manager: Address, amount: bigint): Call {
  if (amount < 0n || amount >= (1n << 256n)) throw new Error('Invalid approval amount');
  return { to: INK_USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address(manager), amount] }) };
}
export function revokeCall(manager: Address, permissionId: Hex): Call {
  return { to: address(manager), value: 0n, data: encodeFunctionData({ abi: spendingPermissionsAbi, functionName: 'revoke', args: [bytes32(permissionId)] }) };
}
export function paymentCall(manager: Address, input: PaymentInput): Call {
  return { to: address(manager), value: 0n, data: encodeFunctionData({ abi: spendingPermissionsAbi, functionName: 'pay',
    args: [bytes32(input.permissionId), address(input.recipient), usdcAmount(input.amountUsdc), bytes32(input.paymentId)] }) };
}

/** Checks exact evidence, never infers payment from a consumed reference or reduced allowance. */
export function receiptMatchesPayment(manager: Address, receipt: Pick<TransactionReceipt, 'status' | 'logs'>, expected: ExpectedPayment): boolean {
  if (receipt.status !== 'success') return false;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let payment = false; let transfer = false;
  for (const log of receipt.logs) {
    if (log.removed) continue;
    try {
      if (same(log.address, manager)) {
        const event = decodeEventLog({ abi: spendingPermissionsAbi, eventName: 'PaymentExecuted', data: log.data, topics: log.topics });
        const a = event.args;
        if (same(a.permissionId, expected.permissionId) && same(a.owner, expected.owner) && same(a.agent, expected.agent)
          && same(a.paymentId, expected.paymentId) && same(a.recipient, expected.recipient) && a.amount === expected.amount) payment = true;
      }
      if (same(log.address, INK_USDC)) {
        const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
        if (same(event.args.from, expected.owner) && same(event.args.to, expected.recipient) && event.args.value === expected.amount) transfer = true;
      }
    } catch { /* Unrelated or malformed log is not evidence. */ }
  }
  return payment && transfer;
}

export function createPermissionsClient(publicClient: PublicClient, managerAddress: Address) {
  const manager = address(managerAddress);
  async function checkDeployment() {
    if (await publicClient.getChainId() !== INK_CHAIN_ID) throw new Error('RPC must be connected to Ink (57073)');
    const code = await publicClient.getCode({ address: manager });
    if (!code || code === '0x') throw new Error('Spending manager is not deployed');
    const [token, version] = await Promise.all([
      publicClient.readContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'token' }),
      publicClient.readContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'VERSION' }),
    ]);
    if (getAddress(token) !== INK_USDC || version !== '1.0.0') throw new Error('Incompatible spending manager or USDC token');
    // Interface compatibility is NOT source verification: integrators must pin their verified deployment.
  }
  async function status(permissionId: Hex) {
    await checkDeployment();
    const id = bytes32(permissionId); const block = await publicClient.getBlock(); const blockNumber = block.number;
    const permission = await publicClient.readContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'getPermission', args: [id], blockNumber });
    if (permission.owner === zeroAddress) throw new Error('Unknown permission');
    const [remainingToday, tokenAllowance, ownerBalance] = await Promise.all([
      publicClient.readContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'remainingToday', args: [id], blockNumber }),
      publicClient.readContract({ address: INK_USDC, abi: erc20Abi, functionName: 'allowance', args: [permission.owner, manager], blockNumber }),
      publicClient.readContract({ address: INK_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [permission.owner], blockNumber }),
    ]);
    return { permissionId: id, permission, remainingToday, tokenAllowance, ownerBalance,
      available: [remainingToday, tokenAllowance, ownerBalance].reduce((a, b) => a < b ? a : b), blockNumber, timestamp: block.timestamp };
  }
  return {
    manager, checkDeployment, status,
    async prepareGrant(input: GrantInput) {
      await checkDeployment();
      const block = await publicClient.getBlock();
      const grant = buildGrant(manager, input, Number(block.timestamp));
      const existing = await publicClient.readContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'getPermission', args: [grant.permissionId] });
      if (existing.owner !== zeroAddress) throw new Error('This grant already exists; read its status instead of creating another budget');
      const allowance = await publicClient.readContract({ address: INK_USDC, abi: erc20Abi, functionName: 'allowance', args: [grant.owner, manager] });
      const calls: Call[] = [];
      if (allowance !== grant.maximumApproval) {
        if (allowance !== 0n) calls.push(approvalCall(manager, 0n));
        calls.push(approvalCall(manager, grant.maximumApproval));
      }
      calls.push(grant.call);
      return { kind: 'grant', chainId: INK_CHAIN_ID, owner: grant.owner, permissionId: grant.permissionId,
        maximumApproval: grant.maximumApproval, calls,
        notice: 'Token approval is shared by this owner’s permissions. Daily limits are per permission, reset at UTC midnight, and do not roll over. Confirm every transaction before proceeding.' } satisfies OwnerPlan & Record<string, unknown>;
    },
    async prepareRevoke(permissionId: Hex, owner: Address): Promise<OwnerPlan> {
      const state = await status(permissionId);
      if (getAddress(state.permission.owner) !== address(owner)) throw new Error('Only the permission owner may revoke');
      return { kind: 'revoke', chainId: INK_CHAIN_ID, owner: address(owner), calls: [revokeCall(manager, permissionId)] };
    },
    async preparePayment(input: PaymentInput) {
      const state = await status(input.permissionId);
      const call = paymentCall(manager, input);
      await publicClient.simulateContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'pay', account: state.permission.agent,
        args: [bytes32(input.permissionId), address(input.recipient), usdcAmount(input.amountUsdc), bytes32(input.paymentId)] });
      return { chainId: INK_CHAIN_ID, agent: state.permission.agent, call, expected: {
        permissionId: bytes32(input.permissionId), owner: state.permission.owner, agent: state.permission.agent,
        recipient: address(input.recipient), amount: usdcAmount(input.amountUsdc), paymentId: bytes32(input.paymentId),
      } satisfies ExpectedPayment, status: 'unsigned' as const };
    },
    async confirmPayment(hash: Hex, expected: ExpectedPayment, confirmations = 2) {
      if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('At least one confirmation is required');
      await checkDeployment();
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash || !receiptMatchesPayment(manager, receipt, expected)) throw new Error('Receipt does not prove this exact payment');
      return receipt;
    },
  };
}
