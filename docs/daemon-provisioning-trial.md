# TaaP wallet-provisioning trial with Daemon (demo mode)

Goal: prove the whole loop — Daemon connects the TaaP MCP, provisions a
wallet ON ITS OWN, hands Father a claim link, Father does the 2-minute
ceremony in his browser, Daemon sees the backup land.

Nothing here touches real money or real Turnkey. Demo wallets, demo words.

## 1. Father: start the claim server (demo mode)

```bash
cd ~/workspace/402
CLAIM_HMAC_SECRET=<any-16+-char-secret> CLAIM_MODE=demo npm run claim
# -> listening on http://localhost:4023 [demo]
```

Leave it running.

## 2. Father: connect Daemon to the TaaP MCP (stdio)

In Daemon's Muse MCP config:

```json
{
  "mcpServers": {
    "taap": {
      "command": "npx",
      "args": ["tsx", "/Users/<you>/workspace/402/src/taap/server.ts"],
      "env": {
        "TAAP_CLAIM_SERVER_URL": "http://localhost:4023"
      }
    }
  }
}
```

(Adjust the repo path to where Daemon can see it. No Turnkey env needed —
paper mode + demo claim server. No admin key needed in demo mode.)

## 3. Daemon: just say hi

The MCP's server instructions tell Daemon to provision the wallet on its
own, no prompt needed. Expected:

1. Daemon calls `provision_wallet` itself.
2. Daemon presents the claim link in chat: "your wallet's ready — 2-minute
   ceremony here: <link>".
3. Daemon polls `claim_status` until `backed_up` is true.

If Daemon doesn't do it unprompted, tell it: "check your taap MCP".

## 4. Father: do the ceremony

Open the claim link in your browser (localhost — passkey works on
localhost):

1. Fingerprint / Face ID when asked (registers your passkey).
2. Write down the 12 demo words (they're fake — this is the rehearsal).
3. Confirm backup -> deposit address appears.

## 5. Daemon: confirm

`claim_status` should now show `backed_up: true` plus the deposit address.
Daemon can read the address out — it never sees the 12 words.

## What success looks like

- One wallet provisioned, one claim link, no magic words typed.
- Daemon never lost track of the wallet (it polls by trader_id).
- Deposit address revealed ONLY after backup — Daemon couldn't see it before.
- The wallet is empty (demo) — fund nothing.

## After the trial

Next step is the same loop in live mode: real Turnkey sub-org + wallet,
`TAAP_CLAIM_ADMIN_KEY` set, claim server in live mode. That needs Father's
Turnkey call — demo first, live when he says go.
