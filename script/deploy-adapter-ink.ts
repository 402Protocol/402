/**
 * Deploys the ERC-8217 agent-binding adapter (Adapter8004, UUPS) to Ink mainnet.
 *
 * Deployer: 402 Manager wallet (founder-authorized 2026-10-04; key from
 * FOUR02_MANAGER_KEY env or ~/workspace/402/.manager.env — never logged).
 * The proxy is initialized with the canonical Ink ERC-8004 identity registry
 * and the deployer as admin; admin is then transferred to the TRACES owner
 * wallet, so upgrade/registry-repoint authority sits with the founder.
 *
 * Source: github.com/nxt3d/adapter (MIT), compiled locally via forge.
 *
 * Usage: npx tsx script/deploy-adapter-ink.ts
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const INK_RPC = 'https://rpc-gel.inkonchain.com';
const ink = {
  id: 57073,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [INK_RPC] } },
} as const;

const IDENTITY_REGISTRY = '0x7274e874CA62410a93Bd8bf61c69d8045E399c02';
const NEW_ADMIN = '0x31ec2ade8eb97a89e9a1e76195da6665c3a14f5b'; // TRACES owner wallet

function loadKey(): `0x${string}` {
  const fromEnv = (process.env.FOUR02_MANAGER_KEY || '').trim();
  if (fromEnv) return fromEnv as `0x${string}`;
  const text = readFileSync('/home/hatch/workspace/402/.manager.env', 'utf8');
  const m = text.match(/^\s*FOUR02_MANAGER_KEY\s*=\s*(\S+)\s*$/m);
  if (!m) throw new Error('FOUR02_MANAGER_KEY not found');
  return m[1] as `0x${string}`;
}

async function main() {
  const adapterArtifact = JSON.parse(
    readFileSync('/tmp/adapter/out/Adapter8004.sol/Adapter8004.json', 'utf8'),
  );
  const proxyArtifact = JSON.parse(
    readFileSync('/tmp/adapter/out/ERC1967Proxy.sol/ERC1967Proxy.json', 'utf8'),
  );
  const account = privateKeyToAccount(loadKey());
  console.log('deployer:', account.address);

  const publicClient = createPublicClient({ chain: ink, transport: http(INK_RPC) });
  const walletClient = createWalletClient({ account, chain: ink, transport: http(INK_RPC) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log('deployer balance (ETH):', Number(balance) / 1e18);

  // 1. Deploy the implementation.
  const implHash = await walletClient.deployContract({
    abi: adapterArtifact.abi,
    bytecode: adapterArtifact.bytecode.object as Hex,
    args: [],
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  const implementation = implReceipt.contractAddress!;
  console.log('implementation:', implementation);

  // 2. Deploy the ERC1967 proxy, initializing with (registry, deployer-as-admin).
  const initData = encodeFunctionData({
    abi: adapterArtifact.abi,
    functionName: 'initialize',
    args: [IDENTITY_REGISTRY, account.address],
  });
  const proxyHash = await walletClient.deployContract({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode.object as Hex,
    args: [implementation, initData],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  const proxy = proxyReceipt.contractAddress!;
  console.log('proxy (adapter):', proxy);

  // 3. Verify wiring through the proxy.
  const registryOnchain = (await publicClient.readContract({
    address: proxy,
    abi: adapterArtifact.abi,
    functionName: 'identityRegistry',
  })) as string;
  const ownerOnchain = (await publicClient.readContract({
    address: proxy,
    abi: adapterArtifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('identityRegistry:', registryOnchain);
  console.log('owner:', ownerOnchain);
  if (registryOnchain.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase())
    throw new Error('registry mismatch');
  if (ownerOnchain.toLowerCase() !== account.address.toLowerCase())
    throw new Error('owner mismatch');

  // 4. Hand admin to the founder's TRACES owner wallet.
  const transferHash = await walletClient.writeContract({
    address: proxy,
    abi: adapterArtifact.abi,
    functionName: 'transferOwnership',
    args: [NEW_ADMIN],
  });
  await publicClient.waitForTransactionReceipt({ hash: transferHash });
  const finalOwner = (await publicClient.readContract({
    address: proxy,
    abi: adapterArtifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('new owner:', finalOwner);
  if (finalOwner.toLowerCase() !== NEW_ADMIN.toLowerCase())
    throw new Error('ownership transfer failed — new owner must accept or check');

  console.log('DONE. Adapter proxy:', proxy);
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
