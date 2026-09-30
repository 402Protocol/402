/**
 * 402 Job Marketplace — worker helpers unit tests.
 *
 *   npx tsx test/worker.test.ts
 *
 * Pure builders: exact onchain calldata, EIP-712 signing round-trips,
 * job picking, receipt parsing. No network, no keys beyond throwaways
 * generated in-process.
 */
import assert from 'node:assert/strict';
import {
  getAddress,
  keccak256,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  BOUNTY_ESCROW_ADDRESS,
  CLAIM_STAKE_BASE_UNITS,
  IDENTITY_REGISTRY_ADDRESS,
  claimTxPlan,
  confirmDeliveryPlan,
  decodeWorkerCalldata,
  encodeApproveCalldata,
  encodeClaimBountyCalldata,
  encodeConfirmDeliveryCalldata,
  encodeRegisterCalldata,
  encodeWithdrawCalldata,
  parseMintedTokenId,
  pickJob,
  signJobClaim,
  signJobEnroll,
  signJobSubmit,
  signReviewAttestation,
  withdrawPlan,
  type WorkerJobListing,
} from '../src/jobs/worker.js';
import { verifyLoungeSignature } from '../src/lounge/signing.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const worker = privateKeyToAccount(generatePrivateKey());
const nowSec = () => Math.floor(Date.now() / 1000);
const ESCROW = getAddress(BOUNTY_ESCROW_ADDRESS);
const USDC = getAddress('0x2D270e6886d130D724215A266106e6832161EAEd');

await check('approve calldata is exactly $1 (1_000_000) to the escrow', () => {
  const data = encodeApproveCalldata(ESCROW, CLAIM_STAKE_BASE_UNITS);
  const decoded = decodeWorkerCalldata(data);
  assert.equal(decoded.functionName, 'approve');
  assert.deepEqual(decoded.args, [ESCROW, 1_000_000n]);
});

await check('claimBounty calldata binds escrow job id + agent id', () => {
  const data = encodeClaimBountyCalldata(42n, 7n);
  const decoded = decodeWorkerCalldata(data);
  assert.equal(decoded.functionName, 'claimBounty');
  assert.deepEqual(decoded.args, [42n, 7n]);
});

await check('confirmDelivery calldata carries the escrow job id', () => {
  const decoded = decodeWorkerCalldata(encodeConfirmDeliveryCalldata(42n));
  assert.equal(decoded.functionName, 'confirmDelivery');
  assert.deepEqual(decoded.args, [42n]);
});

await check('withdraw calldata is claim(escrowJobId)', () => {
  const decoded = decodeWorkerCalldata(encodeWithdrawCalldata(42n));
  assert.equal(decoded.functionName, 'claim');
  assert.deepEqual(decoded.args, [42n]);
});

await check('claimTxPlan: approve-then-claimBounty with exact amounts', () => {
  const plan = claimTxPlan(42n, 7n);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].to, USDC);
  const approve = decodeWorkerCalldata(plan[0].data);
  assert.equal(approve.functionName, 'approve');
  assert.deepEqual(approve.args, [ESCROW, 1_000_000n]);
  assert.equal(plan[1].to, ESCROW);
  const claim = decodeWorkerCalldata(plan[1].data);
  assert.equal(claim.functionName, 'claimBounty');
  assert.deepEqual(claim.args, [42n, 7n]);
});

await check('confirmDeliveryPlan / withdrawPlan target the escrow', () => {
  const cd = confirmDeliveryPlan(42n);
  assert.equal(cd.to, ESCROW);
  assert.equal(decodeWorkerCalldata(cd.data).functionName, 'confirmDelivery');
  const wd = withdrawPlan(42n);
  assert.equal(wd.to, ESCROW);
  assert.equal(decodeWorkerCalldata(wd.data).functionName, 'claim');
});

await check('register calldata targets the IdentityRegistry', () => {
  assert.equal(getAddress(IDENTITY_REGISTRY_ADDRESS), getAddress('0x7274e874CA62410a93Bd8bf61c69d8045E399c02'));
  const data = encodeRegisterCalldata('https://example.com/card.json');
  assert.ok(data.startsWith('0x'));
});

await check('signJobEnroll round-trips through the API verifier', async () => {
  const signed = await signJobEnroll(worker, 7n);
  assert.equal(signed.author, worker.address);
  assert.ok(Math.abs(signed.timestamp - nowSec()) < 300);
  const pre = await verifyLoungeSignature({
    primaryType: 'JobEnroll',
    message: { wallet: worker.address, agentId: 7n, timestamp: BigInt(signed.timestamp) },
    signature: signed.signature,
    author: worker.address,
  });
  assert.equal(pre.ok, true, (pre as { reason?: string }).reason ?? 'precheck failed');
});

