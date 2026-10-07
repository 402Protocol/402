import {
  type Address, type Hex, type PublicClient, type TransactionReceipt,
  decodeEventLog, encodeFunctionData, erc20Abi, getAddress, isAddress, zeroAddress,
} from 'viem';
import { jobEscrowAbi } from './abi.js';
export { jobEscrowAbi } from './abi.js';

export const ERC8183_PROFILE = 'erc8183-a078cab5-no-hooks-v1';
export const INK_CHAIN_ID = 57073;
export const INK_USDC = getAddress('0x2D270e6886d130D724215A266106e6832161EAEd');
export const JobStatus = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 } as const;
export type Call = { to: Address; data: Hex; value: 0n };
export type Deployment = { chainId: number; escrow: Address; paymentToken: Address };
export type Plan = { chainId: number; account: Address; calls: Call[] };
// Read capabilities only. viem is a peer dependency shared with the consuming application's client.
export type JobReadClient = Pick<PublicClient, 'getChainId' | 'getCode' | 'readContract' | 'getBlock'>;
export type CreateJob = { provider: Address; evaluator: Address; expiredAt: bigint; description: string };
export type JobAction =
  | ({ kind: 'createJob' } & CreateJob)
  | { kind: 'setProvider'; jobId: bigint; provider: Address }
  | { kind: 'setBudget'; jobId: bigint; amount: bigint }
  | { kind: 'fund'; jobId: bigint; expectedBudget: bigint }
  | { kind: 'submit'; jobId: bigint; deliverable: Hex }
  | { kind: 'complete' | 'reject'; jobId: bigint; reason: Hex }
  | { kind: 'claimRefund'; jobId: bigint };

function address(value: string, allowZero = false): Address {
  if (!isAddress(value) || (!allowZero && getAddress(value) === zeroAddress)) throw new Error('Invalid address');
  return getAddress(value);
}
function uint256(value: bigint, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value >= (1n << 256n)) throw new Error('Invalid uint256');
  return value;
}
function commitment(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Commitment must be bytes32');
  return value as Hex;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Pure calldata construction; no role/state assertion, RPC, signer, or broadcast. Simulate before signing. */
export function buildJobCall(escrow: Address, action: JobAction): Call {
  const to = address(escrow);
  let data: Hex;
  if (action.kind === 'createJob') {
    data = encodeFunctionData({ abi: jobEscrowAbi, functionName: 'createJob', args: [
      address(action.provider, true), address(action.evaluator), uint256(action.expiredAt, true), action.description,
    ] });
  } else {
    const jobId = uint256(action.jobId, true);
    switch (action.kind) {
      case 'setProvider': data = encodeFunctionData({ abi: jobEscrowAbi, functionName: 'setProvider', args: [jobId, address(action.provider)] }); break;
      case 'setBudget': data = encodeFunctionData({ abi: jobEscrowAbi, functionName: 'setBudget', args: [jobId, uint256(action.amount)] }); break;
      case 'fund': data = encodeFunctionData({ abi: jobEscrowAbi, functionName: 'fund', args: [jobId, uint256(action.expectedBudget, true)] }); break;
      case 'submit': data = encodeFunctionData({ abi: jobEscrowAbi, functionName: 'submit', args: [jobId, commitment(action.deliverable)] }); break;
      case 'complete': case 'reject': data = encodeFunctionData({ abi: jobEscrowAbi, functionName: action.kind, args: [jobId, commitment(action.reason)] }); break;
      case 'claimRefund': data = encodeFunctionData({ abi: jobEscrowAbi, functionName: 'claimRefund', args: [jobId] }); break;
    }
  }
  return { to, data, value: 0n };
}

/** Exact (or zero to revoke) approval to the job escrow, never a direct transfer. */
export function approvalCall(deployment: Deployment, amount: bigint): Call {
  return { to: address(deployment.paymentToken), value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address(deployment.escrow), uint256(amount)] }) };
}

/** Receipt-scoped ID, never a simulated return value or a racy read of jobCounter. */
export function createdJobId(escrow: Address, receipt: Pick<TransactionReceipt, 'status' | 'logs'>, expected: CreateJob & { client: Address }): bigint {
  if (receipt.status !== 'success') throw new Error('Job creation reverted');
  const matches: bigint[] = [];
  for (const log of receipt.logs) {
    if (log.removed || !same(log.address, escrow)) continue;
    try {
      const { args } = decodeEventLog({ abi: jobEscrowAbi, eventName: 'JobCreated', data: log.data, topics: log.topics, strict: true });
      if (args.jobId > 0n && same(args.client, expected.client) && same(args.provider, expected.provider)
        && same(args.evaluator, expected.evaluator) && args.expiredAt === expected.expiredAt) matches.push(args.jobId);
    } catch { /* Other events are not evidence. */ }
  }
  if (matches.length !== 1) throw new Error('Expected exactly one matching JobCreated event');
  // Description is not in JobCreated; read getJob at the receipt block if it needs independent verification.
  return matches[0];
}

