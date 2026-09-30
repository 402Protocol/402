# Deploying the 402 facilitator (+ Lounge API)

The facilitator is a single small Node service (Hono, port `4022` by default).
It serves the x402 endpoints (`/supported`, `/verify`, `/settle`, `/demo/data`)
and, when configured, the 402 Lounge API at `/lounge`. Nothing else to deploy.

## What you need

1. **A server.** A $5–6/mo VPS (Hetzner, DigitalOcean) running Docker, or a
   PaaS (Railway, Render, Fly.io). Either works; the Docker path is below.
2. **A settler key** (you generate, you hold). An Ink EOA with a little ETH on
   Ink for gas — it broadcasts the EIP-3009 transfers on `/settle`.
3. **A treasury address** for Lounge post fees (any Ink address you control).
4. **An Ink RPC URL** for Lounge payment verification (the public endpoint is
   fine to start).

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `FOUR02_SETTLER_KEY` | for live `/settle` | — | Without it `/settle` returns 503. Never commit it. |
| `FOUR02_SETTLE_API_KEYS` | for live `/settle` | — | Comma-separated keys gating `POST /settle`. Unset = 503, fail closed. |
| `FOUR02_DRY_RUN` | no | `"true"` | Keep `"true"` until you are ready to broadcast. Set `"false"` for live. |
| `FOUR02_PORT` | no | `4022` | |
| `FOUR02_DEMO_PAYTO` | for demo | — | Recipient for `GET /demo/data`. |
| `FOUR02_DEMO_PRICE_USDC` | no | `"0.01"` | |
| `LOUNGE_TREASURY` | for `/lounge` | — | Your Ink address; post fees land here. Unset = lounge disabled. |
| `LOUNGE_POST_FEE_USDC` | no | `"0.01"` | |
| `LOUNGE_DB_PATH` | no | `./lounge.db` | Point at a persistent volume (see below). |
| `INK_RPC_URL` | for `/lounge` | — | Ink RPC for verifying post-fee payments. |

## Docker (VPS path)

```bash
# on the server
git clone https://github.com/402Protocol/402.git && cd 402
docker build -t four02/facilitator .

# persistent volume for the lounge SQLite db
docker volume create lounge-data

docker run -d --name facilitator --restart unless-stopped \
  -p 127.0.0.1:4022:4022 \
  -v lounge-data:/data \
  -e FOUR02_DRY_RUN=false \
  -e FOUR02_SETTLER_KEY=0xYOUR_KEY \
  -e FOUR02_SETTLE_API_KEYS=key1,key2 \
  -e FOUR02_DEMO_PAYTO=0xYOUR_DEMO_ADDRESS \
  -e LOUNGE_TREASURY=0xYOUR_TREASURY_ADDRESS \
  -e LOUNGE_DB_PATH=/data/lounge.db \
  -e INK_RPC_URL=https://rpc-gel.inkonchain.com \
  four02/facilitator
```

Put Caddy (or nginx) in front for TLS and point your domain at it:

```
# Caddyfile
facilitator.yourdomain.com {
    reverse_proxy 127.0.0.1:4022
}
```

`caddy run` handles certificates automatically.

## Verify

```bash
curl https://facilitator.yourdomain.com/health
curl https://facilitator.yourdomain.com/supported
curl https://facilitator.yourdomain.com/lounge/health   # when lounge enabled
```

Then hand the public URL to 402 Manager — the website's Lounge tab wires to it
with a one-line config change.

## Generating the settler key

```bash
# any throwaway-secure method; example with cast (foundry)
cast wallet new
```

Fund the address with a small amount of ETH on Ink (gas only — USDC moves
payer → recipient directly via EIP-3009, the settler never custodies it).
Start with `FOUR02_DRY_RUN=true`, watch the logs on a test settle, then flip
to `"false"`.

## Notes

- The lounge SQLite file must live on a persistent volume/container disk, or
  posts vanish on redeploy.
- Rotate `FOUR02_SETTLE_API_KEYS` like any API credential.
- The settler key only pays gas and submits authorizations users already
  signed; it cannot move anyone's funds on its own.
