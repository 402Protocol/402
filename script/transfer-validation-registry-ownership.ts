/**
 * Transfers the ValidationRegistry proxy admin to the founder's wallet.
 * (Split from the deploy script after its verify step hit a stale RPC node;
 *  onchain state was confirmed correct before running this.)
 *
 * Usage: npx tsx script/transfer-validation-registry-ownership.ts
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const INK_RPC = 'https://rpc-gel.inkonchain.com';
const ink = {
  id: 57073,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [INK_RPC] } },
} as const;

const PROXY = '0x891c2a0039f3d24ae273d5b4b3179a34108a6f4c';
const NEW_ADMIN = '0x31ec2ade8eb97a89e9a1e76195da6665c3a14f5b';

function loadKey(): `0x${string}` {
  const fromEnv = (process.env.FOUR02_MANAGER_KEY || '').trim();
  if (fromEnv) return fromEnv as `0x${string}`;
  const text = readFileSync('/home/hatch/workspace/402/.manager.env', 'utf8');
  const m = text.match(/^\s*FOUR02_MANAGER_KEY\s*=\s*(\S+)\s*$/m);
  if (!m) throw new Error('FOUR02_MANAGER_KEY not found');
  return m[1] as `0x${string}`;
}

async function main() {
  const validationArtifact = JSON.parse(
    readFileSync('/tmp/valdeploy/out/ValidationRegistryUpgradeable.sol/ValidationRegistryUpgradeable.json', 'utf8'),
  );
  const account = privateKeyToAccount(loadKey());
  const publicClient = createPublicClient({ chain: ink, transport: http(INK_RPC) });
  const walletClient = createWalletClient({ account, chain: ink, transport: http(INK_RPC) });

  const ownerBefore = (await publicClient.readContract({
    address: PROXY as Hex,
    abi: validationArtifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('owner before:', ownerBefore);
  if (ownerBefore.toLowerCase() !== account.address.toLowerCase())
    throw new Error('deployer is not the current owner — refusing');

  const hash = await walletClient.writeContract({
    address: PROXY as Hex,
    abi: validationArtifact.abi,
    functionName: 'transferOwnership',
    args: [NEW_ADMIN],
  });
  console.log('transfer tx:', hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('transfer tx reverted');

  const ownerAfter = (await publicClient.readContract({
    address: PROXY as Hex,
    abi: validationArtifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('owner after:', ownerAfter);
  if (ownerAfter.toLowerCase() !== NEW_ADMIN.toLowerCase())
    throw new Error('ownership transfer failed');
  console.log('DONE. Registry admin:', ownerAfter);
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
