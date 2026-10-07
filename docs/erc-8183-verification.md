# ERC-8183 local verification — 2026-10-07

This records local verification of the optional job-escrow prototype before
publication. No contracts or services were deployed to a public network, no public
network transactions were sent, and no production settings changed. Example
deployments and transactions used disposable local Anvil with mock tokens and
ephemeral keys only. This is not an audit.

## Scope

- Base: `c831c9d8f184d16ae12bff9809de69dc97ce4943` (`402Protocol/402`).
- Added `contracts/Four02JobEscrow.sol`, `packages/job-escrow`, a three-role local
  example, unit/fuzz/invariant coverage, ABI synchronization, and compatibility docs.
- Added local test scripts, example typechecking, and CI coverage for the new package.
- `BountyEscrow.sol`, `Four02SpendingPermissions.sol`, the existing packages,
  root dependency lockfile and Foundry configuration/dependency pins are unchanged.

## Compatibility decisions for review

The [full profile](erc-8183.md) pins the official draft to
`a078cab5cc8e9581c15f76c091ed96eed28f02f7`; local profile identifier is
`erc8183-a078cab5-no-hooks-v1`. The document includes a raw-source SHA-256 and a
separate comparison pin for `erc-8183/base-contracts`.

The contract implements the normative six-state lifecycle with explicit
`expectedBudget`, positive funding, client/provider budget negotiation, immutable
evaluator **per job**, provider-only submission, evaluator-only paid settlement,
full refunds and permissionless expiry claims. It has no fees, hooks, registry,
admin, upgrades, marketplace dependency or delegated spending shortcut.

The consequential **additional restriction** is a hard cutoff: funding,
submission and completion stop at expiry. The draft prose does not prescribe that
cutoff; its embedded implementation permits completion until refund wins. The
guide marks this difference explicitly rather than asserting universal compliance.
The escrow/token cannot be participants, and only exact-transfer non-rebasing
tokens are supported. Broader compatibility or removal of these restrictions is
a design review decision before any release. No automatic external-platform
integration is claimed.

Evaluators are trusted decision makers; they can approve poor work, reject good
work or fail to respond. A buyer acting as evaluator retains that power. No
on-chain quality verification or appeal is provided. A direct token transfer,
including an existing spending-permission payment, neither funds a job nor makes
the transferred surplus recoverable. Only the client's explicit `fund` pulls and
accounts for the budget.

## Exact verification results

Environment: connected macOS host, Node `v22.22.0`, npm `10.9.4`, Forge/Anvil
`1.1.0-stable`, solc `0.8.28`, via-IR from the existing configuration. The CI file
targets Node 24 / Foundry 1.8.5. These are local results; check GitHub Actions
for the status of each published commit.

| Command | Result |
| --- | --- |
| `forge build --offline` | Pass |
| `forge test --offline --no-match-path 'test/sol/*Fork*.t.sol' --no-match-test test_audit_fork_getJobExistsOnRealEscrow` | **525 passed, 0 failed, 0 skipped**, 24 suites |
| `forge test --offline --match-path 'test/sol/Four02JobEscrow*.t.sol'` | **18 passed**: 16 unit/fuzz tests + 2 stateful invariants |
| New fuzz test | 256 runs across independent budgets/outcomes and unsolicited surplus |
| Each new stateful invariant | 256 runs, **128,000 calls**, 0 reverts |
| Role/state/action matrix | 6 states × 4 callers × 7 actions = **168 cases** |
| `npm run typecheck` (root, including the new example) | Pass |
| `npm run test:ci` | **31/31 test files passed** |
| `npm run typecheck`, `npm run build`, `npm test` in `packages/job-escrow` | Pass; **7 SDK tests** |
| Same three commands in `packages/agent-permissions` | Pass; **18 tests** |
| Same three commands in `packages/commerce-mcp` | Pass; **13 checks** |
| Same three commands in `packages/gm-regiment-mcp` | Pass; **24 checks** |
| `npm run test:permissions:e2e` | Pass; existing local wallet/permissions/payment/revocation flow |
| `npm run test:erc8183:e2e` | Pass; local three-role completion, both rejection paths, both expiry paths, negative authorization and exact final balances |
| `node scripts/sync-job-escrow-abi.mjs --check` | Pass; SDK ABI matches compiled Solidity |
| `forge fmt --check contracts/Four02JobEscrow.sol test/sol/Four02JobEscrow.t.sol test/sol/Four02JobEscrowInvariant.t.sol` | Pass |
| `git diff --check` | Pass |

The 507 existing non-fork contract tests passed before adding the new test suites,
then passed again in the combined 525-test run. Live fork rehearsals were excluded
using the repository's CI exclusion list; they are not evidence for this prototype.
The root regression suite includes read-only public RPC checks, not broadcasts.

## Remaining limitations and observed baseline issue

The local checks above passed. The SDK shares viem as a peer dependency, with
local development pinned to the root's version `2.56.8`.

The locked root/commerce/GM dependencies report a pre-existing high-severity
`@modelcontextprotocol/sdk` advisory
([GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h), OAuth client
credential forwarding). Those dependencies were not changed in this task. The
new job SDK has no MCP dependency and its install reported zero vulnerabilities.
This baseline finding merits a separate dependency review before a broader release.

Public deployment, token/source verification on Ink, economic/security review,
standards compatibility review and deployment authorization remain future work. Local passing tests do not establish those outcomes.
