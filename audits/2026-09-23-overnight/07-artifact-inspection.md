# 07 — 402-website artifact: Lounge feed integration check
**Workstream 7 · overnight read-only audit · 2026-09-23 ~01:45 EDT (05:45 UTC)**
Diagnosis only. No repairs authorized, none made; nothing changed.

## Method note (read this first)
The `artifact.inspect` tool is **not available in this subagent's toolset** (no `artifact.*` namespace exists here), so the verbatim request could not be executed through it. Instead, this inspection was performed read-only against the artifact's source at `~/workspace/ts-spaces/402-website/index.html` (single self-contained `index.html`; per that directory's AGENTS.md, nothing was edited and no build was run), plus live read-only probes of the Lounge API. A parent agent with `artifact.inspect` may re-run the verbatim request; the findings below are the source-level equivalent.

## Which API endpoints the Lounge calls
Base URL (hard-coded, line 902): `https://402-production.up.railway.app`. All calls are direct visitor-browser → Railway `fetch()` with default options (no credentials/cookies). Wrapper `request()` sets `accept: application/json` and adds `content-type: application/json` when a body is present.

| # | Method + path | Called when | Notes |
|---|---|---|---|
| 1 | `GET /lounge/health` | App boot (`init()`). `ok !== true` is treated as failure. | Gates `state.connected`. |
| 2 | `GET /lounge/posts?sort=<hot\|new\|top>&limit=25[&cursor=...]` | Feed load, sort-tab click, "Load more". | Cursor pagination; "Load more" hidden when `nextCursor` is empty. |
| 3 | `GET /lounge/posts/:id` | Opening a post (title or "N comments" click). | Returns post + comments thread. |
| 4 | `POST /lounge/posts` | Publish post. Body: `{author,title,body,timestamp,signature,paymentTxHash}` | EIP-712 `LoungePost` (domain `402 Lounge`, v1, chain 57073) signed via `window.ethereum` + onchain $0.01 USDC payment tx hash. |
| 5 | `POST /lounge/posts/:id/vote` | Upvote/downvote. Body: `{author,direction,timestamp,signature}` | EIP-712 `LoungeVote`. |
| 6 | `POST /lounge/posts/:id/comments` | Submit comment. Body: `{author,body,timestamp,parentId:'',signature}` | EIP-712 `LoungeComment`. |

Not an API call: "Tip 0.01 USDC" is fully client-side — it builds a `402-tip-invoice/v1` JSON (recipient = post author, 10000 base units = $0.01 USDC) for copy/download only. Wallet (`window.ethereum`, `eth_requestAccounts`, switch to Ink `0xdef1`) is required only for posting/voting/commenting — viewing the feed needs no wallet.

## How connection errors are handled and displayed
- `request()` throws on `!response.ok` with the server's `{"error": "..."}` message verbatim (verified error shape live: `POST /lounge/posts` with bad JSON → `400 {"error":"invalid_json"}`), falling back to `Lounge request failed (HTTP <status>)`. Network-level failures (DNS/TLS/refused) surface as the native fetch `TypeError`.
- **Boot (`init`) and feed load (`loadPosts`) failure → `connectionFailed()`**: sets `state.connected=false`, status pill reads "Lounge API not connected yet", and the offline panel is shown with the text "The Lounge endpoint could not be reached. Try again once the service is online." Feed/compose/detail views are hidden. This is the only place a full disconnect state is rendered.
- **Vote / openPost failures**: only the status pill text updates (`setStatus(error.message,'idle')`); the feed stays visible (fail-soft).
- **Compose / comment failures**: error message shown inline under the form (`post-message` / `comment-message`); user input is preserved.
- **Empty-but-connected feed**: distinct "No posts yet" empty state reading "The feed is connected and empty", so connected-empty is distinguishable from disconnected.
- Success status pill: "Lounge online · Ink 57073".
- **No retry logic**: single attempt per call, no backoff. There is no explicit "Retry" button on the offline panel — the user retries implicitly by clicking a sort tab or "Load more". Minor UX gap, not a reliability defect.

## Reliability verdict: the old "policy-deny" claim is CONTRADICTED
Evidence collected in this inspection:

1. **CORS is correctly configured and verified live** (re-verified 2026-09-23 ~05:45 UTC, consistent with workstream 3's probe at 01:45 UTC):
   - `OPTIONS /lounge/posts` preflight with `Origin: https://example.com` → `204`, `access-control-allow-origin: *`, `access-control-allow-methods: GET,POST,OPTIONS`, `access-control-allow-headers: content-type`.
   - `GET /lounge/health` → `200 {"ok":true}` with `access-control-allow-origin: *`.
   - `GET /lounge/posts?sort=new&limit=1` → `200` returning the real first post (`hello from the machine that built this`).
2. **The fetch pattern is browser-legal**: reads are simple CORS requests (no preflight needed); writes use `content-type: application/json`, exactly what the preflight allows. No credentials mode is used, so the wildcard `*` origin is honored by browsers. Nothing in the code requires anything the CORS policy withholds.
3. **The defect the old claim attributed to webview policy predates the CORS fix**: the old inspection ran when the API had *no* CORS middleware at all — at that point the feed could not load from *any* browser, not just the Muse webview. Per project memory, that inspection was done from the builder environment; builder-environment network findings are already on record as not representative of the real client (they previously contradicted the working feed on the founder's device).
4. **End-to-end confirmation on real hardware**: the feed demonstrably loads on the founder's device (screenshot of a live post in the feed; founder's X account posted about the first agent post). That is direct evidence the direct browser→Railway path works in the field.

**Verdict**: the "Muse webview policy-denies the Railway connection" claim is not supported and is contradicted by the evidence. The root cause of the earlier failure was missing CORS headers, which have since been added and verified. **No server-backed rebuild of the site is warranted on these grounds.**

## Caveats and honest limits
- This subagent cannot operate a live browser, so it cannot personally re-run the webview test; the verdict rests on source inspection + live header/response verification + the recorded founder-device evidence.
- Residual, expected limitation: write actions (post/vote/comment) require `window.ethereum` with an Ink wallet — the Muse webview may not inject one, so full interaction needs a real browser. Viewing is wallet-free and unaffected.
- Minor gap noted (not blocking): no retry/backoff and no explicit retry button on the offline panel.

## Recommended follow-ups (not done — read-only task)
1. Optional: add a "Retry" button to the offline panel calling `init()`/`loadPosts(false)` — trivial UX win.
2. Optional: if any webview user reports blocked writes, the fallback is unchanged code — the writes need a wallet, not a different architecture.
