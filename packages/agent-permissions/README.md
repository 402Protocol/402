# 402 agent spending permissions

Give an agent a daily USDC budget while keeping funds in your existing wallet on Ink.
The owner uses Rabby or Kraken Wallet to approve a finite token allowance and grant a
permission. The agent can then pay only approved recipients, within the daily budget,
until expiry or revocation. A separate Safe account is **not required**.

**Release status:** SDK, MCP tools and contract implementation. No production deployment
address is bundled, no production configuration is enabled, and this is not an independently
audited release. Integrators must pin a verified deployment before requesting token approvals.

## What is enforced onchain

- Only the owner can create or revoke their permission; only its named agent can spend it.
- Native Ink USDC transfers to 1–32 approved recipient addresses. No arbitrary calls,
  swaps, token approvals, native ETH transfers, custodial balances or protocol fees.
- A cumulative daily limit **per permission**, in six-decimal USDC units. Budgets reset
  at **00:00 UTC**, not 24 hours after the last payment. Unused budget does not roll over.
  A payment just before and another just after midnight can spend two daily budgets.
- An inclusive `validAfter` and exclusive `validUntil`, expressed as Unix seconds.
- Revocation is permanent once confirmed. Pending transactions can execute before a
  revocation is included; a cancelled/rejected wallet prompt changes no onchain state.
- A nonzero payment ID can be used once per owner, across all their permissions and days.
  Use a stable invoice/order digest. Changing IDs to retry an uncertain payment can double-pay.
- Failed/reverted/false-return/no-transfer token calls roll back the budget and payment ID.
  Success requires exact owner and recipient balance changes.

The token approval is a separate, shared ceiling across the owner's permissions. Our
owner helper approves the maximum spend across the UTC days touched by a grant, never
an unlimited allowance. When replacing an existing approval it first sets it to zero.
This can interrupt other active grants; the host UI must show this before approval.
Multiple grants have separate budgets and their limits add together. Revoking USDC's
approval to the manager stops all grants; restoring it can reactivate unexpired,
unrevoked grants. Revoke each grant for permanent cancellation.

## Build and use the package

From this directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The package exports the SDK at `four02-agent-permissions`, browser helpers at
`four02-agent-permissions/wallet`, and tool registration at `four02-agent-permissions/mcp`.
Until an npm release is published, install from the locally built package/tarball.

### Human wallet: Rabby or Kraken Wallet

