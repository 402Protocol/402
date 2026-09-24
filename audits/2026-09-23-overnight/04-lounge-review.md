# 402 Lounge API — code review (workstream 4)

Read-only audit of `~/workspace/402/src/lounge/` (`config.ts`, `db.ts`, `escape.ts`,
`payments.ts`, `ratelimit.ts`, `server.ts`, `signing.ts`, `types.ts`),
mounted at `/lounge` on the facilitator app (`src/facilitator/server.ts:194-195`).
No servers run, no DB writes, no tests executed.

Scope note: the task brief said "bodies are stored with HTML entities" — that is
not what the code does. Bodies are stored **raw** and escaped **on output**
(`server.ts:86-97`). The `&#x27;` seen in the site came from the API returning
pre-escaped strings (see §5).

---

## 1. EIP-712

- **ok** — Domain is exactly name `"402 Lounge"`, version `"1"`, chainId `57073`
  (`signing.ts:15-19`; `types.ts:8` defines `LOUNGE_CHAIN_ID = 57073`).
- **ok** — Verification uses viem `recoverTypedDataAddress` and requires the
  recovered signer to equal the claimed author, case-insensitively
  (`signing.ts:48-77`); malformed/unrecoverable signatures fail closed, never throw.
- **ok** — chainId is enforced implicitly but effectively: it is part of the
  EIP-712 domain separator, so a signature minted for any other chainId recovers
  a different address and fails the author-match check.
- **note** — No `verifyingContract` in the domain (documented at `signing.ts:1-7`);
  identity is per-address and the payment leg binds value, which is a defensible
  choice for this design. Message schemas (`LOUNGE_TYPES`, `signing.ts:21-36`)
  cover all write actions including `parentId` on comments, so a signed comment
  cannot be re-parented.

## 2. Replay protection

- **note** — There are no nonces anywhere in the lounge code (verified: no
  "nonce" matches in `src/lounge/`). Anti-replay is timestamp-only: signatures
  must be within ±5 min of server time (`signing.ts:23-32`, enforced at
  `server.ts` post/comment/vote routes).
- **ok** — Signed **post** payloads cannot be replayed: each payment tx hash is
  single-use (`used_payments` table, `db.ts:212-243`; checked before and after
  payment verification at `server.ts:229,243-244`, consumed at `:247`). A second
  submission of the same signature+tx returns 409 `payment_reused`.
- **concern** — Signed **comment** payloads CAN be replayed within the 5-minute
  window: every accepted submission mints a fresh `randomBytes(16)` id
  (`server.ts` comment route) with no signature-hash dedup, so one signed comment
  re-POSTed twice yields two identical comments. Rate limit (5 comments/60s per
  author, `ratelimit.ts:15`) bounds the blast radius but does not prevent
  duplication. Same window allows an accidental double-submit to double-post.
- **ok** — Signed **vote** payloads are effectively replay-safe: `upsertVote`
  is one active vote per `(post_id, author)` (`db.ts:168-210`), so a replayed
  vote is a no-op; direction is covered by the signature, so a replay cannot
  flip or amplify a vote.

## 3. Payment verification

- **ok** — `verifyPostPayment` (`payments.ts:64-104`) checks all of: tx hash is
  `0x`+64 hex; receipt exists via Ink RPC and `status === 'success'`; at least one
  log emitted by the Ink USDC contract (`constants.ts` `USDC_ADDRESS`) with topic
  `Transfer(address,address,uint256)` (`payments.ts:23-25`), from == author
  (topic, `payments.ts:90`), to == treasury (topic, `:91`), and
  `value >= feeUnits` in a single log (`:98`). Sender, token, recipient, and
  amount are all bound; the receipt comes from the Ink RPC so chain is inherent.
- **ok** — One fee cannot publish two posts: tx hashes are single-use (see §2).
  No recency/block-range check exists, but none is needed — an old unused
  payment is just a pre-paid credit, and reuse is blocked by the table.
- **note** — Any author→treasury transfer ≥ $0.01 in *any* tx qualifies (e.g. an
  unrelated payment to the treasury would also gate a post), but the author still
  paid the fee, so the economic invariant holds. `markPaymentUsed`'s `false`
  return (UNIQUE conflict) is ignored at `server.ts:247` — safe in the current
  single process (no awaits between the re-check, insert, and burn), but a
  latent double-accept path under a second writer (§4).

## 4. SQLite

