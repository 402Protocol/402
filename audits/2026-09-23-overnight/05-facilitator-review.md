# Workstream 5 — Facilitator code review (read-only)

**Date:** 2026-09-23 · **Scope:** `src/facilitator/*.ts` (source only; no servers run, no tests run, nothing broadcast)
**Context read first:** `audits/2026-09-22-security-audit.md`, `audits/2026-09-22-fix-designs.md`

Ratings: **ok** = verified sound · **note** = worth knowing, low risk or documented trade-off · **concern** = should be addressed before / around live settlement.

---

## 1. EIP-3009 authorization validation

**ok — EIP-712 domain check** (`verify.ts:146-166`, `eip3009.ts:30-37`)
`recoverTypedDataAddress` recovers the signer over the `TransferWithAuthorization` struct typed against the registry domain (`name: "USDC"`, `version: "2"`, `chainId: 57073`, `verifyingContract: 0x2D27…1EAEd`) and requires it to equal `auth.from`. A signature minted for any other domain/token/chain fails closed here. The domain constants come from the local chain registry (`chains.ts:44-53`) — trusted config, not re-read live. If Ink USDC's domain ever changed (proxy upgrade), verification fails closed (good direction), never open.

**ok — time windows** (`verify.ts:167-168`): `now < validAfter` → `authorization_not_yet_valid`; `now >= validBefore` → `authorization_expired`. Matches EIP-3009 onchain semantics (`validAfter <= t < validBefore`).

**ok — value / from / to** (`verify.ts:141-142`): `value !== amount` → `amount_mismatch`; `auth.to` must equal `required.payTo` → `recipient_mismatch`. `auth.from` is authenticated by the signature itself. **ok — asset pinning** (`verify.ts:124`): `required.asset` must equal the registry's USDC address for the network — a resource server cannot point the facilitator at a malicious token. This is the facilitator-side analog of the H5 deploy-footgun check, and it holds.

**note — `maxTimeoutSeconds` is accepted but never enforced** (`verify.ts`, `server.ts:62-67`). `demoRequirements` sets `maxTimeoutSeconds: 120`, and `VerifyRequest` carries it, but nothing compares `validBefore` against `now + maxTimeoutSeconds`. A payer can therefore authorize with `validBefore = 2^256-1` (valid "forever"), and the nonce entry then never expires (see §2). Recommend enforcing: reject when `validBefore > nowSec + required.maxTimeoutSeconds` (with a sane default cap when the field is absent).

**note — no explicit chain-id / token-code assertion against the live RPC.** `viemChain(cfg)` (`eip3009.ts:54-61`) stamps `id: cfg.chainId` into the viem chain object, so viem's wallet client will refuse to broadcast on a chain-id mismatch (fail-closed at broadcast). There is no `getChainId` / `getCode` pre-check in `settleExactPayment` itself. If the registry pointed at an address with no code, `authorizationState`/`simulateContract` throw → `settlement_failed` (fail-closed), but `/verify` (pure offchain) would still return `isValid: true` for a chain where the token doesn't exist. Acceptable posture, worth one line in the runbook: `/verify` validity is necessary, not sufficient, for settleability.

## 2. Nonce lifecycle (post-H1/H2)

**ok — H1 (verify no longer consumes):** `POST /verify` passes `markUsed: false` (`server.ts:263`); `settleExactPayment` verifies with `markUsed: false` (`settle.ts:68`). Nonce consumption happens only (a) in `/settle` after broadcast confirmation (`settle.ts:198`) or passed dry-run simulation (`settle.ts:157`), or (b) in `/demo/data` on data grant in dry-run mode (`server.ts:345`, `markUsed: config.dryRun`).