Rabby supports [EIP-6963 provider discovery](https://rabby.io/docs/integrating-rabby-wallet).
Kraken's [supported-network list includes Ink](https://support.kraken.com/articles/supported-assets-and-networks).
Use a WalletConnect Ethereum provider from your app's connection UI for Kraken Wallet.
The host app supplies its own WalletConnect/Reown project ID, metadata, QR/deep-link UI,
and a session authorizing `eip155:57073`. No project ID or tracking service is embedded here.

```ts
import { createPublicClient, http } from 'viem';
import { ink } from 'four02-agent-permissions';
import { connectOwnerWallet, discoverInjectedWallets } from 'four02-agent-permissions/wallet';

// Show discovered wallets in your picker; connect only the one the human selects.
// Treat wallet names/icons as untrusted display data; do not inject them as HTML.
const stopDiscovery = discoverInjectedWallets(window, addWalletToPicker);
// Rabby announces rdns === 'io.rabby'. For Kraken, pass the connected
// WalletConnect Ethereum provider instead of an injected provider.
const owner = await connectOwnerWallet(selectedProvider,
  createPublicClient({ chain: ink, transport: http() }), verifiedManagerAddress);

// Call from the human's approval button after displaying all recipients, dates,
// the 20-USDC UTC-day budget, and the finite shared token-approval amount.
// Persist a cryptographically random bytes32 salt and reuse it if this flow is retried.
const grant = await owner.grant({
  agent: agentAddress,
  dailyLimitUsdc: '20',
  validAfter: startUnixSeconds,
  validUntil: expiryUnixSeconds,
  recipients: [approvedServiceAddress],
  salt: persistedGrantSalt,
});
await owner.status(grant.permissionId);
// Separate human actions:
await owner.revoke(grant.permissionId);
// Or stop ALL grants by removing the shared USDC approval:
await owner.revokeTokenApproval();
stopDiscovery();
```

The helper checks Ink, detects account/network changes before every transaction, simulates
the call, waits for confirmation, and stops on a rejected or reverted transaction. It does
not import or store wallet secrets. Users need ETH for these standard EOA transactions.
The connection interface is tested with EIP-1193 providers and real local EVM transactions;
manual release acceptance in the actual Rabby and Kraken apps remains required.

If approval succeeds but the grant is rejected, funds have not moved, and the token
approval alone does not authorize an agent. Resume the same grant salt or revoke the
token approval. If submission times out, inspect the transaction hash and grant status
before retrying. Never silently generate a new salt to bypass an existing grant.

### Agent payment

```ts
import { createPermissionsClient } from 'four02-agent-permissions';
const permissions = createPermissionsClient(publicClient, verifiedManagerAddress);
const plan = await permissions.preparePayment({
  permissionId,
  recipient: approvedServiceAddress,
  amountUsdc: '1.25',
  paymentId: stableInvoiceDigest,
});
// agentWallet must belong to the address authorized by the owner grant.
const hash = await agentWallet.sendTransaction(plan.call);
const receipt = await permissions.confirmPayment(hash, plan.expected);
```

`preparePayment` only simulates and builds calldata; it does not sign or pay. The receipt
verifier requires both the exact manager `PaymentExecuted` event and native USDC transfer
for the expected owner, agent, recipient, amount, permission and payment reference. A used
payment ID or lower allowance is not proof of payment. The default two confirmations
are L2 confirmations, not Ethereum finality; services can require a larger confirmation count.

## MCP

```json
{
  "mcpServers": {
    "402-permissions": {
      "command": "node",
      "args": ["/absolute/path/to/agent-permissions/dist/server.js"],
      "env": {
        "FOUR02_SPENDING_MANAGER_ADDRESS": "<verified Ink contract address>",
        "FOUR02_INK_RPC_URL": "https://rpc-gel.inkonchain.com"
      }
    }
  }
}
```

Tools: `permissions_grant`, `permissions_pay`, `permissions_revoke`, `permissions_status`.
The existing root `npm run mcp` exposes the same tools. All write tools return unsigned
plans. They never accept private keys or broadcast. With no configured manager, tools
fail closed. Chain, code presence, version and token checks establish compatibility;
they do **not** prove an arbitrary caller-supplied address contains audited code.

## TAAP and existing payment infrastructure

`src/claim/spending-policies.ts` authors optional Turnkey policies for a **dedicated**
payment-agent key: only `pay(bytes32,address,uint256,bytes32)` on a pinned manager on Ink,
zero native value, and no token approvals, grant/revoke calls, raw payload signing or
policy/identity management. This release does not install those policies or relax existing
swap-only TAAP keys or their approval requirements. Existing agent signers can submit the
prepared manager call after their operator configures an appropriate payment key.

This is a direct-transfer service-payment rail. It is not an EIP-3009 authorization, an
x402 facilitator settlement result, or a BountyEscrow funding transaction. Merchants must
explicitly accept and verify its receipts; do not send plain USDC transfers to escrow
contracts expecting them to create jobs. Existing settlement/recovery behavior is unchanged.

## Why this implementation

We reviewed [Safe allowances](https://github.com/safe-fndn/safe-modules/blob/main/modules/allowances/contracts/AllowanceModule.sol)
and [ZeroDev permissions](https://docs.zerodev.app/smart-accounts/permissions/intro).
Safe allowances require a Safe and allow delegate-selected recipients; ZeroDev's documented
call/timestamp policies cover useful constraints but require a Kernel account and do not
by themselves implement this cumulative USDC budget. The product decision for v1 was to
keep funds in existing Rabby/Kraken addresses. A narrow ERC-20 allowance manager supports
those EOAs, as well as contract accounts capable of approve/grant, without migrating funds.

Ink's stablecoin paymaster is an ERC-4337 integration. These standard EOA transactions do
not automatically qualify. Gas sponsorship/account abstraction is a future account adapter;
this release does not advertise gasless payments or charge USDC gas fees outside the budget.

## Validation and activation

From the repository root:

```sh
forge test --match-contract Four02SpendingPermissionsTest
npm run test:permissions:e2e
npm run typecheck
npm run test:ci
# Optional: public RPC reads; transactions execute only inside a local Ink fork.
forge test --match-contract SpendingPermissionsForkTest
```

The end-to-end test starts a local Anvil, uses generated throwaway keys and mock USDC at
Ink's token address, and runs owner approval/grant, agent payment, exact receipt verification,
duplicate/over-budget rejection, and revocation. It is not a mainnet or mobile-wallet test.

Deployment source: `scripts/DeploySpendingPermissions.s.sol`. Deployment has no admin or
upgrade key. Before enabling a mainnet address, review the contract and compiled artifact,
verify source on the explorer, rehearse native USDC behavior, and complete actual wallet
acceptance with small limits. Record the chain, deployment tx, address, compiler settings,
verified source, runtime code hash and review result. No production address is fabricated
or silently selected by the SDK.
