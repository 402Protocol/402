# Four02 job escrow SDK

Optional TypeScript helpers for `Four02JobEscrow`: an implementation targeting the
normative ERC-8183 draft at `a078cab5cc8e9581c15f76c091ed96eed28f02f7`, with the
explicit `erc8183-a078cab5-no-hooks-v1` restrictions. Local prototype; no deployed
escrow address is supplied. The package is private pending review, with MIT source
available to developers. It neither signs nor broadcasts transactions.

`viem` is a peer dependency so the application and SDK share client types. Local
development is pinned to viem 2.56.8, matching the repository's lockfile.

See [the compatibility and trust profile](../../docs/erc-8183.md) before use.
The contract uses one fixed exact-transfer token, a fixed evaluator **per job**,
full-budget settlement, and a hard expiry cutoff. Fees, hooks, reputation,
upgrades, dispute resolution and delegated funding are absent. It is separate
from the existing marketplace and spending-permissions contracts.

```ts
import { createJobClient, createdJobId, receiptMatchesFunding } from 'four02-job-escrow';

// Supply your verified deployment and read client; there is no default escrow.
const sdk = createJobClient(publicClient, { chainId: 57073, escrow, paymentToken });
await sdk.checkDeployment(); // chain, code presence, profile and token; NOT source verification
const input = { provider, evaluator, expiredAt, description: 'Agreed scope' };
const creation = sdk.plan(buyer, { kind: 'createJob', ...input });
// Your wallet enforces plan.chainId and plan.account, simulates, signs, and checks the receipt.
const receipt = await executeWithYourWallet(creation);
const jobId = createdJobId(escrow, receipt, { ...input, client: buyer });
await executeWithYourWallet(sdk.plan(provider, { kind: 'setBudget', jobId, amount: 10_000_000n }));
const funded = await executeWithYourWallet(await sdk.prepareFunding(jobId, buyer, 10_000_000n));
if (!receiptMatchesFunding(sdk.deployment, funded, { jobId, client: buyer, amount: 10_000_000n })) {
  throw new Error('Funding evidence does not match');
}
await executeWithYourWallet(sdk.plan(provider, { kind: 'submit', jobId, deliverable }));
// Evaluator must actually review the agreed evidence before choosing an outcome.
await executeWithYourWallet(sdk.plan(evaluator, { kind: 'complete', jobId, reason }));
```

`executeWithYourWallet` above is an integrator-supplied function. A complete,
executable three-wallet example is [erc8183-local.ts](../../examples/erc8183-local.ts).
All amounts use bigint token base units; native Ink USDC has six decimals.
Commitments are exactly 32 bytes, with zero permitted. Pure `plan`/`buildJobCall`
validate encoding only; on-chain authorization and state must be simulated before
each transaction. Never reuse the example's decision to approve as an automated
evaluation policy.

`prepareFunding` checks the agreed budget, client, state, provider, deadline and
balance at one block. It returns only exact approval calls (resetting a differing
nonzero allowance first) followed by `fund(jobId, expectedBudget)`. Execute them
sequentially with receipt checks. A race can invalidate the plan; do not silently
change the agreed quote or assume an approval funded anything. Approval is shared
across a client's jobs on the escrow. Revoke unused allowance when abandoning a
plan. **A direct transfer, including a spending-permission payment, is not job
funding and leaves the tokens stranded.**

For rejection use `sdk.plan(evaluator, { kind: 'reject', jobId, reason })` on a
Funded/Submitted job, or the client on an Open job. At/after expiry anyone may
prepare `claimRefund` for a Funded/Submitted job. Expiry is not an automatic
transaction. `readJob` returns state, block number and timestamp. Receipt helpers
filter by contract address and successful receipt; confirmation depth and reorg
handling remain the runtime's responsibility. `JobCreated` omits description;
read `getJob` at the receipt block to independently verify it.

From this directory: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`.
From the repository root: `forge build`, `node scripts/sync-job-escrow-abi.mjs --check`,
`npm run example:erc8183`. ABI generation uses the compiled Solidity artifact.