- **note** — Library is `node:sqlite` `DatabaseSync` (`db.ts:1-6`), single
  connection, single process. WAL mode is **not** enabled and no
  `PRAGMA busy_timeout` is set.
- **ok** — Within one process the concurrency story holds: all multi-step
  mutations (`insertComment`, `upsertVote`) run inside `BEGIN IMMEDIATE`/`COMMIT`
  with no awaits inside (`db.ts:48-62`), and every DB call is synchronous, so
  interleaving is impossible.
- **concern** — Nothing survives a second writer. A second replica sharing the
  volume (or any second process opening the file) gets `SQLITE_BUSY` throws from
  `node:sqlite` → unhandled 500s on concurrent writes, and the ignored
  `markPaymentUsed` return (§3) becomes a real double-spend-of-fee path: two
  processes can both pass the `isPaymentUsed` re-check and insert posts for one
  fee. Prod today is 1 replica on Railway so this is latent, but the file is on
  a persistent volume precisely so it outlives restarts — any future scale-out
  or a stray second process must not share it.
- **note** — `GET /posts` loads the entire `posts` table into memory for
  JS-side sorting on every request (`db.ts:118-126`, `server.ts:180-185`);
  fine at MVP scale, a pagination-in-SQL TODO as the feed grows.
- **note** — Rate limits are in-memory per process (`ratelimit.ts`, documented
  single-process caveat) — also defeated by scale-out, consistent with §4's
  single-replica assumption.

## 5. Input validation & escaping

- **ok** — Length caps enforced before signature verification: title 1–140,
  post body 1–2000, comment body 1–1000 (`server.ts:31-33`, `:196-207`,
  comment-route equivalent); whole JSON body capped at 32 KiB
  (`server.ts:25,155-157`). `direction` restricted to `1`/`-1`, author must be
  a valid address, timestamps must parse as integers.
- **ok** — Escaping design is escape-on-output, which is the sound pattern:
  `escapeHtml` (`escape.ts:5-11`, covers `& < > " '`) applied in `publicPost`
  / `publicComment` (`server.ts:86-97`); all read routes go through these, and
  no other code path returns stored content. No double-escaping in the API
  (stored raw → escaped once on read).
- **note** — API contract quirk: the API returns *pre-escaped* strings in JSON
  rather than raw text, so every client must entity-decode before rendering —
  this is exactly what bit the static site (it rendered raw `&#x27;` until a
  client-side decode fix). Any future client that renders API strings via
  `innerHTML` without decoding gets escaped-text artifacts; one that decodes
  *and* fails to re-escape before `innerHTML` re-opens XSS. Consider returning
  raw content and pushing escaping to the renderer, or documenting the contract.
- **ok** — Non-content fields need no escaping: `id` is server-generated hex,
  `author` is validated as an address, counters are integers.

## 6. Votes / comments

- **note** — Authors CAN vote on their own posts: the vote route performs no
  author-vs-post-author check. Impact is limited (one vote per address via
  `PRIMARY KEY (post_id, author)`, `db.ts:148-153`), so it is at most a +1/−1
  vanity nudge per post, but it is presumably unintended.
- **ok** — Votes cannot be spammed: re-voting the same direction is a no-op,
  opposite direction flips the vote with counters adjusted atomically
  (`db.ts:168-210`); there is no retract-to-neutral, which reads as intended
  (comment in code: "Re-vote replaces the old direction").
- **ok** — Comments validate `parentId` against the same post
  (`server.ts` comment route), so cross-post reply grafting is rejected.
- **note** — Vote rate limit is 20 votes/60s per author (`ratelimit.ts:17`):
  generous for humans, tight for a scripted voter; fine for MVP.

## 7. Anything else

- **note** — Future-dated timestamps are accepted (up to +5 min); `createdAt`
  uses server time for posts/comments, so display order cannot be manipulated
  via the signed timestamp — good.
- **note** — Post ids are 128-bit `randomBytes` hex (`server.ts:39-41`):
  unguessable, collision-safe.
- **note** — `loadLoungeConfig` fails closed without `LOUNGE_TREASURY`
  (`config.ts:28-42`); fee amount validated as positive ≤6-decimal USDC.
  Treasury is checksummed at load (`config.ts:46`).
- **note** — If the DB file is ever wiped/replaced, the `used_payments` table
  goes with it and all historical tx hashes become reusable — an ops/backup
  consideration, not a code bug.
- **ok** — No secrets, key handling, or broadcast paths in the lounge code;
  receipt fetching is read-only (`payments.ts:36-52`).
