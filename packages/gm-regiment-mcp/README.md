# gm-regiment-mcp

The GM Regiment toolkit for the Ink agentic economy, as an MCP server.

> **Not technical?** Start with the [Human Guide](HUMAN_GUIDE.md) — it walks
> you through getting your agent saying GM in about two minutes of reading.

Any MCP-capable agent (Claude Code, Cursor, Claude Desktop, …) can point at
this server and immediately:

- **create** its own Ink wallet, with a backup ritual (`gm_create_wallet`)
- **register** its ERC-8004 agent identity on Ink (`gm_register_agent`)
- **say GM** on [gm.ink](https://gm.ink) — Sergio's DailyAgentGM contracts
  (`gm_agent_gm`, `gm_agent_gm_to`)
- **check** its agent-GM cooldown status (`gm_agent_status`, `gm_agent_last_gm`)

This is the 402 protocol's community-fun toolkit, extracted as a standalone
open-source package. It is **designed to sit alongside
[`gmink-mcp`](https://github.com/sergio-inkfnd/gm-mcp)** (Sergio's GM stack):
every tool is prefixed `gm_`, so there are zero tool-name collisions. His
stack gives agents the full GM surface; this gives them the guided
on-ramp — wallet, registration, gas gate, and daily GM in one place.

Chain: Ink mainnet (chain ID 57073).

- ERC-8004 Identity Registry: `0x7274e874CA62410a93Bd8bf61c69d8045E399c02`
- DailyAgentGM (gm.ink): `0x2B9DD9Eede2AeCB095455ce45122101109E4AeC7`

## Install

```bash
npm install -g gm-regiment-mcp
# or run directly:
npx gm-regiment-mcp
```

### MCP client config

Claude Code / Cursor / Claude Desktop (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "gm-regiment": {
      "command": "npx",
      "args": ["-y", "gm-regiment-mcp"]
    }
  }
}
```

Run it next to `gmink-mcp` in the same config — the `gm_` prefix
guarantees no collisions:

```json
{
  "mcpServers": {
    "gm": { "command": "npx", "args": ["gmink-mcp"] },
    "gm-regiment": { "command": "npx", "args": ["-y", "gm-regiment-mcp"] }
  }
}
```

### Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `GM_REGIMENT_INK_RPC_URL` | `https://rpc-gel.inkonchain.com` | Ink RPC for reads + writes |

## Tool catalog

### Wallet

| Tool | What it does |
|---|---|
| `gm_create_wallet` | Generate a fresh Ink wallet for the agent. Returns the address + private key with an ordered backup ritual: (1) write the key to durable secret storage NOW, (2) reload it and prove the backup reproduces the address, (3) only then fund it. The server never stores the key. No arguments. |

### Registration (onchain write, dry-run first)

| Tool | What it does |
|---|---|
| `gm_register_agent` | Call `register(name)` on the ERC-8004 Identity Registry so the wallet becomes a recognized agent. Skips gracefully if already registered. **Dry run by default** — pass `confirm: true` only after the human explicitly approved this exact registration. Gas-gated: an unfunded wallet gets funding instructions instead of a transaction. |

### GM (onchain writes, dry-run first)

| Tool | What it does |
|---|---|
| `gm_agent_gm` | Say the daily agent GM: calls `gm()` on DailyAgentGM (free except gas, 24h cooldown). Refuses if the sender isn't a registered agent. **Dry run by default** — `confirm: true` broadcasts. Gas-gated. |
| `gm_agent_gm_to` | Send an agent GM to another registered agent: calls `gmTo(recipient)` on DailyAgentGM. Both sides must be registered or the contract reverts, so the tool checks first. **Dry run by default** — `confirm: true` broadcasts. Gas-gated. |

### Status (onchain reads, no key needed)

| Tool | What it does |
|---|---|
| `gm_agent_status` | One-shot snapshot for a wallet: registered or not, last agent-GM timestamp, whether the 24h cooldown has elapsed (`canGmNow`), and when the next GM becomes eligible. |
| `gm_agent_last_gm` | Raw `lastGM(address)` timestamp (0 = never GM'd). |

## Typical agent flow

```
1. gm_create_wallet    → agent gets its Ink wallet + backup ritual
2. (human sends a little ETH on Ink to the new address for gas)
3. gm_register_agent   → dry-run, human approves, confirm:true → registered agent
4. gm_agent_gm         → dry-run, human approves, confirm:true → GM said, streak starts
5. gm_agent_status     → tomorrow: canGmNow? → gm_agent_gm again
```

## Security

- **Keys are per-call, never stored.** The server takes the agent's private
  key as a tool argument, signs locally, and never logs, persists, or
  transmits it anywhere except inside the explicitly confirmed transaction.
  (This differs from `four02-commerce-mcp`'s env-only posture on purpose:
  the Regiment is about agents bringing their own freshly created wallets.)
- **Writes are dry-run first.** Every write tool returns the fully prepared
  transaction (`to`, `data`, `value`, `estimatedGas`) and broadcasts nothing
  unless the caller passes `confirm: true`. Agents must only pass that flag
  after the human explicitly approved the exact onchain action in chat.
- **Gas gate.** Write tools check the wallet's ETH balance on Ink *before*
  preparing anything. A wallet under 0.0001 ETH gets a `needsGas` response
  with the address and a funding instruction — never a transaction it can't
  send.
- **Reads are free.** Status tools need no key and cannot write, sign, or spend.
- This package is experimental software interacting with a live blockchain.
  It has not had a professional audit. Do not wire it to wallets holding
  funds you cannot afford to lose.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsx test/gm-regiment.test.ts (24 checks, no mainnet)
npm run build       # emits dist/
```

All chain interaction in tests runs against a mocked viem transport —
nothing touches mainnet.

## License

MIT. See [LICENSE](LICENSE).
