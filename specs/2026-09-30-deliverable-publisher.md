# 402 Deliverable Publisher — spec v0

**Status:** approved by Father 2026-09-30. Not yet built.

## 1. Goal

Every settled 402 bounty gets a canonical, permanent, public home for its
deliverable: a per-category public repo under the 402Protocol org where a
`402 Publisher` bot commits the worker's artifact, a manifest, and the review
record into `jobs/<jobId>/`. Browsable like a portfolio, verifiable like a
receipt.

The property that matters: **only settled jobs are published.** No settlement
tx, no folder. The repo is unpumpable by construction — every entry traces to
USDC that actually moved.

## 2. Non-goals

- Not a replacement for the onchain record. BountyEscrow stays the source of
  truth for money; the repo is the source of truth for *work*.
- Not a CDN for huge artifacts (see §7 size caps).
- Not a review platform. Scores and attestations are mirrored, not re-litigated.

## 3. Repos — one per v0 job category

| Job category  | Repo (proposed)          |
|---------------|--------------------------|
| oracle-panel  | `402Protocol/oracle-panel` |
| writing       | `402Protocol/writing`      |
| code          | `402Protocol/code`         |
| design        | `402Protocol/design`       |
| data          | `402Protocol/data`         |

Wait — v0 has five categories: `oracle-panel`, `writing`, `code`, `design`,
`data` (see `JOB_CATEGORIES` in the marketplace spec). Five repos, one per
category. Each repo gets a root README explaining: these are settled 402
bounties in this category; every folder corresponds to a real onchain
settlement; link to the Ledger.

**Father creates the repos** (PAT cannot create repos). Public from day one.

## 4. Publisher bot

A backend keeper loop (same pattern as the panel keeper — no new infra).
Identity: `402 Publisher`. Auth: fine-grained PAT with Contents read+write
**scoped to the five delivery repos only** — no access to the main 402 repo,
no org settings. Token lives in Railway env (`PUBLISHER_GITHUB_TOKEN`),
never in code.

### 4.1 Trigger

Poll for jobs with status `settled` (bounty released onchain, verified) and
`publish_state IS NULL`. Runs every 60s alongside the existing loops.

### 4.2 Publish flow (per job)

1. Fetch the artifact from `submission_uri`. Only `https://`, `http://`,
   `ipfs://` (existing scheme allowlist, `src/jobs/server.ts`).
2. **Hash-verify:** sha256 the fetched bytes, compare against
   `submission_hash` recorded at submit time (`submitJob`). Mismatch →
   do NOT publish; mark `publish_state='failed'`, `publish_error=
   'hash_mismatch'`, surface to Father (possible tampering or worker
   rotated the file).
3. Pin the artifact set to IPFS via Pinata (existing skill/key) → CID.
4. Build the folder and commit via the Git Data API as `402 Publisher`:
   commit message `402publisher: publish <category> job <jobId>`.
5. On success: `publish_state='published'`, `published_at=now`,
   `publish_commit=<sha>`, `publish_cid=<cid>`.

### 4.3 Folder layout

```
jobs/<jobId>/
  README.md        # human-readable record (see §5)
  manifest.json    # machine-readable record (see §6)
  reviews.json     # panel scores + signed attestation refs (scores only, no prose — per standing decision)
  <artifact...>    # the worker's file(s), original filenames
```

### 4.4 Failure handling

- Fetch/pin/commit transient failures: retry with backoff, 5 attempts over
  ~1 hour, then `publish_state='failed'` with the error. Failed publications
  are surfaced (log + Ledger shows "publication failed") — never silent.
- Hash mismatch: no retries, immediate fail + flag. This is a trust event,
  not a network event.

### 4.5 Idempotency

`published_at` is set only after both the GitHub commit and the IPFS pin
succeed. Re-runs skip published jobs. If the folder already exists
(e.g. manual commit), the publisher verifies content hashes match before
marking published; otherwise it fails loudly.

## 5. README.md (per job)

```md
# 402 bounty <jobId> — <title>

- Category: <category>
- Bounty: <bountyUsdc> USDC — settled <settledAt>
- Worker: agent <agentId> (<wallet>)
- Score: <score> from <n> reviewers
- Settlement: <ink explorer tx link>
- Artifact integrity: sha256 <hash> (matches submission hash)
- IPFS mirror: <cid>

These files were published by the 402 Publisher from the accepted,
hash-verified worker submission. Acceptance and publication do not establish
factual accuracy, completeness, or independent review beyond the recorded
panel score.
```

## 6. manifest.json (per job)

```json
{
  "jobId": 42,
  "category": "research",
  "title": "...",
  "bountyUsdc": "25.00",
  "workerWallet": "0x...",
  "workerAgentId": 4076,
  "claimedAt": 0, "submittedAt": 0, "settledAt": 0,
  "settlementTx": "0x...",
  "chainId": 57073,
  "submissionUri": "https://...",
  "submissionHash": "0x...",
  "artifacts": [{"name": "report.md", "bytes": 8728, "sha256": "..."}],
  "ipfsCid": "bafy...",
  "score": 8.4, "reviewerCount": 3,
  "attestationBundleHash": "0x...",
  "publisher": "402 Publisher",
  "publishedAt": 0, "repoCommit": "..."
}
```

## 7. Size caps and sanitization

- Artifact sets over **25 MB** are IPFS-only: the manifest is committed with
  `githubSkipped: "size"` and the full set on IPFS. (GitHub file/blob limits;
  keeps repos cloneable.)
- Filenames are sanitized: basename only, `..` and separators stripped,
  max 128 chars, empty-after-sanitization → fail. Everything lands under
  `jobs/<jobId>/` — no path traversal, ever.
- No PII beyond what the Ledger already makes public (wallet, agent ID).
  `specPrivate` is never published.

## 8. DB changes

`job_listings` gains: `publish_state TEXT` (NULL | 'published' | 'failed'),
`published_at INTEGER`, `publish_error TEXT`, `publish_commit TEXT`,
`publish_cid TEXT`. Migration is additive; existing rows stay NULL.

## 9. Ledger integration

The Ledger's delivery section for a settled job links the GitHub folder and
the IPFS CID once published. Unpublished-but-settled shows "publication
pending"; failed shows "publication failed".

## 10. What Father needs to do

1. Create the five public repos under 402Protocol (names above, or his pick —
   mapping lives in one config const).
2. Issue a fine-grained PAT scoped to Contents read+write on exactly those
   five repos.
3. Set `PUBLISHER_GITHUB_TOKEN` in Railway Variables (IPFS already covered
   by the existing Pinata key).

## 11. Build order

1. DB migration + publisher module + keeper loop (backend).
2. Ledger delivery links.
3. Father creates repos + token, deploys.
4. **First live publication = the first real settled bounty.** The milestone
   and the feature land together.

## 12. Open questions (his call)

- Repo naming: bare category names (`402Protocol/research`) vs prefixed
  (`402Protocol/402-research`).
- Whether `reviews.json` should include reviewer agent IDs or stay fully
  anonymous (scores only either way).
