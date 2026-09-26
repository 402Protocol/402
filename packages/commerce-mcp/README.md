# four02-commerce-mcp

The commerce layer for the Ink agentic economy, as an MCP server.

Any MCP-capable agent (Claude Code, Cursor, Claude Desktop, …) can point at
this server and immediately:

- **invoice** another agent for work, in native USDC on Ink (EIP-712)
- **verify** invoices and check whether they look paid
- **pay** invoices with a dry-run-first payment plan
- **read** onchain commerce reputation for any ERC-8004 agent:
  reliability scores, dispute rates, and raw event history

This is the 402 protocol's agent-commerce toolkit, extracted as a standalone
open-source package. It is **designed to sit alongside
[`inkonchain-mcp`](https://github.com/mavrkofficial/inkonchain-mcp)** (Sergio's
Ink agent stack): every tool is prefixed `four02_`, so there are zero
tool-name collisions. His stack gives agents hands (trade, launch, bridge);
this gives them a business (bill, verify, trust).

Chain: Ink mainnet (chain ID 57073). Settlement asset: native Circle USDC
`0x2D270e6886d130D724215A266106e6832161EAEd`.

## Install

```bash
npm install -g four02-commerce-mcp
# or run directly:
npx four02-commerce-mcp
```

### MCP client config

Claude Code / Cursor / Claude Desktop (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "four02-commerce": {
      "command": "npx",
      "args": ["-y", "four02-commerce-mcp"],
      "env": {
        "FOUR02_COMMERCE_FACILITATOR_URL": "https://402-production.up.railway.app"
      }
    }
  }
}
```

Run it next to `inkonchain-mcp` in the same config — the `four02_` prefix
guarantees no collisions:

```json
{
  "mcpServers": {
    "inkonchain": { "command": "npx", "args": ["inkonchain-mcp"] },
    "four02-commerce": { "command": "npx", "args": ["-y", "four02-commerce-mcp"] }
  }
}
```

### Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `FOUR02_COMMERCE_FACILITATOR_URL` | `https://402-production.up.railway.app` | 402 facilitator base URL |
| `FOUR02_COMMERCE_INK_RPC_URL` | `https://rpc-gel.inkonchain.com` | Ink RPC for reads |
| `FOUR02_COMMERCE_REGISTRY` | `0x33E2c56035C059553a37a3A56199B5b5b3DA3365` | Four02ReputationRegistry on Ink |
| `FOUR02_COMMERCE_INVOICE_KEY` | — | Optional issuer key: `four02_invoice_create` signs server-side when it matches the issuer |
| `FOUR02_COMMERCE_PAYER_KEY` | — | Optional payer key: enables `four02_invoice_pay` broadcast mode |

## Tool catalog

### Invoices (EIP-712, offchain)

| Tool | What it does |
|---|---|
| `four02_invoice_create` | Create a 402 invoice for Ink USDC. Returns the canonical invoice + content-addressed id. Signed automatically if `FOUR02_COMMERCE_INVOICE_KEY` matches the issuer; otherwise returned unsigned with client-side signing instructions (domain `"402 Invoice"`, version `"1"`). |
| `four02_invoice_status` | Verify a signed invoice (pure cryptography) and heuristically scan Ink USDC `Transfer` events for payment. Payment detection is a heuristic — "likely paid", never certain. |
| `four02_invoice_pay` | Verify the invoice and build the exact payment plan. **Dry run by default — broadcasts nothing.** Pass `approveBroadcast: true` only after the human explicitly approved that exact payment in chat, and only with `FOUR02_COMMERCE_PAYER_KEY` configured; then the server submits the USDC transfer. |

### Reputation (onchain reads, Four02ReputationRegistry)

| Tool | What it does |
|---|---|
| `four02_reputation_summary` | One-shot snapshot for an ERC-8004 agentId: reliability (0–100), dispute rate (bps), arbitration wins/losses, total events, last event time. |
| `four02_reputation_reliability` | Reliability score + dispute rate. Value-weighted, 365-day linear decay. |
| `four02_reputation_history` | Raw append-only commerce-event history (newest last): writer contract, event type (`invoice_paid_on_time`, `escrow_completed`, `dispute_opened`, …), USDC value. |

## Typical agent flow

```
1. four02_invoice_create   → issuer bills payer "2.50 USDC for 10k API calls"
2. four02_invoice_status    → payer verifies the signature before paying
3. four02_invoice_pay       → dry-run plan; human approves; broadcast
4. four02_reputation_summary → anyone checks the issuer's track record first
```

## Security

- **Keys are env-only.** The server never accepts a private key as a tool
  argument, never logs one, and never transmits one. Without the `*_KEY`
  vars, signing/payment tools return client-side instructions instead.
- **Pay is dry-run first.** `four02_invoice_pay` returns a plan and
  broadcasts nothing unless the caller passes `approveBroadcast: true`
  **and** the operator configured `FOUR02_COMMERCE_PAYER_KEY`. Agents must
  only pass that flag after the human explicitly approved the exact payment
  in chat — same posture as the 402 `pay --broadcast` CLI.
- **Reputation tools are pure reads.** They cannot write, sign, or spend.
- **Invoice verification is trustless.** `four02_invoice_status` recovers
  the signer with pure ECDSA; no RPC trust required for validity. The
  payment heuristic is explicitly labeled as such.
- This package is experimental software interacting with a live blockchain.
  It has not had a professional audit. Do not wire it to wallets holding
  funds you cannot afford to lose.

## Roadmap

- **Escrow tools** (`four02_escrow_*`) after the 402 `AgentEscrow` contract
  deploys on Ink: fund → deliver → release, dispute → arbitrate.
- **Reputation writes** stay restricted by design: only owner-approved 402
  protocol contracts can record commerce events. This package reads; the
  protocol writes.
- Faucet/testnet support if Ink ships a public testnet.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsx test/commerce-mcp.test.ts (13 checks, no mainnet)
npm run build       # emits dist/
```

`src/invoice.ts` and `src/chain.ts` are vendored from the 402 monorepo
(`~/workspace/402/src/`); keep them in sync when the invoice format or
chain helpers change.

## License

MIT. See [LICENSE](LICENSE).
