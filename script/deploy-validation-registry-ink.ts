/**
 * Deploys the ERC-8004 ValidationRegistry (UUPS) to Ink mainnet.
 *
 * Deployer: 402 Manager wallet (founder-authorized 2026-10-04; key from
 * FOUR02_MANAGER_KEY env or ~/workspace/402/.manager.env — never logged).
 *
 * What it does (mirrors the 8004 team's own vanity-deployment flow, with the
 * deployer as owner instead of the 8004 team's hardcoded address):
 *   1. Deploy PlaceholderUUPS implementation (minimal UUPS, owner = deployer).
 *   2. Deploy ERC1967 proxy -> placeholder, initialized with
 *      (deployer, Ink identity registry).
 *   3. Deploy the official ValidationRegistryUpgradeable implementation
 *      (source-identical to erc-8004/erc-8004-contracts).
 *   4. upgradeToAndCall -> official implementation, initialize(registry).
 *   5. Verify wiring through the proxy.
 *   6. Transfer ownership to the founder's wallet.
 *
 * Why the placeholder dance: the official initialize() is `reinitializer(2)
 * onlyOwner`, so it can only run where an owner is already set — the 8004
 * team's flow assumes their pre-owned MinimalUUPS placeholder. The
 * placeholder sets our owner first, then hands off to the real code.
 *
 * Source: github.com/erc-8004/erc-8004-contracts (CC0), compiled locally via forge.
 * Ink had no working validation registry before this (only a never-initialized
 * implementation deployed 2026-03-06, zero txs).
 *
 * Usage: npx tsx script/deploy-validation-registry-ink.ts
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
const NEW_ADMIN = '0x31ec2ade8eb97a89e9a1e76195da6665c3a14f5b'; // founder wallet (same as adapter)

const OUT = '/tmp/valdeploy/out';

function loadKey(): `0x${string}` {
  const fromEnv = (process.env.FOUR02_MANAGER_KEY || '').trim();
  if (fromEnv) return fromEnv as `0x${string}`;
  const text = readFileSync('/home/hatch/workspace/402/.manager.env', 'utf8');
  const m = text.match(/^\s*FOUR02_MANAGER_KEY\s*=\s*(\S+)\s*$/m);
  if (!m) throw new Error('FOUR02_MANAGER_KEY not found');
  return m[1] as `0x${string}`;
}

function artifact(name: string) {
  return JSON.parse(readFileSync(`${OUT}/${name}.sol/${name}.json`, 'utf8'));
}

async function main() {
  const placeholderArtifact = artifact('PlaceholderUUPS');
  const validationArtifact = artifact('ValidationRegistryUpgradeable');
  const proxyArtifact = artifact('ERC1967Proxy');

  const account = privateKeyToAccount(loadKey());
  console.log('deployer:', account.address);

  const publicClient = createPublicClient({ chain: ink, transport: http(INK_RPC) });
  const walletClient = createWalletClient({ account, chain: ink, transport: http(INK_RPC) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log('deployer balance (ETH):', Number(balance) / 1e18);

  // 1. Placeholder implementation.
  const phHash = await walletClient.deployContract({
    abi: placeholderArtifact.abi,
    bytecode: placeholderArtifact.bytecode.object as Hex,
    args: [],
  });
  const phReceipt = await publicClient.waitForTransactionReceipt({ hash: phHash });
  const placeholder = phReceipt.contractAddress!;
  console.log('placeholder implementation:', placeholder);

  // 2. Proxy -> placeholder, initialized with (deployer, identity registry).
  const phInit = encodeFunctionData({
    abi: placeholderArtifact.abi,
    functionName: 'initialize',
    args: [account.address, IDENTITY_REGISTRY],
  });
  const proxyHash = await walletClient.deployContract({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode.object as Hex,
    args: [placeholder, phInit],
  });
  const proxyReceipt = await publicClient.waitForTransactionReceipt({ hash: proxyHash });
  const proxy = proxyReceipt.contractAddress!;
  console.log('proxy (validation registry):', proxy);

  // 3. Official ValidationRegistryUpgradeable implementation.
  const implHash = await walletClient.deployContract({
    abi: validationArtifact.abi,
    bytecode: validationArtifact.bytecode.object as Hex,
    args: [],
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash });
  const implementation = implReceipt.contractAddress!;
  console.log('validation implementation:', implementation);

  // 4. Upgrade the proxy to the official implementation + initialize.
  const valInit = encodeFunctionData({
    abi: validationArtifact.abi,
    functionName: 'initialize',
    args: [IDENTITY_REGISTRY],
  });
  const upgradeHash = await walletClient.writeContract({
    address: proxy,
    abi: validationArtifact.abi,
    functionName: 'upgradeToAndCall',
    args: [implementation, valInit],
  });
  await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
  console.log('upgraded to official implementation');

  // 5. Verify wiring through the proxy.
  const registryOnchain = (await publicClient.readContract({
    address: proxy,
    abi: validationArtifact.abi,
    functionName: 'getIdentityRegistry',
  })) as string;
  const ownerOnchain = (await publicClient.readContract({
    address: proxy,
    abi: validationArtifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('identityRegistry:', registryOnchain);
  console.log('owner:', ownerOnchain);
  if (registryOnchain.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase())
    throw new Error('registry mismatch');
  if (ownerOnchain.toLowerCase() !== account.address.toLowerCase())
    throw new Error('owner mismatch');

  // 6. Hand admin to the founder's wallet.
  const transferHash = await walletClient.writeContract({
    address: proxy,
    abi: validationArtifact.abi,
    functionName: 'transferOwnership',
    args: [NEW_ADMIN],
  });
  await publicClient.waitForTransactionReceipt({ hash: transferHash });
  const finalOwner = (await publicClient.readContract({
    address: proxy,
    abi: validationArtifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('new owner:', finalOwner);
  if (finalOwner.toLowerCase() !== NEW_ADMIN.toLowerCase())
    throw new Error('ownership transfer failed');

  console.log('DONE. Validation registry proxy:', proxy);
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