**ok — H2 (sweep uses real time):** `NonceStore.mark` calls `this.sweep(Date.now()/1000)` (`nonces.ts:37-39`); sweep only evicts entries with `expiry <= nowSec` and only runs at ≥10k entries (`nonces.ts:41-46`). The old bug (wiping the store by passing an entry's expiry) is gone.

**ok — double-spend of funds is not possible.** Three layers: local `store.has` (`settle.ts:85`), onchain `authorizationState(from, nonce)` (`settle.ts:108-125`), and the token contract itself consuming the nonce on `transferWithAuthorization`. Funds can never move twice.

**concern — concurrent duplicate `/settle` can double-broadcast; operator pays for the reverted tx.** There is no in-flight/per-nonce lock between the `store.has` check (`settle.ts:85`), the `authorizationState` read, and the broadcast. Two concurrent requests with the same auth both pass both checks, both broadcast; one succeeds, one reverts onchain, and the settler key pays gas for the revert. This is the residual M1 concurrency vector the fix-design doc named explicitly ("N-1 reverted transactions the operator pays for") — API keys + rate limits narrow *who* can trigger it but don't close it. Fix before live: per-nonce mutex / DB row lock, or at minimum a "pending" mark set before broadcast and cleared on failure.

**concern — `NonceStore` has no hard size cap; unbounded growth via far-future `validBefore`.** Sweep evicts only *expired* entries (`nonces.ts:43-45`), and `mark` scans the whole map on every call once ≥10k entries. Combined with `maxTimeoutSeconds` being unenforced (§1), an attacker can mint self-signed auths with `validBefore = 2^256-1` and feed them to `/demo/data` (unauthenticated, only needs a valid self-signature for $0.01) to grow the map with entries that never expire — after 10k, every `mark()` is an O(n) full scan that evicts nothing: memory + CPU DoS. Rate limits (600/min global) slow it (~17 min to 10k) but don't stop it. Fixes: enforce a `validBefore` horizon (ties to the `maxTimeoutSeconds` note above), and/or cap the map (LRU eviction).

**note — in-memory only, acknowledged in code** (`nonces.ts:1-13`). Restart or a second instance forgets used nonces. For `/settle` the onchain `authorizationState` is a real backstop, but `/verify`-only flows and the concurrency window above get no help from it. Production needs the shared store the header comment already calls for (Redis/D1/DynamoDB).

**note — dry-run simulation consumes the nonce locally** (`settle.ts:157`). Within one process lifetime this is intentional (one sim per auth), and env changes require a restart which wipes the store, so it can't poison a later live settle in practice. Just don't share a process between dry-run and live modes.

**note — `Number(validBefore)`** (`verify.ts:171`, `settle.ts:157,198`): precision loss on absurd uint256 values is harmless here (expiry comparison only), but it's the same far-future-horizon input the store-cap concern relies on.

## 3. `/settle` API-key allowlist (M1)

**ok — fail-closed.** Empty/unset `FOUR02_SETTLE_API_KEYS` → `settleApiKeys: []` (`config.ts:73-77`) → `/settle` returns 503 `settle_auth_not_configured` *before* reading the body (`server.ts:272-278`). Invalid key → 401 (`server.ts:278-280`). Comparison is constant-time with a length pre-check (`server.ts:182-193`). `FOUR02_SETTLER_KEY` is format-validated at load and settlement refuses outright without it (`settle.ts:47-53`).

**concern — `/demo/data` is an unauthenticated path to broadcast settlement.** In production mode (`dryRun=false`) the demo route calls `settleExactPayment(..., dryRun: false)` (`server.ts:360-363`) with no API-key check. Anyone with $0.01 USDC can trigger a settler-paid broadcast per request (global rate limit 600/min/IP is the only second layer).In the current dry-run production this path cannot broadcast, so it is latent, not live. Before flipping `FOUR02_DRY_RUN=false`: either gate the demo's settle leg behind the same allowlist, add a per-IP daily quota, or consciously accept it — the economics ($0.01 lands in the founder's demo recipient per operator-gas spend) make blind gas-draining irrational, but a griefer doesn't need to be rational, just funded.

**note — `api_key` query param accepted** (`server.ts:169-171`). Keys in URLs end up in access logs and referers; prefer documenting header-only usage (`X-API-Key` / `Authorization: Bearer`).

## 4. Dry-run posture

**ok — dry-run cannot be mistaken for settlement by a careful reader.**
- `/settle` dry-run returns `{success: false, dryRun: true, errorReason: 'dry_run_mode'}` and never calls `writeContract` (`settle.ts:133-163`; the real broadcast lives in the separate `dryRun === false` branch, `settle.ts:178-203`).
- `/demo/data` dry-run returns data with an explicit `dryRun: true` field in the body *and* a `PAYMENT-RESPONSE` header carrying `{success:false, dryRun:true}` (`server.ts:367-389`).
- Default is dry-run: any value of `FOUR02_DRY_RUN` other than exactly `"false"` (case-insensitive) keeps simulation mode (`config.ts:82`) — typos fail safe.

**note — `/supported` doesn't advertise dry-run state.** A client can't distinguish "settler ready" from "simulation only" from `/supported` alone; the `signers` field only reflects key presence. Consider adding `dryRun` to `/supported` so resource servers can fail fast instead of discovering it at settle time.

**note — `/health` exposes `dryRun`** (`server.ts:190-192`). Harmless, arguably useful.

