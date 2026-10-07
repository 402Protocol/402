/** Local-only integration: real bytecode + SDK + browser-provider flow; no production keys or RPC. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Address, type EIP1193Provider, type Hex, createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { INK_USDC, createPermissionsClient, ink, spendingPermissionsAbi } from '../packages/agent-permissions/src/index.js';
import { connectOwnerWallet } from '../packages/agent-permissions/src/wallet.js';

const artifact = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const managerArtifact = artifact('../out/Four02SpendingPermissions.sol/Four02SpendingPermissions.json');
const tokenArtifact = artifact('../out/Four02SpendingPermissions.t.sol/SpendingTestToken.json');
const processAnvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '0', '--chain-id', '57073', '--accounts', '0', '--block-time', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const rpcUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local Anvil did not start')), 15000);
    let output = '';
    processAnvil.stdout.on('data', (chunk) => { output += chunk.toString(); const match = output.match(/Listening on (127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://${match[1]}`); } });
    processAnvil.once('error', (error) => { clearTimeout(timeout); reject(error); });
    processAnvil.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Anvil exited: ${code}`)); });
  });
  const publicClient = createPublicClient({ chain: ink, transport: http(rpcUrl), pollingInterval: 100 });
  const testClient = createTestClient({ chain: ink, mode: 'anvil', transport: http(rpcUrl) });
  const owner = privateKeyToAccount(generatePrivateKey()); const agent = privateKeyToAccount(generatePrivateKey());
  const service = privateKeyToAccount(generatePrivateKey()).address;
  for (const account of [owner, agent]) await testClient.setBalance({ address: account.address, value: parseEther('10') });
  const ownerSigner = createWalletClient({ account: owner, chain: ink, transport: http(rpcUrl) });
  const agentSigner = createWalletClient({ account: agent, chain: ink, transport: http(rpcUrl) });
  const tokenDeployment = await publicClient.waitForTransactionReceipt({ hash: await ownerSigner.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object }) });
  await testClient.setCode({ address: INK_USDC, bytecode: (await publicClient.getCode({ address: tokenDeployment.contractAddress! }))! });
  const deployed = await publicClient.waitForTransactionReceipt({ hash: await ownerSigner.deployContract({ abi: managerArtifact.abi,
    bytecode: managerArtifact.bytecode.object, args: [INK_USDC] }) });
  const manager = deployed.contractAddress!;
  await publicClient.waitForTransactionReceipt({ hash: await ownerSigner.writeContract({ address: INK_USDC, abi: tokenArtifact.abi, functionName: 'mint', args: [owner.address, 100_000_000n] }) });
  let approvalPrompts = 0;
  const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner.address];
    if (method === 'eth_chainId') return '0xdef1';
    if (method === 'eth_sendTransaction') {
      approvalPrompts++;
      const tx = params![0] as { from: Address; to: Address; data: Hex; value?: Hex };
      assert.equal(tx.from.toLowerCase(), owner.address.toLowerCase());
      return ownerSigner.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? '0x0') });
    }
    return publicClient.request({ method, params } as never);
  } } as EIP1193Provider;
  const connected = await connectOwnerWallet(provider, publicClient, manager);
  const now = Number((await publicClient.getBlock()).timestamp);
  const { permissionId } = await connected.grant({ agent: agent.address, dailyLimitUsdc: '20', validAfter: now,
    validUntil: now + 3 * 86400, recipients: [service], salt: `0x${'01'.repeat(32)}` });
  assert.equal(approvalPrompts, 2, 'owner confirms finite token approval and grant');
  const sdk = createPermissionsClient(publicClient, manager);
  assert.equal((await sdk.status(permissionId)).available, 20_000_000n);
  const paymentId = `0x${'02'.repeat(32)}` as Hex;
  const payment = await sdk.preparePayment({ permissionId, recipient: service, amountUsdc: '12', paymentId });
  const hash = await agentSigner.sendTransaction(payment.call);
  await sdk.confirmPayment(hash, payment.expected);
  await assert.rejects(sdk.confirmPayment(hash, { ...payment.expected, amount: 1n }), /exact payment/);
  await assert.rejects(sdk.preparePayment({ permissionId, recipient: service, amountUsdc: '12', paymentId }));
  await assert.rejects(sdk.preparePayment({ permissionId, recipient: service, amountUsdc: '9', paymentId: `0x${'03'.repeat(32)}` }));
  assert.equal((await sdk.status(permissionId)).remainingToday, 8_000_000n);
  assert.equal(await publicClient.readContract({ address: INK_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [service] }), 12_000_000n);
  await connected.revoke(permissionId);
  assert.equal((await sdk.status(permissionId)).available, 0n);
  await assert.rejects(sdk.preparePayment({ permissionId, recipient: service, amountUsdc: '1', paymentId: `0x${'04'.repeat(32)}` }));
  await connected.revokeTokenApproval();
  assert.equal(await publicClient.readContract({ address: INK_USDC, abi: erc20Abi, functionName: 'allowance', args: [owner.address, manager] }), 0n);
  assert.equal((await publicClient.readContract({ address: manager, abi: spendingPermissionsAbi, functionName: 'getPermission', args: [permissionId] })).revoked, true);
  console.log('PASS: wallet connection → finite approval → grant → agent payment → exact receipt → overspend/duplicate rejection → owner revocation → zero token approval');
} finally {
  processAnvil.kill('SIGTERM');
}
