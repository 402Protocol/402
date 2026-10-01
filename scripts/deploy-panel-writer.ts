#!/usr/bin/env npx tsx
/**
 * Deploy PanelBatchWriter to Ink mainnet.
 *
 *   DEPLOYER_KEY=<treasury key> npx tsx scripts/deploy-panel-writer.ts <keeperAddress>
 *
 * The deployer key is read from the environment only — never paste it anywhere.
 * Deploy tx is sent FROM the treasury wallet per standing rule; the contract's
 * owner is set to the fresh wallet (0xE15B...) via constructor arg.
 *
 * Optional second step (registry owner allowlists the writer):
 *   OWNER_KEY=<registry-owner key> npx tsx scripts/deploy-panel-writer.ts --add-writer <writerAddress>
 */
import { createWalletClient, createPublicClient, http, getAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INK_CHAIN_ID = 57073;
const REGISTRY = '0x4fa146388ce351b2af71aa6841146c91a2f27494';
const DEFAULT_OWNER = '0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf';
const RPC = process.env.INK_RPC_URL ?? 'https://rpc-gel.inkonchain.com';

const ink = {
  id: INK_CHAIN_ID,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

function usage(): never {
  console.error('usage:');
  console.error('  DEPLOYER_KEY=<key> npx tsx scripts/deploy-panel-writer.ts <keeperAddress> [ownerAddress]');
  console.error('  OWNER_KEY=<key>   npx tsx scripts/deploy-panel-writer.ts --add-writer <writerAddress>');
  process.exit(2);
}

const args = process.argv.slice(2);

async function main() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const artifact = JSON.parse(
    readFileSync(join(dir, '..', 'out', 'PanelBatchWriter.sol', 'PanelBatchWriter.json'), 'utf8'),
  );
  const publicClient = createPublicClient({ chain: ink, transport: http(RPC) });

  if (args[0] === '--add-writer') {
    const writer = args[1] as Address | undefined;
    const ownerKey = process.env.OWNER_KEY;
    if (!writer || !ownerKey) usage();
    const account = privateKeyToAccount(ownerKey as `0x${string}`);
    const wallet = createWalletClient({ account, chain: ink, transport: http(RPC) });
    console.error(`owner: ${account.address}`);
    console.error(`calling addWriter(${writer}) on registry ${REGISTRY} ...`);
    const hash = await wallet.writeContract({
      address: getAddress(REGISTRY),
      abi: [
        {
          name: 'addWriter',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [{ name: 'writer', type: 'address' }],
          outputs: [],
        },
      ],
      functionName: 'addWriter',
      args: [getAddress(writer)],
    });
    console.error(`tx: ${hash} — waiting for receipt...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      console.error('FAILED onchain. Writer NOT allowlisted.');
      process.exit(1);
    }
    console.log(`ALLOWLISTED in block ${receipt.blockNumber}. Writer: ${getAddress(writer)}`);
    return;
  }

  const keeper = args[0] as Address | undefined;
  const owner = (args[1] as Address | undefined) ?? DEFAULT_OWNER;
  const deployerKey = process.env.DEPLOYER_KEY;
  if (!keeper || !deployerKey) usage();
  if (keeper === '0x0000000000000000000000000000000000000000') {
    console.error('keeper cannot be the zero address');
    process.exit(1);
  }

  const account = privateKeyToAccount(deployerKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: ink, transport: http(RPC) });
  console.error(`deployer: ${account.address}`);
  console.error(`registry:  ${REGISTRY}`);
  console.error(`keeper:    ${getAddress(keeper)}`);
  console.error(`owner:     ${getAddress(owner)}`);

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
    args: [getAddress(REGISTRY), getAddress(keeper), getAddress(owner)],
  });
  console.error(`deploy tx: ${hash} — waiting for receipt...`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    console.error('DEPLOY FAILED onchain.');
    process.exit(1);
  }
  const writer = getAddress(receipt.contractAddress);
  console.log(`\nPanelBatchWriter deployed: ${writer}`);
  console.log(`block: ${receipt.blockNumber}`);
  console.log('\nNext steps:');
  console.log(`  1. Verify source on the Ink explorer for ${writer}`);
  console.log(`  2. OWNER_KEY=<registry-owner key> npx tsx scripts/deploy-panel-writer.ts --add-writer ${writer}`);
  console.log('  3. Fund the keeper with dust ETH for gas');
  console.log(`  4. Set FOUR02_PANEL_WRITER=${writer} in Railway, then redeploy the backend`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
