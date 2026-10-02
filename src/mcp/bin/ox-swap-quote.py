#!/usr/bin/env python3
"""0x v2 swap quote (with calldata) via the stored custom.0x credential.

Usage:
  ox-swap-quote.py --chain-id 57073 --sell-token 0x... --buy-token 0x... \
      --sell-amount 1000000 --taker 0x...

Prints JSON with buyAmount, estimatedPriceImpact, liquidityAvailable, and the
unsigned transaction {to, data, value, gas}. The API key never appears here:
the surrogate (hsurr:*) is exchanged for the real key by the egress proxy,
exactly like the 0x skill's 0x-price helper. Read-only: nothing is signed or
broadcast; the caller signs the returned transaction client-side.
"""
import argparse
import json
import subprocess
import sys
import urllib.parse

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import dynamic_credential_entry, ensure_allowed_url

ALLOWED_HOSTS = ["api.0x.org"]


def main() -> None:
    ap = argparse.ArgumentParser(description="0x v2 swap quote with calldata (read-only)")
    ap.add_argument("--chain-id", required=True, help="EVM chain id, e.g. 57073 for Ink")
    ap.add_argument("--sell-token", required=True, help="token address")
    ap.add_argument("--buy-token", required=True, help="token address")
    ap.add_argument("--sell-amount", required=True, help="amount in base units (integer string)")
    ap.add_argument("--taker", required=True, help="taker wallet address (used for calldata + allowance checks)")
    ap.add_argument("--slippage-bps", default="100", help="slippage tolerance in bps, default 100 = 1%")
    args = ap.parse_args()

    entry = dynamic_credential_entry("custom.0x")
    surrogate = str(entry["surrogate"]).strip()
    if not surrogate.startswith("hsurr:"):
        raise SystemExit("authd did not return a surrogate value")
    placement = entry.get("placement") or {}
    header_name = placement.get("custom_header", "0x-api-key")

    params = urllib.parse.urlencode(
        {
            "chainId": args.chain_id,
            "sellToken": args.sell_token,
            "buyToken": args.buy_token,
            "sellAmount": args.sell_amount,
            "taker": args.taker,
            "slippageBps": args.slippage_bps,
        }
    )
    url = f"https://api.0x.org/swap/allowance-holder/quote?{params}"
    ensure_allowed_url(url, ALLOWED_HOSTS)

    proc = subprocess.run(
        [
            "curl", "-sS", "--max-time", "30",
            "-H", "Accept: application/json",
            "-H", "0x-version: v2",
            "-H", f"{header_name}: {surrogate}",
            url,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(json.dumps({"error": "curl failed", "stderr": proc.stderr[-400:]}), file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(json.dumps({"error": "non-JSON response", "body": proc.stdout[:400]}), file=sys.stderr)
        sys.exit(1)
    if "buyAmount" not in data or "transaction" not in data:
        print(json.dumps({"error": "no buyAmount/transaction", "body": data}), file=sys.stderr)
        sys.exit(1)
    tx = data["transaction"] or {}
    out = {
        "buyAmount": data.get("buyAmount"),
        "sellAmount": data.get("sellAmount"),
        "grossBuyAmount": data.get("grossBuyAmount"),
        "netBuyAmount": data.get("netBuyAmount"),
        "estimatedPriceImpact": data.get("estimatedPriceImpact"),
        "liquidityAvailable": data.get("liquidityAvailable"),
        "issues": data.get("issues"),
        "transaction": {
            "to": tx.get("to"),
            "data": tx.get("data"),
            "value": tx.get("value"),
            "gas": tx.get("gas"),
            "gasPrice": tx.get("gasPrice"),
        },
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