## 5. Rate limiting & body-size limits (L3)

**ok — present and sane.** JSON bodies capped at 64 KiB before `JSON.parse` on both `/verify` and `/settle` (`server.ts:229-230`), 413 on overflow (`server.ts:255-256`, `283-284`). Global 600 req/min/IP, plus a stricter 30 req/min/IP bucket on `/settle` (`server.ts:97-98`, `186-187`), 429 with `Retry-After`. Opportunistic map cleanup bounds the limiter's own memory (`server.ts:134-137`).

**note — `clientIp` trusts the leftmost `X-Forwarded-For` entry** (`server.ts:101-108`). If the edge (Railway) doesn't strip client-supplied `X-Forwarded-For`, per-IP buckets are bypassable by rotating the header. Worth verifying what Railway actually forwards; if it appends rather than overwrites, key the limiter off the *last* (proxy-added) entry instead.

**note — preflight `OPTIONS` requests count against the global bucket.** Cheap to serve, but a preflight flood is a (minor) asymmetric burn of other clients' quotas. Low priority.

**note — the limiter is per-process in-memory**, same caveat as `NonceStore`; fine for one instance, needs edge enforcement for multi-instance.

## 6. Missing before live settlement — checklist

- [ ] **Shared/persistent nonce store** (Redis/D1/DynamoDB) — in-memory forgets on restart; mandatory for multi-instance.
- [ ] **Per-nonce in-flight lock** for `/settle` — closes the concurrent double-broadcast gas-drain (§2 concern).
- [ ] **Settler key**: founder generates, funds with Ink ETH for gas, stores per the ownership rule. Currently unset in prod (→ 503), which is correct for now.
- [ ] **Settler low-balance alerting** + **per-API-key daily settle quotas** (both recommended in the M1 fix design, neither implemented).
- [ ] **Production API keys**: issue `FOUR02_SETTLE_API_KEYS` to known resource servers; document rotation.
- [ ] **Decide `/demo/data` posture** before `DRY_RUN=false`: gate its settle leg behind the API allowlist, quota it, or explicitly accept the unauthenticated-broadcast economics (§3 concern).
- [ ] **Enforce `maxTimeoutSeconds` / cap `validBefore` horizon** — closes the never-expiring-nonce store-growth vector and matches x402 semantics (§1–2).
- [ ] **Hard cap (LRU) on `NonceStore`** as defense-in-depth even after the horizon cap.
- [ ] **Demo recipient + price**: set `FOUR02_DEMO_PAYTO` / `FOUR02_DEMO_PRICE_USDC` deliberately (else `/demo/data` 500s).
- [ ] **Verify Railway's `X-Forwarded-For` handling** (§5 note) before relying on per-IP limits.
- [ ] **RPC redundancy**: single `INK_RPC_URL` (`rpc-gel.inkonchain.com`); no fallback if the endpoint degrades — settlement liveness depends on it.
- [ ] **Monitoring**: USDC `Pause`/`Unpause` events (M4 accepted risk), settler ETH balance, `/settle` 5xx rate.
- [ ] **Professional third-party audit** before the facilitator or escrow handles meaningful mainnet volume (per the 2026-09-22 audit's explicit non-coverage).

## 7. Anything else

- **ok — fail-closed patterns are consistent throughout**: malformed settler key throws at startup (`config.ts:29-34`); bad demo recipient/price/port throw (`config.ts:36-52`); `authorizationState` read failure → `settlement_failed`, never assumed unused (`settle.ts:116-125`); insufficient payer balance → `insufficient_funds` before broadcast (`settle.ts:164-176`).
- **ok — facilitator never custodies funds**; `transferWithAuthorization` moves payer → recipient directly, settler pays only gas. Matches the design comment (`eip3009.ts:1-10`).
- **note — signature malleability (high-s)**: `recoverTypedDataAddress` doesn't enforce low-s, but EIP-3009 nonces make malleated-signature replay a non-issue. Not a finding.
- **note — body-size check uses `text.length` (UTF-16 chars, not bytes)** (`server.ts:229`). Slightly lenient for multibyte bodies; negligible at 64 KiB.
- **note — `/verify` 400 vs `/settle` 200-with-`success:false` asymmetry** is intentional (x402 conventions) and documented in the response shapes; no issue.
- **H5 (token code-length check)**: that fix applied to `AgentEscrow`'s constructor, not the facilitator — confirmed out of scope here; the facilitator's equivalent (asset pinned to registry USDC, `verify.ts:124`) is in place.
