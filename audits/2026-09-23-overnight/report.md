# 402 Overnight Audit

**Date:** 2026-09-23 (run overnight while you slept)
**Scope:** everything built so far — signed invoices + skill, x402 facilitator, Lounge API + website feed, smart contracts, and the production API on Railway.
**Method:** strictly read-only. All test suites re-run from scratch. Every code change since the last audit reviewed line by line. The live production API probed with careful read-only checks. No code was changed, nothing was deployed, no money moved, no wallets touched.

## Headline

Everything passes: **146 tests, 0 failures.** The live API matches the latest code exactly. No secrets leaked anywhere in the repo or its history. **No critical issues found.** Two high-severity issues need fixing before real money ever flows through the facilitator — both are harmless today because the system is in practice mode. Three medium issues to fix before scaling. The smart-contract fixes from the last audit are all still in place, and the contracts remain undeployed, waiting on your five deploy decisions.

## Test results

| Area | Command | Result |
|---|---|---|
| Invoices (sign / verify / hash) | `npm test` | 16/16 pass (grew from 10 — new coverage added since) |
| x402 facilitator | `npm run test:facilitator` | 32/32 pass |
| Lounge API | `npm run test:lounge` | 42/42 pass |
| TypeScript typecheck | `npm run typecheck` | clean, no errors |
| Smart contracts | `forge test` | 56/56 pass |
| **Total** | | **146/146 pass, 0 fail** |

## Production check (read-only)

Live API: `https://402-production.up.railway.app`

- Health checks pass. The API reports practice mode (`dryRun: true`) — no real settlement can happen.
- The deployed code matches the latest GitHub commit exactly (verified through the new CORS headers, including the full browser preflight check browsers run before connecting).
- `/settle` correctly refuses with 503 `settle_auth_not_configured` — no settler key installed, as intended.
- The Lounge feed serves the first agent post.
- Error responses are clean (`400 {"error":"invalid_json"}`, plain 404s).
- Gentle rate-limit probing showed no issues.

## Findings

### Critical — none

Nothing found that puts funds at risk today. The facilitator is in practice mode and the contracts are not deployed.

### High — fix before live money moves (2)

**H1 — The demo endpoint could move real money with no key.**
The demo page (`/demo/data`) has a code path that settles a payment without checking an API key. Today that's harmless because the whole system is in practice mode. But the moment the "live" switch is flipped, anyone could trigger real USDC transfers through it. Fix: require the API key (or add a quota) on that path before go-live.
*Ref: `src/facilitator/server.ts:360-363`*

**H2 — Two settle requests at the same instant can double-send.**
There is no lock between checking a payment and broadcasting it, so two identical requests racing each other can both broadcast; the loser's transaction fails onchain and we still pay the network fee for it. Only someone holding an API key could trigger this. Fix: a per-payment lock before live.
*Ref: `src/facilitator/settle.ts:85`*

### Medium — fix before scaling or meaningful volume (3)

**M1 — A signed comment can be replayed for 5 minutes.**
Comments are signed messages (a standard cryptographic signature proving who wrote them) but carry no one-time code, so the same signed comment can be submitted twice inside its 5-minute freshness window, creating a duplicate. Rate limiting slows this down but doesn't stop it. Fix: add a one-time code (nonce — a single-use number that stops a signed message being reused) to comments, like posts already have through their payment receipts.
*Ref: `src/lounge/` — no nonces anywhere in lounge code*

**M2 — The Lounge database assumes exactly one server.**
It uses a local file database with no special concurrency mode. Fine today (one server on Railway). But if a second server ever shares the same disk, writes start failing — and in one corner case a single $0.01 fee could publish two posts. Rule: never scale the Lounge past one server without switching databases first.
*Ref: `src/lounge/db.ts`*

**M3 — The payment tracker can grow forever.**
Used payment codes are kept in memory with no size cap, and there is no limit on how far in the future an authorization may be valid. An attacker could stuff it with junk entries, making every check slower over time. Fix: cap how far ahead an authorization can be valid, and cap the tracker's size.
*Ref: `src/facilitator/nonces.ts:37-46`*

### Low — polish (5)

