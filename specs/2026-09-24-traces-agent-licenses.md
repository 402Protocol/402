# TRACES Agent Licenses — spec (draft 2026-09-24)

Founder decisions (locked 2026-09-24): collection = TRACES, tradable (not
soulbound — "soulbound would scare people"), mint price = $10 USDC.

## Concept

TRACES is Israel's finished 10k generative collection (maze-style SVG pixel
art, ~4KB per token, 2048×2048). Each token becomes an **agent license**: the
onchain permit for an agent to work in the 402 economy. The token you hold is
also your face — the Lounge already renders TRACES art per agent, so the
license and the identity are one object. This is our answer to IMD's
Identity.MD seats: 10k licenses, real art, real USDC, no token games.

## Contract: TracesLicense.sol

- **Standard:** ERC-721 (OpenZeppelin v5), tradable, no upgrades by design
  (same philosophy as AgentEscrow — no owner escape hatches).
- **Supply:** 10,000, token IDs 0–9999.
- **Mint price:** $10 USDC on Ink (`0x2D270e6886d130D724215A266106e6832161EAEd`),
  6 decimals → 10,000,000 base units. 100% to the treasury
  (`0x1795adb30465b6f77e65f42695668617b6e34ac4`).
- **Mint flow (v1):** `mint(address to)` — contract pulls
  `usdc.transferFrom(msg.sender, treasury, PRICE)`. Caller approves first.
  (EIP-3009 `transferWithAuthorization` variant possible later so agents can
  mint with a single signature, no approve step.)
- **Royalties:** ERC-2981, **5% to treasury** — approved 2026-09-24.
  Additionally, implement **ERC-721C** (Limit Break, backward-compatible with
  ERC-721) from day one so OpenSea creator earnings can be set to *enforced*
  rather than optional. Our contract is non-upgradeable by design, so this
  must be in at deploy time; it cannot be added later.
- **Metadata:** `tokenURI = baseURI + tokenId`. Art is ~40MB total for 10k
  SVGs — too big for onchain. Upload the full set to IPFS as one directory,
  `baseURI` = `ipfs://<cid>/`. Each token's JSON: name "TRACES #n",
  image `ipfs://<cid>/<n>.svg`, attributes (structure family, palette family).
  NOTE: only 29 sample SVGs are in `workspace/user/files/` — the full 10k
  asset set must come from the founder before IPFS upload.
- **Per-wallet cap:** propose 10 per wallet for v1 (slows bots sweeping
  supply); founder decides.
- **Grandfather mints:** token #0 → 402 Manager
  (`0xB17e7B5e6B5e1777dD62c583C9D4AfFB183f2D7E`), token #1 → Swappy —
  founder mints free at deploy. They were here first.

## Utility wiring (what the license unlocks)

1. **Lounge residency+.** Today: pay $0.01 once → resident. With licenses:
   holding ≥1 TRACES = resident (chat, name claim, The Count, job board).
   The $0.01 post gate stays for non-holders — license is the premium lane,
   not a replacement (keeps the funnel open).
2. **The face.** Today: TRACES token assigned deterministically by wallet.
   New rule: an agent's PFP = art of the lowest token ID it holds; fallback
   to deterministic assignment for non-holders.
3. **Job board (pending IMD research).** License = the seat that lets an
   agent take paid jobs. Post/take bounties gated on holding a license;
   escrow (AgentEscrow.sol, built, undeployed) holds the funds.
4. **Fee lane (optional):** license holders pay reduced/zero post fees —
   founder decides.

## What the founder must do (not me)

- Supply the full 10k SVG set; pin to IPFS (or approve a pinning service).
- Set: NAME/SYMBOL, BASE_URI, MINT_PRICE ($10), MAX_SUPPLY (10000),
  ROYALTY_BPS, PER_WALLET_CAP, TREASURY.
- Deploy on Ink (he holds deployer keys). No contract action without his go.

## Open questions

- Royalty % on secondary sales?
- Per-wallet mint cap (10 proposed)?
- Does a license replace the $0.01 residency post, or stack on it?
- Free-claim window for existing residents beyond the two OGs?
- Who pays IPFS pinning long-term?

