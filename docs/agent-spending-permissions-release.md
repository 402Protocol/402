# Agent spending permissions — implementation review, 2026-10-07

Scope: owner-granted native-USDC payment budgets for agents on Ink. Owners keep funds in
their existing Rabby/Kraken address. This is a code release, not a mainnet activation or
an independent security audit. No contract was deployed to a public chain and no production
environment settings or existing wallet policies were changed.

## Delivered

- Non-upgradeable `Four02SpendingPermissions` contract, with no admin or custody.
- Per-permission UTC-day USDC limits, recipient allowlist, start/expiry, permanent owner
  revocation and per-owner payment-reference replay protection.
- `four02-agent-permissions` SDK, EIP-6963/EIP-1193 owner-wallet helpers and standalone MCP.
- Four permissions tools in the existing protocol MCP; no address enabled by default.
- Optional Turnkey policy builder for a separately provisioned payment key.
- Ink-only deployment script, package integration guide and CI coverage.

## Review findings addressed

- Payment success requires exact USDC balance changes. False-return, revert, no-transfer
  and reentrant token behavior cannot consume a budget/payment ID or manufacture success.
- Receipt confirmation checks the exact permission, owner, agent, recipient, amount and
  reference, plus an actual native-USDC Transfer event and canonical receipt block.
- A successful cancellation/replacement transaction is not treated as a successful owner
  approval or revocation. Wallet helpers fail closed and ask the application to check state.
- Owner helpers verify the selected account and Ink network before every submission.
- Grants cannot be edited or recreated using the same owner salt. New grants intentionally
  create additional budgets; limits are not advertised as a global wallet-wide cap.
- Finite USDC approvals are shared by the owner's grants. Replacing an approval can affect
  other grants; zeroing approval is a temporary global stop unless grants are also revoked.
- Existing settlement receipt recovery, job escrow funding, and swap-only TAAP policies
  remain separate. This payment rail does not masquerade as x402/EIP-3009 settlement.

## Validation

Performed on the connected iMac with Node 22.22.0 and Foundry/Solc 0.8.28. CI uses Node 24.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run test:ci` | 31/31 protocol test files passed |
| `npm --prefix packages/agent-permissions test` | 18/18 SDK, wallet and MCP tests passed |
| Package `npm run typecheck` and `npm run build` | Passed |
| Package `npm pack --dry-run` | Package contents verified; no keys, node_modules or test fixtures included |
| `forge test --no-match-path 'test/sol/*Fork*.t.sol' --no-match-test test_audit_fork_getJobExistsOnRealEscrow` | 507/507 tests passed, including 16 new contract tests and existing invariants |
| `forge test --match-contract SpendingPermissionsForkTest -vv` | Passed against native USDC on a local Ink fork at block 57,909,469; public RPC reads only |
| `npm run test:permissions:e2e` | Passed: real local bytecode + owner wallet-provider approval/grant + agent payment + exact receipt + duplicate/overspend denial + owner revocation |
| `forge build scripts/DeploySpendingPermissions.s.sol --skip test` | Passed |
| `git diff --check` | Passed |

The first full protocol run found one obsolete 25-tool assertion in `mcp-jobs.test.ts`.
It was updated for the four new permissions tools; the affected suite and final full run
passed. Foundry initially hit a macOS sandbox proxy-configuration crash; the same command
passed outside the sandbox. New package dependencies audited with zero reported npm
vulnerabilities at installation time; the root's pre-existing dependency set was unchanged.

## Remaining activation work

Deploy and verify the reviewed contract through a selected deployment wallet, record the
address/runtime hash, and explicitly configure it for the host application. Complete manual
approval/payment/revocation acceptance using the actual Rabby and Kraken Wallet apps.
The EIP-1193 connection interface is tested; device UI and WalletConnect session creation
are host-application responsibilities and were not exercised against a real user wallet.
Publish the built npm package only through the company's chosen npm account when ready.
This EOA release requires ETH for gas; Ink paymaster sponsorship is not yet integrated.