**L1 — API keys work in the URL.** `/settle` accepts `?api_key=` in the web address, which can leak into server logs. Use the request header instead.
*Ref: `src/facilitator/server.ts:169-171`*

**L2 — The Lounge API sends text pre-escaped.** Post bodies come back with `&#x27;` instead of `'`. The website now decodes this safely, but any future app reading the API must know the rule: decode, then display as plain text — never as HTML — or you get either garbled text or a security hole. Write the rule down.
*Ref: `src/lounge/escape.ts:5-11`, `src/lounge/server.ts:86-97`*

**L3 — Rate limiting trusts a spoofable header.** The client IP is read from `X-Forwarded-For`, which callers can fake. Verify what Railway actually sends before relying on per-IP limits.
*Ref: `src/facilitator/server.ts:101-108`*

**L4 — Small ops nits.** A typo'd database path gets silently created instead of erroring; the Dockerfile uses `npm install` instead of the stricter `npm ci`; `/supported` doesn't advertise practice mode; the Lounge's offline screen has no retry button; authors can vote on their own posts (impact capped at ±1).

**L5 — Wiping the Lounge database resurrects old payments.** If the database file is ever deleted, the record of used fee payments goes with it, and old receipts could pay for new posts. Ops note: back up the volume; treat a wipe as a full reset.

### Info (4)

- **I1 — This Mac's local repo copy is behind GitHub.** The remote history was squashed after cloning, so the local checkout has diverged from `origin/main`. Reset it before any future push from this machine.
- **I2 — The "rebuild the website" advice was wrong.** A previous automated check claimed the site couldn't reliably reach the API and needed a server-backed rebuild. Evidence says otherwise: the feed loads on your device, and the API's CORS headers verify cleanly. No rebuild needed.
- **I3 — Contracts unchanged and undeployed.** All five fixes from the last audit verified still in place (pull-payment claims, 14-day timelocked arbiter rotation, immutable 24h refund delay, 10% onchain fee cap). The five deploy decisions remain yours.
- **I4 — Secret hygiene clean.** Scanned the repo and its full history: no private keys, tokens, or credentials. Sensitive values come only from environment variables and are never logged.

## Still open from before (unchanged)

- Professional third-party audit before meaningful mainnet escrow volume.
- Settler wallet: generate, fund, keep in your hands (nothing configured — correct).
- Production API-key issuance + rotation plan for `/settle`.
- Demo recipient for the paid demo endpoint.

## What's still missing before live settlement (checklist)

Persistent payment-code storage (shared, not in-memory) · per-payment lock on `/settle` · settler key + low-balance alerts · per-key daily settle quotas · `/demo/data` posture decided · validity horizon + size cap on the tracker · deliberate demo recipient/price · Railway header behavior verified · RPC fallback · monitoring (USDC pause, settler balance, `/settle` errors).

## Next actions — one decision each

1. **Approve the pre-live hardening batch** (fixes H1, H2, M3, L1, L3) — nothing goes live until these are in. *Your call: green-light it and the work gets scheduled.*
2. **Decide the demo endpoint's live posture** — require API key, add a quota, or accept the economics as-is. *Your call.*
3. **Approve the Lounge hardening** (one-time codes on comments; written-down text-escaping rule) — needed before real posting volume. *Your call.*
4. **Fill the five contract deploy parameters** (arbiter, fee recipient, guardian, fee rate, refund delay). *Your call — keys and money stay with you.*
5. **Set up the settler wallet** (generate + fund on Ink) when you're ready for live settlement. *Your call.*

## Evidence

Raw logs and per-workstream notes: `~/workspace/402/audits/2026-09-23-overnight/`

- `01-suites.log` — full test output, all suites
- `02-diff-review.md` — every post-audit commit reviewed
- `03-production-probe.log` — raw production probe output
- `04-lounge-review.md` — Lounge API code review
- `05-facilitator-review.md` — facilitator code review + go-live checklist
- `06-secret-hygiene.md` — secret scan (redacted)
- `07-artifact-inspection.md` — website integration check
- `08-contracts-review.md` — contract remediation re-verification
- `report.md` — this report

*Audit performed read-only overnight 2026-09-23. Nothing was changed, deployed, or moved. This does not replace a professional third-party audit before mainnet volume.*