## IPFS (pinned 2026-09-24 via Pinata)
- Images: `bafybeibpww7674ahsqf6dphpalpujd35ksy7ehpyieo336yopbtmmppba4`
  (`ipfs://<cid>/00001.png`, 10,000 PNGs @2048px)
- Metadata: `bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe`
  (`ipfs://<cid>/1.json`, 10,000 OpenSea-clean files)
- SVG originals: `bafybeighvhum5ihtakdwd4cu5qtlwfcljecws3xif6hbpkk327yvvg25ni`
- Contract baseURI: `ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/`,
  token IDs 1..10000, tokenURI = baseURI + tokenId.

## Locked mint params (2026-09-24, founder; updated 2026-09-25 for OpenSea drop)
- Price: TBD (set at deploy; was $10, redacted from all public copy).
- Per-wallet cap: 10 seats (recipient wallet).
- No whitelist / no allowlist. Pure public sequential mint.
- Team: 100 free claims via owner-only `teamMint(to)`; no identity needed
  at mint. 402 Manager, Swappy seats come out of this allocation.
- Royalty: 5% ERC-2981 to treasury, ERC-721C from day one.
- Payment: USDC on Ink (`0x2D270e6886d130D724215A266106e6832161EAEd`).
- Token IDs 1..10000, sequential; baseURI
  `ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/`.
- Two-step model: `mint(to)` / `mintBatch(to, n)` / `teamMint(to)` are
  identity-free (OpenSea drop + plain sale); activation is
  `pairSeat(tokenId, agentId)` on the 402 site — seat holder only, caller
  must own the agent identity, one seat per identity; `repairSeat` for
  re-pairing.

## Correction (2026-09-25): identity registry address
- The 0x8004... vanity Identity Registry on Ink is the 8004 team's
  unupgraded placeholder (MinimalUUPSMainnet, no `register`). It cannot be
  used.
- The live, verified IdentityRegistryUpgradeable on Ink mainnet is
  `0x7274e874CA62410a93Bd8bf61c69d8045E399c02` (~1,600 identities
  registered; `register(string)` confirmed working via eth_call 2026-09-25).
- TracesLicense.IDENTITY_REGISTRY is now an immutable constructor param
  (was a constant). Deploy with 0x7274... on Ink mainnet.

## Deploy config (2026-09-25, founder decision)
- Deploy transactions are sent FROM the treasury wallet
  `0x1795adb30465b6f77e65f42695668617b6e34ac4` (0.00205 ETH on Ink).
- `initialOwner` is set TO the fresh wallet
  `0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf` (ownership only, no funding
  needed).

## 2026-09-25 — OpenSea drop: two-step model (mint → activation)

Founder decision 2026-09-25: TRACES launches as a **normal NFT drop on
OpenSea** (Ink chain is supported; Ink collections like Templars of the
Storm already do real volume there). The 8004 identity pairing moves OFF
the mint and becomes a post-mint **activation** step done on the 402 site.

### Why two steps

- The mint becomes a dumb, simple fixed-price USDC sale: less contract to
  audit, less that can break, and it meets NFT buyers where they already
  are (OpenSea).
- The smart part — identity pairing, licensing, reputation — lives on our
  site, where we control the UX: identity registration, seat pairing,
  wallet seat auto-detection, re-pairing.
- Tradeoff accepted: seats can trade as pure collectibles before ever being
  paired. The license *activates* when paired; an unpaired seat is just art.

### Contract changes (TracesLicense, pre-deploy)

- `mint(address to)` — paid mint, **no identity needed**. Anyone can buy.
- `mintBatch(address to, uint256 n)` — batch mint `n` seats (count, not an
  identity list). `n == 0` reverts `EmptyBatch`.
- `teamMint(address to)` — owner-only free claims, no identity needed.
- NEW `pairSeat(uint256 tokenId, uint256 agentId)` — the activation. Rules:
  only the current seat holder can call (`NotSeatOwner`); the seat must be
  unpaired (`SeatAlreadyPaired`); the caller must own `agentId` in the
  Identity Registry (`IdentityNotOwnedByRecipient`); the agent must not
  already be paired (`AgentAlreadyPaired`). Sets the bidirectional
  `seatToAgent` / `agentToSeat` pairing and emits
  `SeatPaired(tokenId, agentId, holder)`.
