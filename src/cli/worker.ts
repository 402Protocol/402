/**
 * worker — one-shot onboarding for a 402 job marketplace worker.
 *
 * Takes a FUNDED worker wallet key (from FOUR02_WORKER_KEY in env — never
 * argv, never chat), registers its ERC-8004 agent identity onchain, then
 * enrolls it with the job API. After this, the agent is in: it can run the
 * autonomous loop (poll -> claim -> work -> submit -> withdraw) with the
 * jobs_* MCP tools or src/jobs/worker-loop.ts.
 *
 * Funding guidance: ~0.001 ETH (gas) + $5-10 USDC (claim stakes) on Ink.
 * The CLI checks both balances and warns when they look too low.
 *
 * Default is a dry run that prints the full plan and broadcasts nothing.
 * Add --broadcast to actually register onchain and POST the enrollment —
 * only after the human confirms the wallet is funded.
 *
 *   FOUR02_WORKER_KEY=0x... npx tsx src/cli/worker.ts \
 *     --agent-uri "https://myagent.example.com/card.json" [--broadcast] \
 *     [--agent-id 7] [--api URL] [--rpc URL]
 *
 * --agent-id skips the onchain register (the agent already has an identity).
 */
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { INK_RPC_URL, USDC_ADDRESS, USDC_DECIMALS, ink } from '../constants.js';
import {
  IDENTITY_REGISTRY_ADDRESS,
  identityRegistryAbi,
  parseMintedTokenId,
  signJobEnroll,
} from '../jobs/worker.js';
import { flag, keyFromEnv, optional, parseArgs, required } from './args.js';

const args = parseArgs();
const agentUri = required(args, 'agent-uri');
const agentIdArg = optional(args, 'agent-id', '');
const broadcast = flag(args, 'broadcast');
const apiBase = optional(args, 'api', 'https://402-production.up.railway.app').replace(/\/+$/, '');
const rpcUrl = optional(args, 'rpc', INK_RPC_URL);

const workerKey = keyFromEnv('FOUR02_WORKER_KEY');
const account = privateKeyToAccount(workerKey);
const worker = account.address;

const usdcBalanceAbi = parseAbi(['function balanceOf(address) external view returns (uint256)']);

console.error(`worker wallet: ${worker}`);
console.error(`api:          ${apiBase}/jobs`);
console.error(`chain:        Ink (57073)`);

// ---- funding check (read-only, always safe) ----
const publicClient = createPublicClient({ chain: ink, transport: http(rpcUrl) });
let funded = true;
try {
  const [eth, usdc] = await Promise.all([
    publicClient.getBalance({ address: worker }),
    publicClient.readContract({
      address: getAddress(USDC_ADDRESS),
      abi: usdcBalanceAbi,
      functionName: 'balanceOf',
      args: [worker],
    }),
  ]);
  console.error(`balance:      ${formatUnits(eth, 18)} ETH / ${formatUnits(usdc, USDC_DECIMALS)} USDC`);
  if (eth < 500_000_000_000_000n) {
    console.error('WARN: ETH looks low for gas — send ~0.001 ETH to the worker wallet.');
    funded = false;
  }
  if (usdc < 1_000_000n) {
    console.error('WARN: less than $1 USDC — the claim stake cannot be paid. Send $5-10 USDC.');
    funded = false;
  }
} catch (e) {
  console.error(`WARN: could not read balances (${(e as Error).message}) — continuing blind.`);
}

// ---- agent id: given, or register onchain ----
let agentId: bigint;
if (agentIdArg) {
  agentId = BigInt(agentIdArg);
  if (agentId === 0n) {
    console.error('REFUSING: agent id 0 can never claim on BountyEscrow (ZeroAgentId) — register again for a nonzero id.');
    process.exit(1);
  }
  console.error(`agent id:     ${agentId} (provided, skipping onchain register)`);
} else {
  console.error('--- register plan ---');
  console.error(`  call:       IdentityRegistry.register("${agentUri}")`);
  console.error(`  to:         ${IDENTITY_REGISTRY_ADDRESS}`);
  console.error(`  from:       ${worker}`);
  if (!broadcast) {
    console.error('---');
    console.error('DRY RUN — nothing broadcast, nothing posted.');
    console.error('Re-run with --broadcast after the human confirms the wallet is funded.');
    process.exit(funded ? 0 : 1);
  }
  const { result, request } = await publicClient.simulateContract({
    account,
    address: getAddress(IDENTITY_REGISTRY_ADDRESS),
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [agentUri],
  });
  agentId = result;
  if (agentId === 0n) {
    console.error('REFUSING: registry returned agent id 0, which can never claim on BountyEscrow — register again for a nonzero id.');
    process.exit(1);
  }
  console.error(`  agent id:   ${agentId} (from simulation)`);
  const wallet = createWalletClient({ account, chain: ink, transport: http(rpcUrl) });
  const hash = await wallet.writeContract(request);
  console.error(`  broadcast:  ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const minted = parseMintedTokenId(receipt.logs);
  if (minted !== null && minted !== agentId) {
    console.error(`  NOTE: receipt minted token ${minted}, simulation said ${agentId} — using the receipt value.`);
    agentId = minted;
  }
  console.error(`  confirmed in block ${receipt.blockNumber}`);
}

// ---- enroll ----
const signed = await signJobEnroll(account, agentId);
const enrollBody = {
  wallet: signed.author,
  agentId: agentId.toString(),
  timestamp: signed.timestamp,
  signature: signed.signature,
};
console.error('--- enroll plan ---');
console.error(`  POST ${apiBase}/jobs/enroll`);
console.error(`  wallet:     ${enrollBody.wallet}`);
console.error(`  agentId:    ${enrollBody.agentId}`);

if (!broadcast) {
  console.error('---');
  console.error('DRY RUN — enrollment NOT posted.');
  console.error('Re-run with --broadcast to register onchain and post the enrollment.');
  process.exit(funded ? 0 : 1);
}

const res = await fetch(`${apiBase}/jobs/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(enrollBody),
});
const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
if (res.status !== 200 && res.status !== 201) {
  console.error(`ENROLL FAILED: HTTP ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
  process.exit(1);
}
console.error('---');
console.error(`enrolled: worker ${worker} / agent ${agentId}`);
console.log(JSON.stringify({ ok: true, worker, agentId: agentId.toString(), enrolled: json.enrolled ?? true }));
