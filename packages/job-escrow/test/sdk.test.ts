import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Address, type Hex, type Log, type PublicClient, decodeFunctionData, encodeAbiParameters,
  encodeEventTopics, erc20Abi, zeroAddress } from 'viem';
import { ERC8183_PROFILE, JobStatus, approvalCall, buildJobCall, createJobClient, createdJobId,
  jobEscrowAbi, receiptMatchesFunding, type JobAction } from '../src/index.js';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const client = a(1), provider = a(2), evaluator = a(3), escrow = a(4), paymentToken = a(5);
const deployment = { chainId: 57073, escrow, paymentToken };
const zero = `0x${'00'.repeat(32)}` as Hex;
const job = { id: 1n, client, provider, evaluator, description: 'brief', budget: 10n, expiredAt: 200n, status: 0 };
const creation = { client, provider, evaluator, expiredAt: 200n, description: 'brief' };
function log(address: Address, topics: readonly (Hex | Hex[] | null)[], data: Hex, removed = false): Log<bigint, number, false> {
  assert.ok(topics.every(topic => typeof topic === 'string'));
  return { address, topics: [...topics] as [Hex, ...Hex[]], data, removed, blockHash: zero, blockNumber: 1n,
    transactionHash: zero, transactionIndex: 0, logIndex: 0 };
}
const created = log(escrow, encodeEventTopics({ abi: jobEscrowAbi, eventName: 'JobCreated', args: { jobId: 1n, client, provider } }),
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [evaluator, 200n]));
const funded = log(escrow, encodeEventTopics({ abi: jobEscrowAbi, eventName: 'JobFunded', args: { jobId: 1n, client } }),
  encodeAbiParameters([{ type: 'uint256' }], [10n]));
const transfer = log(paymentToken, encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: client, to: escrow } }),
  encodeAbiParameters([{ type: 'uint256' }], [10n]));

function mock(overrides: { chainId?: number; code?: Hex; profile?: string; token?: Address; job?: typeof job; allowance?: bigint; balance?: bigint; timestamp?: bigint } = {}) {
  const reads: { functionName: string; blockNumber?: bigint }[] = [];
  const rpc = {
    getChainId: async () => overrides.chainId ?? deployment.chainId,
    getCode: async () => overrides.code ?? '0x1234',
    getBlock: async () => ({ number: 100n, timestamp: overrides.timestamp ?? 100n }),
    readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
      reads.push(request);
      const values: Record<string, unknown> = { PROFILE: overrides.profile ?? ERC8183_PROFILE,
        paymentToken: overrides.token ?? paymentToken, getJob: overrides.job ?? job,
        allowance: overrides.allowance ?? 0n, balanceOf: overrides.balance ?? 10n };
      assert.ok(request.functionName in values); return values[request.functionName];
    },
  } as unknown as PublicClient;
  return { sdk: createJobClient(rpc, deployment), reads };
}

test('core selectors and arguments match the chosen no-hooks ABI', () => {
  const cases: [JobAction, string, unknown[]][] = [
    [{ kind: 'createJob', ...creation }, 'createJob', [provider, evaluator, 200n, 'brief']],
    [{ kind: 'setProvider', jobId: 1n, provider }, 'setProvider', [1n, provider]],
    [{ kind: 'setBudget', jobId: 1n, amount: 10n }, 'setBudget', [1n, 10n]],
    [{ kind: 'fund', jobId: 1n, expectedBudget: 10n }, 'fund', [1n, 10n]],
    [{ kind: 'submit', jobId: 1n, deliverable: zero }, 'submit', [1n, zero]],
    [{ kind: 'complete', jobId: 1n, reason: zero }, 'complete', [1n, zero]],
    [{ kind: 'reject', jobId: 1n, reason: zero }, 'reject', [1n, zero]],
    [{ kind: 'claimRefund', jobId: 1n }, 'claimRefund', [1n]],
  ];
  for (const [action, functionName, args] of cases) {
    const call = buildJobCall(escrow, action);
    assert.equal(call.to, escrow); assert.equal(call.value, 0n);
    assert.deepEqual(decodeFunctionData({ abi: jobEscrowAbi, data: call.data }), { functionName, args });
  }
  assert.doesNotThrow(() => buildJobCall(escrow, { kind: 'createJob', ...creation, provider: zeroAddress }));
  assert.doesNotThrow(() => buildJobCall(escrow, { kind: 'setBudget', jobId: 1n, amount: 0n }));
});

test('invalid input cannot silently encode zero IDs, bad commitments, amounts or evaluator', () => {
  for (const jobId of [0n, -1n, 1n << 256n]) assert.throws(() => buildJobCall(escrow, { kind: 'claimRefund', jobId }));
  for (const amount of [0n, -1n, 1n << 256n]) assert.throws(() => buildJobCall(escrow, { kind: 'fund', jobId: 1n, expectedBudget: amount }));
  assert.throws(() => buildJobCall(escrow, { kind: 'createJob', ...creation, evaluator: zeroAddress }));
  assert.throws(() => buildJobCall(escrow, { kind: 'setProvider', jobId: 1n, provider: zeroAddress }));
  assert.throws(() => buildJobCall(escrow, { kind: 'submit', jobId: 1n, deliverable: '0x12' }));
  assert.throws(() => buildJobCall(zeroAddress, { kind: 'claimRefund', jobId: 1n }));
  assert.throws(() => approvalCall(deployment, -1n));
});

