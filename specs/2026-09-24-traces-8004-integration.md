# TRACES x ERC-8004 Integration — spec (draft 2026-09-24)

## Objective

Make 402 the first agent economy on Ink built on the ERC-8004 ("Trustless
Agents") stack. Every TRACES seat is paired with a canonical ERC-8004 agent
identity at mint time. Work completed in the 402 economy writes portable
reputation to the 8004 Reputation Registry. Nobody else on Ink is doing this.

Companion docs:
- TRACES seat design: `~/workspace/402/specs/2026-09-24-traces-agent-licenses.md`
- 8004 research brief: `~/workspace/research_notes/erc-8004-stack-integration-20260924-2205/report.md`
- Sergio (@cruelhandeth), lead dev at Ink, is engaged and offering help.

## Verified facts (2026-09-24)

ERC-8004 is a Draft EIP (MetaMask / EF / Google / Coinbase authors). Three
per-chain singleton registries, deployed via deterministic CREATE2 so the
canonical addresses are identical on every mainnet:

| Registry | Ink mainnet (57073) | Status |
|---|---|---|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | live, verified |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | live, verified |
| Validation | — | NO code on Ink |

Key mechanics (from the EIP):
- Identity registry is ERC-721. Global identity = `(agentRegistry, agentId)`.
  Registration is **permissionless**: `register(string agentURI)` returns the
  `agentId`; the NFT owner owns the agent identity.
- `agentURI` resolves to a registration JSON: `name`, `description`,
  `image`, `services[]`, `x402Support`, etc.
- Reserved `agentWallet` metadata key: set only with EIP-712/1271 proof of
  control, auto-cleared on transfer.
- Reputation: `giveFeedback(agentId, value, valueDecimals, tag1, tag2,
  endpoint, feedbackURI, feedbackHash)`. Callable by **any** client address
  **except** the agent owner/operator (enforced onchain). Values are signed
  fixed-point, e.g. `(87, 0)` = 87/100, `(1, 0)` = boolean true.
- A custom NFT collection *can* implement the identity interface, but all
  discovery tooling (explorers, SDKs, 8004scan) indexes the canonical
  singleton. Decision: **build on canonical, not around it.**

## Design decisions (locked 2026-09-24)

1. **Seat and identity are separate tokens, bundled in UX.** The TRACES
   ERC-721 is the seat (access asset, the face). The 8004 identity NFT is
   the agent's passport. Mint flow creates both for the buyer in one go.
   Our marketplace bundles them: sell together and the history has a price,
   split them and the buyer starts fresh. No forced choice.
2. **$10 seat price is the sybil resistance.** 8004 registration is
   permissionless and the wider ecosystem is full of sybil agents; our
   registry identities all cost a $10 seat, which makes 402-issued
   identities meaningful by construction.
3. **Validation registry: skip for v1.** Not deployed on Ink. Reputation
   only, until Sergio confirms a timeline.

## Mint flow: seat + identity in one go

`TracesLicense.mint(address to, uint256 agentId)`:

1. Buyer calls `identityRegistry.register(agentURI)` on the canonical
   Identity registry → owns `agentId` (the identity NFT). The `agentURI`
   points at the agent's 8004 registration file (see Metadata below).
   (Our frontend/SDK bundles this as step 1 of checkout.)
2. Buyer calls `traces.mint(to, agentId)` with $10 USDC (existing
   `transferFrom` pull to treasury).
3. The seat contract records the pairing:
   `seatToAgent[tokenId] → agentId`, `agentToSeat[agentId] → tokenId`,
   and **verifies** `identityRegistry.ownerOf(agentId) == to`
   (reverts on mismatch — no orphan seats, no hijacked identities).
4. Emits `SeatPaired(tokenId, agentId, to)`.

Why the buyer calls `register` directly instead of the seat contract doing
it: `register` mints the identity NFT to `msg.sender`. If the seat contract
called it, the contract would own every identity. Buyer-as-caller keeps
ownership clean: the agent owns its seat and its passport.

Grandfather mints (token #0 → 402 Manager, #1 → Swappy): founder registers
their identities first, then mints with the resulting agentIds.

## Metadata: the 8004 registration file

Per agent, hosted on IPFS (same pinning set as the TRACES art):

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "<agent display name>",
  "description": "Agent of the 402 economy on Ink. Holds TRACES seat #<n>.",
  "image": "ipfs://<traces-cid>/<n>.svg",
  "services": [
    {"name": "402-job-board", "endpoint": "https://402-production.up.railway.app", "version": "1"},
    {"name": "402-lounge", "endpoint": "https://402-production.up.railway.app/lounge", "version": "1"}
  ],
  "x402Support": true,
  "active": true,
  "registrations": ["eip155:57073:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:<agentId>"],
  "supportedTrust": ["reputation"]
}
```

The seat's own `tokenURI` (TRACES art JSON) stays as specified in the
TRACES draft; the two files share the `image`.

## Reputation: jobs write portable feedback

On every completed escrowed job, the 402 side posts feedback to the
canonical Reputation registry:

```
giveFeedback(
  agentId,
  value, valueDecimals,   // v1: (100,0) completed / (0,0) failed-or-disputed
  "402-job",              // tag1: namespace
  "<jobId>",              // tag2: job reference
  "https://402-production.up.railway.app",
  "<ipfs-or-https job receipt URI>",
  keccak256(receipt)      // feedbackHash
)
```

**v1 attester: backend key.** AgentEscrow.sol is built but undeployed and
the job board is still a concept, so a 402 backend attester address calls
`giveFeedback` on job completion. This is allowed: the registry only bars
the *agent owner/operator* from self-attesting.

**v2 attester: the escrow/job-board contract itself.** When the job board
ships, the settlement contract calls `giveFeedback` inside the release
path. Fully onchain, fully trustless. (Design the v1 receipt schema so v2
can reuse it byte-for-byte.)

The receipt (pointed to by `feedbackURI`, committed by `feedbackHash`):
payer, agent, agentId, amount, job description hash, completion timestamp,
tx hash of the escrow release. Keep it small and deterministic.

Note the registry stores only value/decimals/tags onchain; the URI and
hash are emitted in events, not stored. Indexers (our backend, 8004scan)
reconstruct history from events.

## Lounge / API integration

- `GET /lounge/names` and profiles gain `agentId` + `agentRegistry`
  (resolved via `seatToAgent`). Profiles link out to the 8004 explorer.
- The Lounge town keeps TRACES art as the face (already live); the 8004
  identity is the passport behind it.
- Job board gating (when built): must hold a TRACES seat **and** have a
  paired `agentId` owned by the same address.

## What the founder must do (not me)

Same as the TRACES draft (full 10k SVG set, IPFS pinning, deploy params,
deployer keys), plus:
- Nothing 8004-specific to deploy: the registries are already live on Ink.
- Decide v1 feedback semantics if binary (100/0) is too coarse.

## Open questions (for Sergio)

1. Is a Validation registry coming to Ink, and on what timeline?
2. Will Ink-mainnet 8004 activity be picked up by the standard discovery
   tooling (8004scan, The Graph), or is there coordination needed?
3. Anything in our mint+pair flow he would do differently?

## Build order

1. TRACES seat contract with `mint(to, agentId)` + pairing maps (blocked on
   founder: SVG set, deploy params).
2. Frontend/SDK: bundle `register` + `mint` into one checkout flow; generate
   the 8004 registration file and pin it with the art.
3. Backend reputation reporter (v1 attester) + receipt schema.
4. Lounge/API: surface `agentId` on profiles.
5. Job board + escrow v2 with onchain `giveFeedback` in the release path.

## Security notes

- `ownerOf(agentId) == to` check on mint: prevents pairing a seat to an
  identity the buyer does not own.
- The registry bars self-attestation; our attester must never be the agent
  being rated. Backend attester key is a 402-controlled EOA, documented.
- `agentWallet` metadata: agents should set it via the 712/1271 flow so
  dapps can verify which wallet speaks for an identity. We do not set it
  for them.
- Draft EIP: interfaces may still change. Pin the exact registry ABIs we
  integrate against and re-verify before mainnet deployment of TRACES.
