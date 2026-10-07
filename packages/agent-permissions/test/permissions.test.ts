import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PublicClient, type TransactionReceipt, decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, zeroAddress } from 'viem';
import { buildGrant, createPermissionsClient, INK_USDC, permissionIdFor, receiptMatchesPayment, spendingPermissionsAbi, usdcAmount } from '../src/index.js';

const manager = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const agent = '0x3333333333333333333333333333333333333333';
const service = '0x4444444444444444444444444444444444444444';
const salt = `0x${'01'.repeat(32)}` as const;
const paymentId = `0x${'02'.repeat(32)}` as const;
const now = 864000;
const input = { owner, agent, dailyLimitUsdc: '20', validAfter: now, validUntil: now + 3 * 86400, recipients: [service], salt } as const;
const grantInput = () => ({ ...input, recipients: [...input.recipients] });
const permission = { owner, agent, dailyLimit: 20_000_000n, validAfter: now, validUntil: now + 86400, revoked: false };

test('finite three-day approval and exact USDC amounts; grant encoded with approved recipients', () => {
  const grant = buildGrant(manager, grantInput(), now);
  assert.equal(grant.maximumApproval, 60_000_000n);
  assert.equal(grant.permissionId, permissionIdFor(manager, owner, salt));
  const decoded = decodeFunctionData({ abi: spendingPermissionsAbi, data: grant.call.data });
  assert.equal(decoded.functionName, 'grant');
  assert.deepEqual(decoded.args, [agent, 20_000_000n, now, input.validUntil, [service], salt]);
  assert.equal(grant.call.value, 0n);
});
test('partial UTC days are separate budgets and past start does not overapprove past days', () => {
  assert.equal(buildGrant(manager, { ...grantInput(), validAfter: now + 1, validUntil: now + 86401 }, now).maximumApproval, 40_000_000n);
  assert.equal(buildGrant(manager, { ...grantInput(), validAfter: now - 86400 }, now).maximumApproval, 60_000_000n);
});
test('reject lossy amounts and invalid or unsafe grant parameters', () => {
  for (const amount of ['0', '-1', '1e3', '1.0000001', 'NaN', 'Infinity', ' 20', '0x14']) assert.throws(() => usdcAmount(amount));
  for (const patch of [{ dailyLimitUsdc: '0' }, { validUntil: now }, { validAfter: input.validUntil },
    { validUntil: 2 ** 48 }, { validAfter: 0.5 }, { agent: owner }, { recipients: [] },
    { recipients: [service, service] }, { recipients: [zeroAddress] }, { recipients: [owner] },
    { recipients: [manager] }, { recipients: [INK_USDC] }, { salt: `0x${'00'.repeat(32)}` }]) {
    assert.throws(() => buildGrant(manager, { ...grantInput(), ...patch } as ReturnType<typeof grantInput>, now));
  }
});
test('permission IDs distinguish owner, deployment and salt', () => {
  const id = permissionIdFor(manager, owner, salt);
  assert.notEqual(id, permissionIdFor(service, owner, salt));
  assert.notEqual(id, permissionIdFor(manager, agent, salt));
  assert.notEqual(id, permissionIdFor(manager, owner, paymentId));
});

