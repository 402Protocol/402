/**
 * Deploys BountyEscrow (v2, new treasury as feeRecipient) to Ink mainnet.
 *
 * Deployer: 402 Manager wallet (founder-authorized; key from
 * FOUR02_MANAGER_KEY env or ~/workspace/402/.manager.env — never logged).
 * Constructor args mirror the 2026-09-27 production deploy exactly, except
 * feeRecipient_ which is the NEW treasury.
 *
 * Usage: npx tsx script/deploy-escrow-v2.ts
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, getAddress, encodeDeployData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const INK_RPC = 'https://rpc-gel.inkonchain.com';
const ink = {
  id: 57073,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [INK_RPC] } },
} as const;

// --- constructor args (from broadcast/DeployBountyEscrow.s.sol/57073/run-latest.json) ---
const ARGS = {
  token_: '0x2D270e6886d130D724215A266106e6832161EAEd', // Ink USDC
  arbiter_: '0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf',
  feeRecipient_: '0xaA4E163dA1545F6967d284C0C5CFA469C644eD23', // NEW treasury
  feeBps_: 100n,
  refundDelay_: 259200n, // 72h
  guardian_: '0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf',
  identityRegistry_: '0x7274e874CA62410a93Bd8bf61c69d8045E399c02',
  reputationRegistry_: '0x4Fa146388Ce351b2Af71AA6841146c91A2f27494',
  claimStake_: 1_000_000n, // $1
  disputeBond_: 1_000_000n, // $1
  disputeTimeout_: 2_592_000n, // 30d
} as const;

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
    readFileSync('/home/hatch/workspace/402/out/BountyEscrow.sol/BountyEscrow.json', 'utf8'),
  );
  const account = privateKeyToAccount(loadKey());
  console.log('deployer:', account.address);

  const publicClient = createPublicClient({ chain: ink, transport: http(INK_RPC) });
  const walletClient = createWalletClient({ account, chain: ink, transport: http(INK_RPC) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log('deployer balance (ETH):', Number(balance) / 1e18);

  const args = [
    getAddress(ARGS.token_),
    getAddress(ARGS.arbiter_),
    getAddress(ARGS.feeRecipient_),
    ARGS.feeBps_,
    ARGS.refundDelay_,
    getAddress(ARGS.guardian_),
    getAddress(ARGS.identityRegistry_),
    getAddress(ARGS.reputationRegistry_),
    ARGS.claimStake_,
    ARGS.disputeBond_,
    ARGS.disputeTimeout_,
  ] as const;

  // Estimate first so we fail before broadcasting if anything is off.
  const deployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
    args,
  });
  const gas = await publicClient.estimateGas({ account, data: deployData });
  console.log('estimated gas:', gas.toString());

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
    args,
    account,
  });
  console.log('deploy tx:', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('status:', receipt.status, 'contract:', receipt.contractAddress);

  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error('deploy failed');
  }

  // Verify onchain state matches intent.
  const addr = receipt.contractAddress;
  const read = (fn: string) =>
    publicClient.readContract({ address: addr, abi: artifact.abi, functionName: fn });
  const [feeRecipient, feeBps, arbiter, guardian, claimStake] = await Promise.all([
    read('feeRecipient'),
    read('feeBps'),
    read('arbiter'),
    read('guardian'),
    read('claimStake'),
  ]);
  console.log(JSON.stringify({
    address: addr,
    feeRecipient, feeBps: feeBps.toString(), arbiter, guardian, claimStake: claimStake.toString(),
  }, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
