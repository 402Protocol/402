# Turnkey × Ink proof

Proves, with live Turnkey API calls, that Turnkey will:

1. provision a fresh EVM wallet,
2. let a scoped, non-root "agent" API key **sign** an Ink-mainnet transaction
   (chain ID 57073) via `SIGN_TRANSACTION_V2` when policy allows it,
3. **deny** the same agent key on `SIGN_RAW_PAYLOAD_V2` (the policy bypass).

Nothing is broadcast. No funds move. The script runs on **your** machine and
your API private key never leaves the process (the agent keypair it creates is
ephemeral — generated in memory, never saved).

## Run

```bash
cd ~/workspace/402/scripts/turnkey-ink-proof

export TURNKEY_ORG_ID="4ccacf1d-849a-4a8c-b251-159d4cb01783"
export TURNKEY_API_PUBLIC_KEY="<root API key public key, from the dashboard>"
export TURNKEY_API_PRIVATE_KEY="<root API key private key, shown ONCE at creation>"

npx tsx proof.ts
```

Sanity-check the crypto plumbing first (no network, no credentials needed):

```bash
npx tsx proof.ts --self-test
```

Requires Node 20+. No `npm install` — zero dependencies (only `node:crypto`).

## What it does

| Step | Activity (as root, except where noted) |
|------|----------------------------------------|
| 1 | `create_wallet` — fresh secp256k1 EVM wallet |
| 2 | `create_users` — scoped non-root "agent" user + ephemeral P-256 API key |
| 3 | `create_policy` ×2 — ALLOW `SIGN_TRANSACTION_V2` with `eth.tx.chain_id == 57073`, DENY `SIGN_RAW_PAYLOAD_V2` |
| 4 | **as agent:** `sign_transaction` for an unsigned EIP-1559 tx with chain ID 57073 → must return a valid signature |
| 5 | **as agent:** `sign_raw_payload` → must be **denied by policy** |
| 6 | best-effort cleanup: deletes the test policies, user, and wallet |

## Reading the output

- `ALL GREEN` → the signer-enforcement model works on Ink. Paste the output back.
- Any `FAIL` line → paste the **whole** output back, exactly as-is.

The script never prints secrets — only truncated IDs and pass/fail lines.