export function receiptMatchesFunding(deployment: Deployment, receipt: Pick<TransactionReceipt, 'status' | 'logs'>,
  expected: { jobId: bigint; client: Address; amount: bigint }): boolean {
  if (receipt.status !== 'success' || expected.jobId <= 0n || expected.amount <= 0n) return false;
  let funded = false; let transferred = false;
  for (const log of receipt.logs) {
    if (log.removed) continue;
    try {
      if (same(log.address, deployment.escrow)) {
        const { args } = decodeEventLog({ abi: jobEscrowAbi, eventName: 'JobFunded', data: log.data, topics: log.topics, strict: true });
        if (args.jobId === expected.jobId && same(args.client, expected.client) && args.amount === expected.amount) funded = true;
      } else if (same(log.address, deployment.paymentToken)) {
        const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics, strict: true });
        if (same(args.from, expected.client) && same(args.to, deployment.escrow) && args.value === expected.amount) transferred = true;
      }
    } catch { /* A transfer alone never proves job funding. */ }
  }
  return funded && transferred;
}

export function createJobClient(publicClient: JobReadClient, configuration: Deployment) {
  if (!Number.isSafeInteger(configuration.chainId) || configuration.chainId <= 0) throw new Error('Invalid chain ID');
  const deployment = { ...configuration, escrow: address(configuration.escrow), paymentToken: address(configuration.paymentToken) };
  if (same(deployment.escrow, deployment.paymentToken)) throw new Error('Escrow must differ from payment token');
  async function checkDeployment() {
    if (await publicClient.getChainId() !== deployment.chainId) throw new Error('Wrong chain');
    const code = await publicClient.getCode({ address: deployment.escrow });
    if (!code || code === '0x') throw new Error('Job escrow not deployed');
    const [profile, token] = await Promise.all([
      publicClient.readContract({ address: deployment.escrow, abi: jobEscrowAbi, functionName: 'PROFILE' }),
      publicClient.readContract({ address: deployment.escrow, abi: jobEscrowAbi, functionName: 'paymentToken' }),
    ]);
    if (profile !== ERC8183_PROFILE || !same(token, deployment.paymentToken)) throw new Error('Incompatible job escrow profile or token');
    // Interface checks do not verify code identity; pin and verify the chosen deployment separately.
  }
  function plan(account: Address, action: JobAction): Plan {
    return { chainId: deployment.chainId, account: address(account), calls: [buildJobCall(deployment.escrow, action)] };
  }
  async function readJob(jobId: bigint) {
    await checkDeployment();
    const block = await publicClient.getBlock();
    const job = await publicClient.readContract({ address: deployment.escrow, abi: jobEscrowAbi, functionName: 'getJob',
      args: [uint256(jobId, true)], blockNumber: block.number });
    return { job, blockNumber: block.number, timestamp: block.timestamp };
  }
  return {
    deployment, plan, checkDeployment, readJob,
    /** The caller supplies an agreed quote. Never silently substitutes the latest on-chain budget. */
    async prepareFunding(jobId: bigint, client: Address, expectedBudget: bigint): Promise<Plan & { expectedBudget: bigint }> {
      client = address(client); uint256(expectedBudget, true);
      const { job, blockNumber, timestamp } = await readJob(jobId);
      if (!same(job.client, client)) throw new Error('Only the client can fund');
      if (job.status !== JobStatus.Open || timestamp >= job.expiredAt) throw new Error('Job is not open for funding');
      if (job.provider === zeroAddress) throw new Error('Provider must be assigned');
      if (job.budget !== expectedBudget) throw new Error('Budget differs from agreed quote');
      const [allowance, balance] = await Promise.all([
        publicClient.readContract({ address: deployment.paymentToken, abi: erc20Abi, functionName: 'allowance', args: [client, deployment.escrow], blockNumber }),
        publicClient.readContract({ address: deployment.paymentToken, abi: erc20Abi, functionName: 'balanceOf', args: [client], blockNumber }),
      ]);
      if (balance < expectedBudget) throw new Error('Insufficient client token balance');
      const calls: Call[] = [];
      if (allowance !== expectedBudget) {
        if (allowance !== 0n) calls.push(approvalCall(deployment, 0n));
        calls.push(approvalCall(deployment, expectedBudget));
      }
      calls.push(buildJobCall(deployment.escrow, { kind: 'fund', jobId, expectedBudget }));
      return { chainId: deployment.chainId, account: client, calls, expectedBudget };
    },
  };
}
