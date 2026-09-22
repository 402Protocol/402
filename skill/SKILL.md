---
name: "402"
description: "Create, pay, and check 402 payment invoices on Ink (native USDC). Use when the user wants to invoice another agent, pay an invoice they received, or check an invoice's payment status."
metadata: { "includeInPrompt": true }
---

# 402 — Agent Payments on Ink

## Purpose
Issue EIP-712 signed invoices, pay them in native USDC on Ink (chain 57073),
and check invoice/payment status. Phase 1: invoices only — no smart contracts.

## Tooling
Repo: `~/workspace/402` (deps installed). Run via `npx tsx`:

- **Issue** (implicit approval — creates a request, spends nothing):
  `npx tsx ~/workspace/402/src/cli/issue.ts --issuer 0x... --amount 1.50 --description "..." [--payer 0x...] [--terms "..." | --terms-hash 0x...] [--expires-in 86400] [--out invoice.json]`
  Signs with `FOUR02_ISSUER_KEY` from env.
- **Pay** (explicit approval — see rules):
  `npx tsx ~/workspace/402/src/cli/pay.ts --invoice invoice.json` — dry run, prints the transfer plan only.
  Add `--broadcast` to submit — **only after the user approves that exact payment in chat.** Signs with `FOUR02_PAYER_KEY`.
- **Status** (read-only, no approval needed):
  `npx tsx ~/workspace/402/src/cli/status.ts --invoice invoice.json [--from-block N]`

## Auth
- `FOUR02_ISSUER_KEY` / `FOUR02_PAYER_KEY`: 0x-prefixed private keys from env,
  provided via the Secure Vault. Never print, log, or paste them anywhere.
  The scripts refuse keys passed as CLI args.
- The founder holds all keys. If a key is missing, stop and ask — never
  generate or substitute one silently.

## Operating Rules
1. **Always verify before paying.** `pay.ts` verifies the EIP-712 signature,
   token (must be `0x2D270e6886d130D724215A266106e6832161EAEd`),
   chain (57073), amount, and expiry before building any transfer. Never skip.
2. **Approval posture:** `issue_invoice` = implicit. `pay_invoice` / any
   broadcast = **explicit user approval of that exact payment** — no standing
   authorization, no silent spending. Default to dry-run; show the plan first.
3. Amounts: `--amount` is human USDC (6 decimals); JSON stores the smallest unit.
4. `payer` zero address = payable by anyone; otherwise only that address may pay.
5. Invoice IDs are the EIP-712 digest — content-addressed. Tampering breaks the signature.
6. `status` payment detection is heuristic (USDC Transfer events to the issuer
   ≥ amount in the scanned range). Say "likely paid", never certain, unless the
   founder confirms out of band.
