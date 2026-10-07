/** Local EVM only: independent buyer/provider/evaluator, no external RPC, services or production keys. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeErrorResult, erc20Abi, http,
  keccak256, parseEther, stringToHex, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createJobClient, createdJobId, jobEscrowAbi, JobStatus, receiptMatchesFunding, type Plan } from '../packages/job-escrow/src/index.js';

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../out/${name}`, import.meta.url), 'utf8'));
const jobArtifact = artifact('Four02JobEscrow.sol/Four02JobEscrow.json');
const tokenArtifact = artifact('Four02JobEscrow.t.sol/JobTestToken.json');
const chain = defineChain({ id: 31337, name: 'Disposable local jobs', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
// The port is assigned by the OS; this script does not accept RPC or private-key arguments/environment.
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '0', '--chain-id', '31337', '--accounts', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const rpc = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local Anvil startup timed out')), 15_000);
    let output = '';
    anvil.stdout.on('data', chunk => {
      output += chunk.toString(); const match = output.match(/Listening on (127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); }
    });
    anvil.once('error', error => { clearTimeout(timer); reject(error); });
    anvil.once('exit', code => { clearTimeout(timer); reject(new Error(`Local Anvil exited: ${code}`)); });
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 });
  const testClient = createTestClient({ chain, mode: 'anvil', transport: http(rpc) });
  const buyer = privateKeyToAccount(generatePrivateKey());
  const provider = privateKeyToAccount(generatePrivateKey());
  const evaluator = privateKeyToAccount(generatePrivateKey());
  const wallets = [buyer, provider, evaluator].map(account => createWalletClient({ account, chain, transport: http(rpc) }));
  for (const account of [buyer, provider, evaluator]) await testClient.setBalance({ address: account.address, value: parseEther('10') });
  async function confirmed(hash: Hex) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success'); return receipt;
  }
  const tokenReceipt = await confirmed(await wallets[0].deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object }));
  const paymentToken = tokenReceipt.contractAddress!;
  const escrowReceipt = await confirmed(await wallets[0].deployContract({ abi: jobArtifact.abi, bytecode: jobArtifact.bytecode.object, args: [paymentToken] }));
  const escrow = escrowReceipt.contractAddress!;
  await confirmed(await wallets[0].writeContract({ address: paymentToken, abi: tokenArtifact.abi, functionName: 'mint', args: [buyer.address, 100_000_000n] }));
  const sdk = createJobClient(publicClient, { chainId: 31337, escrow, paymentToken });
  await sdk.checkDeployment();

  // An external runtime can supply its own signer here. Every plan binds chain and actor;
  // each call is simulated and its receipt checked before executing the next call.
  async function execute(plan: Plan): Promise<TransactionReceipt> {
    assert.equal(await publicClient.getChainId(), plan.chainId);
    const wallet = wallets.find(w => w.account.address.toLowerCase() === plan.account.toLowerCase());
    assert.ok(wallet, 'Use the correct role wallet');
    let receipt: TransactionReceipt | undefined;
    for (const call of plan.calls) {
      await publicClient.call({ account: wallet.account.address, ...call });
      receipt = await confirmed(await wallet.sendTransaction(call));
    }
    assert.ok(receipt); return receipt;
  }
  const reason = keccak256(stringToHex('Evaluator reviewed the deliverable against the agreed brief.'));
  const deliverable = keccak256(stringToHex('Local example output; hashes alone are not proof of quality.'));
  const revertsWith = (errorName: 'Unauthorized' | 'DeadlinePassed') => (error: unknown) =>
    error instanceof Error && error.message.includes(encodeErrorResult({ abi: jobEscrowAbi, errorName }));
  const budget = 10_000_000n; // 10 mock USDC, never a float or an unbounded approval.
  async function newFundedJob(lateProvider = false) {
    const input = { provider: lateProvider ? zeroAddress : provider.address, evaluator: evaluator.address,
      expiredAt: (await publicClient.getBlock()).timestamp + 3600n, description: 'External service: return the agreed report' };
    const receipt = await execute(sdk.plan(buyer.address, { kind: 'createJob', ...input }));
    const jobId = createdJobId(escrow, receipt, { ...input, client: buyer.address });
    if (lateProvider) await execute(sdk.plan(buyer.address, { kind: 'setProvider', jobId, provider: provider.address }));
    await execute(sdk.plan(provider.address, { kind: 'setBudget', jobId, amount: budget }));
    const funding = await execute(await sdk.prepareFunding(jobId, buyer.address, budget));
    assert.ok(receiptMatchesFunding(sdk.deployment, funding, { jobId, client: buyer.address, amount: budget }));
    assert.equal(await publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: 'allowance', args: [buyer.address, escrow] }), 0n);
    return jobId;
  }
  const paidJob = await newFundedJob(true);
  await execute(sdk.plan(provider.address, { kind: 'submit', jobId: paidJob, deliverable }));
  await assert.rejects(execute(sdk.plan(buyer.address, { kind: 'complete', jobId: paidJob, reason })), revertsWith('Unauthorized'));
  await execute(sdk.plan(evaluator.address, { kind: 'complete', jobId: paidJob, reason }));
  assert.equal((await sdk.readJob(paidJob)).job.status, JobStatus.Completed);
  console.log('PASS: external buyer creates/assigns/funds → provider submits → evaluator completes; client cannot self-approve.');

  for (const submitFirst of [false, true]) {
    const jobId = await newFundedJob();
    if (submitFirst) await execute(sdk.plan(provider.address, { kind: 'submit', jobId, deliverable }));
    await execute(sdk.plan(evaluator.address, { kind: 'reject', jobId, reason }));
    assert.equal((await sdk.readJob(jobId)).job.status, JobStatus.Rejected);
  }
  console.log('PASS: evaluator rejection before and after submission refunds the full budget.');

  for (const submitFirst of [false, true]) {
    const jobId = await newFundedJob();
    if (submitFirst) await execute(sdk.plan(provider.address, { kind: 'submit', jobId, deliverable }));
    const { job } = await sdk.readJob(jobId);
    await testClient.setNextBlockTimestamp({ timestamp: job.expiredAt }); await testClient.mine({ blocks: 1 });
    if (submitFirst) await assert.rejects(execute(sdk.plan(evaluator.address, { kind: 'complete', jobId, reason })), revertsWith('DeadlinePassed'));
    await execute(sdk.plan(provider.address, { kind: 'claimRefund', jobId }));
    assert.equal((await sdk.readJob(jobId)).job.status, JobStatus.Expired);
  }
  const balance = (owner: Address) => publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  assert.equal(await balance(buyer.address), 90_000_000n);
  assert.equal(await balance(provider.address), 10_000_000n);
  assert.equal(await balance(evaluator.address), 0n); assert.equal(await balance(escrow), 0n);
  assert.equal(await publicClient.readContract({ address: escrow, abi: jobEscrowAbi, functionName: 'totalEscrowed' }), 0n);
  console.log('PASS: anyone can trigger Funded/Submitted refunds at expiry; final balances buyer=90, provider=10, evaluator=0, escrow=0 mock USDC.');
} finally {
  anvil.kill('SIGTERM');
}
