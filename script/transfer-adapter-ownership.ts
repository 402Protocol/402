/**
 * Finish the adapter deploy: transfer proxy admin to the founder's wallet.
 * (Deploy script verified wiring; this completes the handoff.)
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const INK_RPC = 'https://rpc-gel.inkonchain.com';
const ink = {
  id: 57073,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [INK_RPC] } },
} as const;

const PROXY = '0xa727f0d35bcb3fee53ddd52b8834b7219c901c0e';
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
  const artifact = JSON.parse(
    readFileSync('/tmp/adapter/out/Adapter8004.sol/Adapter8004.json', 'utf8'),
  );
  const account = privateKeyToAccount(loadKey());
  const publicClient = createPublicClient({ chain: ink, transport: http(INK_RPC) });
  const walletClient = createWalletClient({ account, chain: ink, transport: http(INK_RPC) });

  const hash = await walletClient.writeContract({
    address: PROXY,
    abi: artifact.abi,
    functionName: 'transferOwnership',
    args: [NEW_ADMIN],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('transfer tx:', receipt.transactionHash);

  const owner = (await publicClient.readContract({
    address: PROXY,
    abi: artifact.abi,
    functionName: 'owner',
  })) as string;
  console.log('owner now:', owner);
  if (owner.toLowerCase() !== NEW_ADMIN.toLowerCase()) throw new Error('transfer failed');
  console.log('DONE');
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