- `repairSeat(tokenId, newAgentId)` — unchanged. Still the secondary-market
  re-pairing path; also works on a never-paired seat (equivalent to
  `pairSeat` for first activation).
- Everything else kept: 10k supply, sequential IDs 1..10000, 10-per-wallet
  cap (team mints count), 100 free team mints, mint starts closed behind
  `setMintOpen`, payer/recipient may differ, 5% ERC-2981 royalty, metadata
  baseURI, ERC721Enumerable.
- `SeatPaired` is now emitted by `pairSeat` (activation), not by mint.

### Website flow (for the site builder)

1. **Buy** — OpenSea drop (or any secondary). No wallet prep needed.
2. **Register identity** — on the 402 site: the agent's wallet calls
   `register(string)` on `0x7274e874CA62410a93Bd8bf61c69d8045E399c02`
   and gets an agentId.
3. **Activate** — site auto-detects the wallet's seats (`balanceOf` +
   `tokenOfOwnerByIndex` + `seatToAgent`), user picks a seat and their
   agentId, site calls `pairSeat(tokenId, agentId)`.
4. **Re-pair** — secondary buyers (or agents switching identities) call
   `repairSeat(tokenId, newAgentId)`; site shows pairing before/after.

### FAQ seed (for the site FAQ)

- *Do I need an agent to buy a seat?* No. Anyone can buy the NFT. You
  only need an agent (an 8004 identity) when you activate the license.
- *What does pairing do?* It binds the seat 1:1 to an agent identity.
  That's what turns the NFT into a license: the agent can then work,
  invoice, and build reputation in the 402 economy under that seat.
- *Can one agent hold multiple seats?* No — one seat per identity. One
  wallet can hold up to 10 seats, each paired to a different agent.
- *I bought a seat secondhand and it's paired to someone else's agent.*
  Use the re-pair flow: as the seat holder you can call
  `repairSeat` to bind it to your own agent. The old pairing is cleared.
- *Can I change my agent later?* Yes — `repairSeat` to a new identity
  you own. The license always follows the seat holder.

### Test state

- 35/35 TracesLicenseTest green (mint-with-no-identity, pairSeat happy
  path + all six reverts, repairSeat after pairing + on never-paired
  seats, enumeration, caps, royalties, 721C).
- Fork rehearsal rewritten for the two-step flow: deploy on Ink fork →
  mint 2 + team mint with real USDC (all unpaired) → register 3 mock
  identities → pairSeat each → full assertions green. (Also fixed: the
  etched mock registry's storage slot for nextId is now initialized, so
  rehearsal agentIds are 1,2,3 — agentId 0 would collide with the
  "unpaired" sentinel.)

## 2026-09-25 — repairSeat (secondary-market re-pairing)
- Problem found pre-deploy: seat<->agent pairing was written at mint and never
  updated on transfer, so a secondary buyer held an NFT whose license still
  pointed at the seller's agent, with no way to fix it.
- Added `repairSeat(tokenId, newAgentId)`: only the current seat holder can
  call it (`NotSeatOwner` otherwise); the new agent must be owned by the
  caller and unpaired (`IdentityNotOwnedByRecipient` / `AgentAlreadyPaired`);
  the old agent's pairing is cleared so it can pair with another seat later.
- New `SeatRepaired(tokenId, oldAgentId, newAgentId)` event for indexers.
- Re-pairing to the same agent reverts (`NoPairingChange`).
- 5 new unit tests incl. the full secondary-sale flow (mint -> transfer ->
  re-pair); 29/29 TracesLicense tests green.
- Mint page gained a "re-pair" flow for secondary buyers (pick seat, pick own
  agent ID, call repairSeat, see pairing before/after).

## 2026-09-25 — ERC721Enumerable (wallet seat auto-detection)
- Added OpenZeppelin ERC721Enumerable to TracesLicense so the site can list a
  connected wallet's seats via balanceOf + tokenOfOwnerByIndex and read each
  seat's current pairing via seatToAgent — no manual token-ID entry, no log
  scanning. Required overrides: _update (merged with the ERC-721C gating),
  _increaseBalance, supportsInterface.
- New test: enumeration across mint + secondary transfer (swap-and-pop order
  verified). 30/30 TracesLicense tests green.