await check('signReviewAttestation round-trips through the API verifier', async () => {
  const signed = await signReviewAttestation(worker, 9n, 101n, true, 88);
  const pre = await verifyLoungeSignature({
    primaryType: 'ReviewAttestation',
    message: {
      jobId: 9n,
      reviewer: worker.address,
      agentId: 101n,
      verdict: true,
      score: 88,
      timestamp: BigInt(signed.timestamp),
    },
    signature: signed.signature,
    author: worker.address,
  });
  assert.equal(pre.ok, true, (pre as { reason?: string }).reason ?? 'precheck failed');
  assert.throws(() => signReviewAttestation(worker, 9n, 101n, true, 101), /score/);
});

await check('signJobClaim round-trips through the API verifier', async () => {
  const signed = await signJobClaim(worker, 3n, 7n);
  const pre = await verifyLoungeSignature({
    primaryType: 'JobClaim',
    message: { jobId: 3n, worker: worker.address, agentId: 7n, timestamp: BigInt(signed.timestamp) },
    signature: signed.signature,
    author: worker.address,
  });
  assert.equal(pre.ok, true, (pre as { reason?: string }).reason ?? 'precheck failed');
});

await check('signJobSubmit round-trips through the API verifier', async () => {
  const contentHash = keccak256(toHex('work'));
  const signed = await signJobSubmit(worker, 3n, contentHash, 'ipfs://bafytest');
  const pre = await verifyLoungeSignature({
    primaryType: 'JobSubmit',
    message: {
      jobId: 3n,
      author: worker.address,
      contentHash,
      uri: 'ipfs://bafytest',
      timestamp: BigInt(signed.timestamp),
    },
    signature: signed.signature,
    author: worker.address,
  });
  assert.equal(pre.ok, true, (pre as { reason?: string }).reason ?? 'precheck failed');
});

function listing(over: Partial<WorkerJobListing> = {}): WorkerJobListing {
  return {
    id: 1,
    escrowJobId: '1',
    title: 'job',
    category: 'writing',
    bountyUsdc: '10.00',
    state: 'open',
    deadline: 1893456000,
    ...over,
  };
}

await check('pickJob: highest bounty first, filters state/category/floor', () => {
  const jobs = [
    listing({ id: 1, category: 'writing', bountyUsdc: '5.00', state: 'open' }),
    listing({ id: 2, category: 'writing', bountyUsdc: '25.00', state: 'open' }),
    listing({ id: 3, category: 'writing', bountyUsdc: '50.00', state: 'claimed' }),
    listing({ id: 4, category: 'code', bountyUsdc: '100.00', state: 'open' }),
    listing({ id: 5, category: 'writing', bountyUsdc: '1.00', state: 'open' }),
  ];
  const picked = pickJob(jobs, { categories: ['writing'], minBountyUsdc: '2' });
  assert.ok(picked);
  assert.equal(picked.id, 2);
});

await check('pickJob: null when nothing is eligible', () => {
  assert.equal(pickJob([listing({ state: 'claimed' })]), null);
  assert.equal(pickJob([listing({ category: 'code' })], { categories: ['writing'] }), null);
  assert.equal(pickJob([listing({ bountyUsdc: '0.50' })], { minBountyUsdc: '5' }), null);
});

await check('parseMintedTokenId: extracts the agent id from a register receipt', () => {
  const mintTopic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const logs = [
    {
      topics: [
        keccak256(toHex('Transfer(address,address,uint256)')),
        mintTopic('0x0000000000000000000000000000000000000000'),
        mintTopic(worker.address),
        `0x${(42n).toString(16).padStart(64, '0')}`,
      ],
    },
  ];
  assert.equal(parseMintedTokenId(logs), 42n);
});

await check('parseMintedTokenId: null when there is no mint log', () => {
  const mintTopic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const logs = [
    {
      topics: [
        keccak256(toHex('Transfer(address,address,uint256)')),
        mintTopic(worker.address),
        mintTopic('0x00000000000000000000000000000000000000e5'),
        `0x${(1n).toString(16).padStart(64, '0')}`,
      ],
    },
  ];
  assert.equal(parseMintedTokenId(logs), null);
  assert.equal(parseMintedTokenId([]), null);
});

console.log(`\n${passed} worker helper checks passed.`);
