# 02 — Post-audit diff review (overnight workstream 2)

**Date:** 2026-09-23 · **Reviewer:** subagent workstream 2 · **Scope:** every commit
since the 2026-09-22 audit, reviewed read-only (`git show`, no code changes)

Reference: `../2026-09-22-security-audit.md`, `../2026-09-22-fix-designs.md`.
Remote `origin/main` HEAD: `4d5c8c66` ("Allow browser clients: CORS on facilitator + lounge API").

## Commit inventory

```
4d5c8c6  2026-09-22 21:23 -0400  Allow browser clients: CORS on facilitator + lounge API
02638fb  2026-09-22 20:20 -0400  Railway readiness: PORT env fallback, mkdir for lounge DB path
ddfc6fd  2026-09-22 20:08 -0400  Deploy: Dockerfile, DEPLOY.md guide, start script
3f5c8d4  2026-09-22 19:43 -0400  402 Lounge backend: agent social feed API (+ MVP, squashed initial commit)
```

**Classification: none of the post-audit commits is audit remediation.** The
squashed initial commit `3f5c8d4` already contains all approved audit fixes —
verified present via `git grep` on the tree:

- H3 pull-payments: `contracts/AgentEscrow.sol` has `claim()`, `claimable()`,
  `NothingToClaim` error (L81), claims recorded instead of pushed (L134-136)
- H4 timelocked rotation: `ROTATION_DELAY = 14 days` (L38), `proposeRotation` /
  `confirmRotation`, `RotationTooEarly` (L84)
- M1 `/settle` API-key allowlist: `FOUR02_SETTLE_API_KEYS` in
  `src/facilitator/config.ts:55`, fail-closed 503 in `src/facilitator/server.ts:264`
- M3 refund grace: `refundDelay` immutable (L104), `refund` opens at
  `deadline + refundDelay` (L326)

All four later commits are **new work / ops hardening** (Lounge backend,
Docker/Railway deploy plumbing, CORS). The audit explicitly excluded the
website; the Lounge *server* code is likewise new and was not in audit scope
(see §4).

> Repo-state note (not a finding): the local checkout's `main` (HEAD `70a9b7d`)
> is behind and SHA-diverged from `origin/main` — the remote history was
> rewritten/squashed after the local clone (local `fb4ab23`+`be17ed9` vs remote
> `3f5c8d4`; local `70a9b7d` vs remote `02638fb` for the same message). This
> review is against `origin/main`. Whoever works locally next should
> `git fetch` + reset to `origin/main` to avoid pushing a diverged history.

---

## 1. `4d5c8c6` — CORS on facilitator + lounge API — **SAFE**

**Diff** (the entire change, `src/facilitator/server.ts:181-183`):

```ts
// The 402 site and other browser clients call this API cross-origin.
// Writes stay signature-gated; CORS only lets browsers read/post.
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));
```

The middleware is registered before `app.route('/lounge', createLoungeApp(...))`
(`server.ts:196`), so it covers the Lounge routes too. `hono/cors` with
`origin: '*'` does **not** emit `Access-Control-Allow-Credentials`, so no
ambient-credential leakage is possible.

### Route-by-route gating audit (all routes in the tree at `4d5c8c6`)

Facilitator (`src/facilitator/server.ts`):
| Route | Type | Gate |
|---|---|---|
| `GET /health` | read | none needed |
| `GET /supported` | read | none needed |
| `POST /verify` | read-only check (H1 fix: `markUsed: false`, L261) | requires a valid EIP-3009 authorization in the body; consumes nothing |
| `POST /settle` | write (spends operator gas) | API-key allowlist, fail-closed 503 when `FOUR02_SETTLE_API_KEYS` unset (L267-275); timing-safe compare (`apiKeyAllowed`, L164-171); plus 30 req/min/IP rate limit (L187) |
| `GET /demo/data` | payment-gated read | x402 challenge; nonce consumed via `markUsed: config.dryRun` (L342-345) — L1 fix confirmed |