function rpc(overrides: Record<string, unknown> = {}) {
  const reads: { functionName: string; blockNumber?: bigint }[] = [];
  const client = {
    getChainId: async () => 57073, getCode: async () => '0x01', getBlock: async () => ({ number: 10n, timestamp: BigInt(now), hash: salt }),
    readContract: async (call: { functionName: string; blockNumber?: bigint }) => {
      reads.push(call);
      return ({ token: INK_USDC, VERSION: '1.0.0', getPermission: permission, remainingToday: 20_000_000n,
        allowance: 5_000_000n, balanceOf: 10_000_000n } as Record<string, unknown>)[call.functionName];
    },
    simulateContract: async () => ({}), ...overrides,
  };
  return { client: client as unknown as PublicClient, reads };
}
test('status uses one block snapshot and caps available by allowance and balance', async () => {
  const { client, reads } = rpc(); const state = await createPermissionsClient(client, manager).status(salt);
  assert.equal(state.available, 5_000_000n);
  for (const read of reads.filter((r) => !['token', 'VERSION'].includes(r.functionName))) assert.equal(read.blockNumber, 10n);
});
test('wrong chain or undeployed manager cannot prepare any live action', async () => {
  for (const overrides of [{ getChainId: async () => 1 }, { getCode: async () => undefined }, { getCode: async () => '0x' }]) {
    await assert.rejects(createPermissionsClient(rpc(overrides).client, manager).prepareGrant(grantInput()));
  }
});
test('reject wrong token/version and unknown permissions', async () => {
  for (const [field, value] of [['token', service], ['VERSION', '2.0.0'], ['getPermission', { ...permission, owner: zeroAddress }]] as const) {
    const base = rpc().client;
    const client = rpc({ readContract: async (a: { functionName: string }) => a.functionName === field ? value : base.readContract(a as never) }).client;
    await assert.rejects(createPermissionsClient(client, manager).status(salt));
  }
});
test('existing grant cannot be recreated and payment simulation failures propagate', async () => {
  await assert.rejects(createPermissionsClient(rpc().client, manager).prepareGrant(grantInput()), /already exists/);
  const client = rpc({ simulateContract: async () => { throw new Error('BudgetExceeded'); } }).client;
  await assert.rejects(createPermissionsClient(client, manager).preparePayment({ permissionId: salt, recipient: service, amountUsdc: '1', paymentId }), /BudgetExceeded/);
});
test('only the actual owner receives a revoke plan', async () => {
  const sdk = createPermissionsClient(rpc().client, manager);
  await assert.rejects(sdk.prepareRevoke(salt, agent), /Only the permission owner/);
  assert.equal((await sdk.prepareRevoke(salt, owner)).calls.length, 1);
});
test('existing nonzero allowance is zeroed before setting a finite replacement', async () => {
  const base = rpc().client;
  const client = rpc({ readContract: async (a: { functionName: string }) => a.functionName === 'getPermission' ? { ...permission, owner: zeroAddress } : base.readContract(a as never) }).client;
  const plan = await createPermissionsClient(client, manager).prepareGrant(grantInput());
  assert.equal(plan.calls.length, 3);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0].data }).args, [manager, 0n]);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: plan.calls[1].data }).args, [manager, 60_000_000n]);
});

const expected = { permissionId: salt, owner, agent, recipient: service, amount: 1_000_000n, paymentId };
const paymentLog = {
  address: manager, removed: false,
  topics: encodeEventTopics({ abi: spendingPermissionsAbi, eventName: 'PaymentExecuted', args: { permissionId: salt, owner, paymentId } }),
  data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [agent, service, expected.amount, 10n]),
};
const transferLog = {
  address: INK_USDC, removed: false,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: owner, to: service } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [expected.amount]),
};
const receipt = { status: 'success', logs: [paymentLog, transferLog] } as unknown as TransactionReceipt;
test('requires both exact manager payment event and native USDC transfer', () => {
  assert.equal(receiptMatchesPayment(manager, receipt, expected), true);
  for (const patch of [{ amount: 2_000_000n }, { owner: agent }, { agent: owner }, { recipient: owner }, { paymentId: salt }, { permissionId: paymentId }]) {
    assert.equal(receiptMatchesPayment(manager, receipt, { ...expected, ...patch }), false);
  }
  assert.equal(receiptMatchesPayment(manager, { ...receipt, status: 'reverted' }, expected), false);
  for (const logs of [[paymentLog], [transferLog], [{ ...paymentLog, address: service }, transferLog],
    [paymentLog, { ...transferLog, address: service }], [{ ...paymentLog, removed: true }, transferLog], []]) {
    assert.equal(receiptMatchesPayment(manager, { ...receipt, logs } as TransactionReceipt, expected), false);
  }
});