test('creation IDs require one exact event from the chosen escrow in a successful receipt', () => {
  assert.equal(createdJobId(escrow, { status: 'success', logs: [created] }, creation), 1n);
  for (const logs of [[], [{ ...created, address: a(9) }], [{ ...created, removed: true }], [created, created], [{ ...created, data: '0x' as Hex }]]) {
    assert.throws(() => createdJobId(escrow, { status: 'success', logs }, creation));
  }
  assert.throws(() => createdJobId(escrow, { status: 'reverted', logs: [created] }, creation));
  for (const expected of [{ ...creation, client: a(9) }, { ...creation, provider: a(9) }, { ...creation, evaluator: a(9) }, { ...creation, expiredAt: 201n }]) {
    assert.throws(() => createdJobId(escrow, { status: 'success', logs: [created] }, expected));
  }
});

test('a token transfer alone, another job, wrong amount or failed receipt is not funding', () => {
  const expected = { jobId: 1n, client, amount: 10n };
  assert.equal(receiptMatchesFunding(deployment, { status: 'success', logs: [transfer, funded] }, expected), true);
  for (const logs of [[transfer], [funded], [{ ...funded, address: a(9) }, transfer], [funded, { ...transfer, address: a(9) }],
    [{ ...funded, removed: true }, transfer], [funded, { ...transfer, data: '0x' as Hex }]]) {
    assert.equal(receiptMatchesFunding(deployment, { status: 'success', logs }, expected), false);
  }
  for (const mismatch of [{ ...expected, jobId: 2n }, { ...expected, client: a(9) }, { ...expected, amount: 11n }, { ...expected, amount: 0n }]) {
    assert.equal(receiptMatchesFunding(deployment, { status: 'success', logs: [funded, transfer] }, mismatch), false);
  }
  assert.equal(receiptMatchesFunding(deployment, { status: 'reverted', logs: [funded, transfer] }, expected), false);
});

test('funding plans use exact approval and explicit client/chain with a consistent snapshot', async () => {
  for (const allowance of [0n, 1n, 10n, 100n]) {
    const { sdk, reads } = mock({ allowance });
    const plan = await sdk.prepareFunding(1n, client, 10n);
    assert.equal(plan.chainId, 57073); assert.equal(plan.account, client); assert.equal(plan.expectedBudget, 10n);
    const approvals = plan.calls.slice(0, -1).map(call => {
      assert.equal(call.to, paymentToken);
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
      assert.equal(decoded.functionName, 'approve'); return decoded.args;
    });
    assert.deepEqual(approvals, allowance === 10n ? [] : allowance === 0n ? [[escrow, 10n]] : [[escrow, 0n], [escrow, 10n]]);
    assert.deepEqual(decodeFunctionData({ abi: jobEscrowAbi, data: plan.calls.at(-1)!.data }), { functionName: 'fund', args: [1n, 10n] });
    assert.ok(reads.filter(r => ['getJob', 'balanceOf', 'allowance'].includes(r.functionName)).every(r => r.blockNumber === 100n));
  }
});

test('funding rejects wrong roles, stale quotes, missing provider, deadline and short balance', async () => {
  await assert.rejects(mock().sdk.prepareFunding(1n, provider, 10n), /Only the client/);
  await assert.rejects(mock().sdk.prepareFunding(1n, client, 11n), /quote/);
  await assert.rejects(mock().sdk.prepareFunding(1n, client, 0n), /uint256/);
  await assert.rejects(mock({ job: { ...job, provider: zeroAddress } }).sdk.prepareFunding(1n, client, 10n), /Provider/);
  await assert.rejects(mock({ timestamp: 200n }).sdk.prepareFunding(1n, client, 10n), /not open/);
  await assert.rejects(mock({ balance: 9n }).sdk.prepareFunding(1n, client, 10n), /balance/);
  for (const status of [JobStatus.Funded, JobStatus.Submitted, JobStatus.Completed, JobStatus.Rejected, JobStatus.Expired]) {
    await assert.rejects(mock({ job: { ...job, status } }).sdk.prepareFunding(1n, client, 10n), /not open/);
  }
});

test('read helpers reject wrong chain, absent code, different draft profile or token', async () => {
  for (const overrides of [{ chainId: 1 }, { code: '0x' as Hex }, { profile: 'some-other-8183' }, { token: a(9) }]) {
    await assert.rejects(mock(overrides).sdk.readJob(1n));
  }
  const { sdk } = mock();
  const plan = sdk.plan(provider, { kind: 'submit', jobId: 1n, deliverable: zero });
  assert.equal(plan.account, provider); assert.equal(plan.chainId, 57073);
  assert.equal((await sdk.readJob(1n)).job.description, 'brief');
  assert.throws(() => createJobClient({} as PublicClient, { ...deployment, chainId: NaN }));
  assert.throws(() => createJobClient({} as PublicClient, { ...deployment, escrow: paymentToken }));
});