Lounge (`src/lounge/server.ts`, mounted at `/lounge`):
| Route | Type | Gate |
|---|---|---|
| `GET /health`, `GET /posts`, `GET /posts/:id` | reads | none needed (query params validated: sort whitelist, limit ≤ 100) |
| `POST /posts` | write | EIP-712 `LoungePost` signature from `author` + ±5-min timestamp freshness (L182-209); **onchain USDC payment verified** — `verifyPostPayment` requires a `Transfer(author → treasury, ≥ fee)` event from the Ink USDC contract in a successful tx receipt (L211-220); tx hash single-use via `markPaymentUsed` with a re-check inside the atomic section (L223-226, L244-249); per-author rate limit (1 post/60s) |
| `POST /posts/:id/comments` | write | EIP-712 `LoungeComment` signature + freshness (L251-308); rate-limited 5/60s |
| `POST /posts/:id/vote` | write | EIP-712 `LoungeVote` signature + freshness (L309-353); idempotent `upsertVote`; rate-limited 20/60s |

**No ungated write found.** `origin: '*'` is acceptable here because CORS is an
access-control relaxation on *who may read responses cross-origin*, and every
state-changing path independently requires something the browser cannot mint
for an attacker: a payer/author private-key signature, a valid EIP-3009
authorization, or the `/settle` API key. A malicious site cannot forge any of
these for a victim; the worst it can do is submit requests the attacker could
already submit server-side. The phishing caveat (a malicious site tricking a
user's wallet into signing a `LoungePost`) is a wallet-UX issue, not a CORS
issue — CORS neither enables nor worsens it.

Minor observations (not concerns):
- `allowMethods` omits PUT/PATCH/DELETE — fine, no such routes exist.
- `settleApiKey` (`server.ts:147-158`) also accepts `?api_key=` in the query
  string. Keys in URLs land in access logs and browser history; prefer headers
  operationally. Not a vulnerability in this deployment (Railway logs are
  founder-visible), but worth a docs nudge in `DEPLOY.md`.
- Rate limits (600/min global, 30/min `/settle`; `server.ts:97-98`) run *after*
  the CORS middleware, so preflights consume budget — irrelevant at these
  levels.

**Verdict: SAFE.** The key question — "is `origin: '*'` acceptable given all
writes are gated?" — is answered yes, with per-route evidence above. One
standing invariant for the future: if any endpoint ever relies on ambient
credentials (cookies), `origin: '*'` fails closed in browsers (credentialed
requests are rejected when `ACAO: *`), which is the safe direction.

---

## 2. `02638fb` — Railway readiness — **SAFE** (one low-severity ops caveat)

**Diff:**
- `src/facilitator/config.ts:50`: `parseInt(env.FOUR02_PORT ?? env.PORT ?? '4022', 10)`
  (was `FOUR02_PORT` only). The existing validation (`port <= 0 || port > 65535`
  throws) is unchanged. Railway injects `PORT`; this is the standard adaptation.
- `src/lounge/db.ts:50-54`: `mkdirSync(dirname(path), { recursive: true })`
  before `new DatabaseSync(path)` so `LOUNGE_DB_PATH=/data/lounge.db` works on a
  fresh Railway volume.

Assessment:
- **No path-traversal concern.** `LOUNGE_DB_PATH` is an operator-set env var,
  never attacker input. `mkdirSync` on `dirname()` cannot be steered by a
  remote caller.
- **No silent-failure concern of note.** `recursive: true` is a no-op when the
  dir exists; an unwritable path throws at startup (fail-fast, correct). One
  low-severity ops caveat: a *typo'd* `LOUNGE_DB_PATH` (e.g. `/date/lounge.db`)
  will now be silently created and the service will happily write posts to a
  non-persistent directory — the failure mode is "posts vanish on redeploy"
  instead of a startup crash. `DEPLOY.md` already documents pointing the path
  at the volume; acceptable, but a startup log line echoing the resolved DB
  path would make misconfiguration visible. (Cosmetic: the error message says
  `FOUR02_PORT` even when `PORT` was the offending variable; `parseInt` is
  lenient about trailing junk, e.g. `"4022abc"` → `4022` — Railway always sets
  a clean numeric `PORT`, so this is theoretical.)

**Verdict: SAFE.**

---

## 3. `ddfc6fd` — Dockerfile / DEPLOY.md / start script — **SAFE** (minor notes)

- `Dockerfile`: `node:24-slim`, `npm install`, copies `src/`, `test/`,
  `tsconfig.json`; `CMD ["npx", "tsx", "src/cli/facilitator.ts"]`. Runs on tsx
  directly — no build step, fine for this service.
- `.dockerignore` excludes `node_modules`, `.git`, `*.db`, `.env*`, `audits/`,
  `brand/` — good hygiene; no secrets baked in (`.env*` excluded, settler key
  is env-only per DEPLOY.md).
- `DEPLOY.md`: docs-only. The `docker run` example uses `0xYOUR_KEY`-style
  placeholders, never a real key. `package.json`: adds `"start"` script —
  required, since Railway defaults to `npm start`.

Minor notes:
- `npm install` instead of `npm ci` → non-fully-reproducible image builds
  (lockfile is copied, but `install` may still resolve differently than `ci`
  in edge cases). Prefer `npm ci` for deterministic deploys.
- `test/` is copied into the image — slight bloat, harmless.
- DEPLOY.md's reverse-proxy section (Caddy/TLS) is the right call; the
  Railway path terminates TLS at the platform.

**Verdict: SAFE.**

---

## 4. Lounge backend (`src/lounge/`) — new, unaudited code — **QUESTION** (review recommended)

The Lounge server (`config.ts`, `db.ts`, `escape.ts`, `payments.ts`,
`ratelimit.ts`, `server.ts`, `signing.ts`, `types.ts`, `spec/lounge-api.md`)
landed in the initial commit *after* the 2026-09-22 audit and was not in audit
scope (the audit excluded the website; the Lounge API is new server-side
attack surface that gates real-money-adjacent writes).

This diff-review checked gating (see §1 table) and spot-read `signing.ts` and
`payments.ts`. What looks right:

- `verifyPostPayment` (`payments.ts`): requires `receipt.status === 'success'`,
  a `Transfer` log **emitted by the Ink USDC contract address**
  (`log.address == USDC_ADDRESS`), with `from == author`, `to == treasury`,
  `value >= feeUnits`; tx hash format-validated and single-use-burned in
  `server.ts`. An attacker cannot credit someone else's payment: the signature
  binds `author`, and the transfer's `from` topic must equal that author.
- `verifyLoungeSignature` (`signing.ts`): EIP-712 domain `("402 Lounge", "1",
  chainId 57073)`, strict `0x`+130-hex signature format, fail-closed
  (`ok:false`, never throws), signer must equal claimed author.
- Server-side output escaping exists: `escapeHtml` (`escape.ts`) — which is
  why the site was rendering raw `&#x27;` entities (see §5).

Known limitations worth a follow-up review pass (not blocking):
- Comments/votes rely on signature + ±5-min timestamp freshness with **no
  nonce**; a captured signature is replayable within the window (duplicating
  a comment, or re-casting the same vote — the latter is idempotent via
  `upsertVote`). Rate limits (5 comments / 20 votes per 60s per author) bound
  the spam. Posts are additionally protected by the single-use payment hash.
- The Lounge EIP-712 domain has no `verifyingContract` — acceptable for an
  offchain social API (the payment leg, not the signature, binds value), but
  a second deployment of the same domain shape on another chain would share
  the domain; signatures are chain-bound by `chainId` only.
- `db.ts` uses `node:sqlite` `DatabaseSync` — synchronous; fine at this scale.

**Verdict: QUESTION — recommend a focused review of `src/lounge/` (signature
replay semantics, payment-verification edge cases, DB concurrency) before the
Lounge handles meaningful fee volume.** Nothing in this pass suggests an
immediate hole; the gating architecture is sound.

---

## 5. Website artifact changes (out of repo scope — assessed from descriptions)

Not in git (artifacts live outside this repo); assessed from the task
descriptions only:

- **(i) Tab navigation stays in-page instead of handing links to the OS
  browser.** Neutral UX fix. No security implication. **Safe.**
- **(ii) Lounge read requests dropped the JSON `Content-Type` header to avoid
  CORS preflight.** This makes the request CORS-"simple" (no preflight
  round-trip) — a latency optimization only. It changes nothing about
  enforcement: the server was already answering preflights permissively
  (`ACAO: *`), and neither `readX402Body` (`facilitator/server.ts`) nor the
  lounge `readBody` (`lounge/server.ts`) requires a JSON content-type — both
  parse `req.text()` directly, so the requests still work. Note the
  interaction runs the other way too: with `ACAO: *` on the server, the
  client-side header juggling is purely cosmetic. **Safe.**
- **(iii) Lounge renderer decodes HTML entities, inserts via `textContent`
  only.** **XSS-safe as described.** `textContent` never parses HTML, so even
  a fully attacker-controlled string (e.g. `<img src=x onerror=...>`) is
  inert. This is also the *correct* pairing with the server's `escapeHtml`
  (`src/lounge/escape.ts`): the server escapes on output, the client decodes
  for display, and the decoded text stays in the text domain.
  **Caveat (standing rule):** it is safe *only* while the decoded text flows
  exclusively into `textContent`/text nodes. If the decoded string were ever
  routed into `innerHTML`, an attribute (`href`, `src`, event handlers), or
  `eval`/`new Function`, the entity-decoding step would become an XSS
  enabler. Also, the decode step itself must not execute markup — decode via
  `textarea.value` / `DOMParser` / manual replacement, never by assigning to
  `innerHTML` of a live element. If a future feature needs rich rendering
  (links, markdown), it needs a sanitizer, not entity-decoding.

---

## Summary of verdicts

| Change | Commit | Verdict |
|---|---|---|
| CORS `origin: '*'` on facilitator + lounge API | `4d5c8c6` | **Safe** — all 11 routes enumerated; every write is signature-, payment-, or API-key-gated; no ungated write |
| Railway readiness (`PORT` fallback, DB `mkdir`) | `02638fb` | **Safe** — env-var path not attacker-controlled; one low-severity ops caveat (typo'd DB path silently created) |
| Dockerfile / DEPLOY.md / `npm start` | `ddfc6fd` | **Safe** — minor notes: prefer `npm ci`; `?api_key=` query param accepted on `/settle` (log hygiene) |
| Lounge backend (`src/lounge/`) | `3f5c8d4` | **Question** — new unaudited surface; gating architecture looks sound on spot-read; recommend a focused review before meaningful fee volume |
| Website artifacts (tab nav, preflight avoidance, entity-decode + textContent) | n/a (out of repo) | **Safe as described**, with the standing textContent-only caveat |

**No audit-remediation commits exist post-audit** — all approved fixes (H3
pull-payments, H4 timelocked rotation, M1 `/settle` allowlist, M3 refund
grace) are already in the initial commit. Nothing in this diff review
re-opens or regresses any audit finding: H1 (`/verify` read-only) and L1
(demo nonce marking) are intact at HEAD, and the CORS change does not weaken
any gate the audit relied on.

Open follow-ups for the parent: (1) local checkout is behind/diverged from
`origin/main` — reset before further pushes; (2) schedule the focused
`src/lounge/` review; (3) consider `npm ci` in the Dockerfile and a
headers-only preference for `/settle` API keys in DEPLOY.md.
