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

## Locked mint params (2026-09-24, founder)
- Price: TBD (set at deploy; was $10, redacted from all public copy).
- Per-wallet cap: 10 seats (recipient wallet).
- No whitelist / no allowlist. Pure public sequential mint.
- Team: 100 free claims via owner-only `teamMint(to, agentId)`; each
  recipient registers their own 8004 identity first so pairing is clean.
  402 Manager, Swappy seats come out of this allocation.
- Royalty: 5% ERC-2981 to treasury, ERC-721C from day one.
- Payment: USDC on Ink (`0x2D270e6886d130D724215A266106e6832161EAEd`).
- Token IDs 1..10000, sequential; baseURI
  `ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/`.
- `mint(to, agentId)` + `mintBatch(to, agentIds[])`; recipient must own each
  identity (`ownerOf(agentId) == to`); 1 seat per identity.

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
