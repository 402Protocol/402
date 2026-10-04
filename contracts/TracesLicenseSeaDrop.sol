// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ICreatorToken} from "@creator-token-standards/interfaces/ICreatorToken.sol";
import {ICreatorTokenLegacy} from "@creator-token-standards/interfaces/ICreatorTokenLegacy.sol";
import {ERC721CCompat} from "./ERC721CCompat.sol";
import {ERC8048} from "./ERC8048.sol";
import {INonFungibleSeaDropToken} from "./seadrop/INonFungibleSeaDropToken.sol";
import {ISeaDropTokenContractMetadata} from "./seadrop/ISeaDropTokenContractMetadata.sol";
import {ISeaDropConfig} from "./seadrop/ISeaDropConfig.sol";
import {
    PublicDrop,
    AllowListData,
    TokenGatedDropStage,
    SignedMintValidationParams
} from "./seadrop/SeaDropStructs.sol";

/// @notice Minimal view of the canonical ERC-8004 Identity Registry (ERC-721).
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice Minimal view of an ERC-8217 agent-binding adapter (e.g. Adapter8004).
///         The adapter permanently owns the ERC-8004 identity NFTs it mints;
///         whoever holds the bound token controls the agent through it.
///         `standard` is the adapter's TokenStandard enum (0 = ERC721).
interface IAgentBindingAdapter {
    function register(uint8 standard, address tokenContract, uint256 tokenId, string calldata agentURI)
        external
        returns (uint256 agentId);
    function bindingOf(uint256 agentId)
        external
        view
        returns (uint8 standard, address tokenContract, uint256 tokenId);
}

/// @title TracesLicenseSeaDrop
/// @notice TRACES: 10,000 agent seat licenses on Ink, sold as a normal
///         OpenSea (SeaDrop) drop. THIS contract owns no sale logic at all —
///         OpenSea/SeaDrop owns allowlist stages, public stages, ETH prices,
///         windows, and wallet limits. This contract owns only the license:
///         each seat becomes a worker license when paired 1:1 with a
///         canonical ERC-8004 agent identity via pairSeat.
///
///         Drop configuration (public drop, allowlist merkle root, creator
///         payout address, drop URI) is set owner-side through the SeaDrop
///         forwarder functions below, which the canonical SeaDrop contract
///         only accepts from a token implementing INonFungibleSeaDropToken.
///
///         Whitelist: Quotrons terminal-NFT holders, 1:1 per terminal. The
///         allowlist merkle tree is built from a SURPRISE snapshot of
///         Robinhood Chain at a past block — never announced in advance —
///         with each holder's leaf binding their terminal count as their
///         personal mint cap (SeaDrop leaf = keccak256(abi.encode(minter,
///         mintParams)), so per-wallet caps are native).
///
///         License integrity: pairings auto-clear when a seat transfers, so
///         the license always follows the token holder. pairSeat/repairSeat
///         share a 72h per-seat cooldown (first pairing free) so one seat
///         cannot be rotated across unlimited agents to multiplex licenses.
///         Job-board integrations MUST additionally check that the same
///         wallet owns both the seat and the agent identity
///         (agentToSeat != 0 alone is not sufficient — agent identities are
///         transferable ERC-721s), and MUST account active jobs per seat,
///         not per agent.
/// @dev Non-upgradeable by design (same posture as AgentEscrow).
///      ERC-721C-compatible transfer gating via ERC721CCompat (see its docs
///      for why the Limit Break contracts are not inherited directly).
contract TracesLicenseSeaDrop is
    ERC721,
    ERC721Enumerable,
    ERC2981,
    Ownable,
    ReentrancyGuard,
    ERC721CCompat,
    ERC8048,
    INonFungibleSeaDropToken
{
    using Strings for uint256;

    // ------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------

    /// @notice Total seat supply. Token IDs run 1..maxSupply, strictly sequential.
    uint256 public constant INITIAL_MAX_SUPPLY = 10_000;
    /// @notice Cooldown between pairing actions (pairSeat/repairSeat) on the
    ///         same seat. First pairing is free. Kills license multiplexing
    ///         (one seat serially licensing N agents via pair -> transfer ->
    ///         pair rotation) while staying invisible to legitimate buyers,
    ///         who pair once after the transfer auto-clear.
    uint256 public constant PAIR_COOLDOWN = 72 hours;

    /// @notice ERC-8004 Identity Registry seats pair against.
    /// @dev Immutable, set at deploy. On Ink mainnet this is
    ///      0x7274e874CA62410a93Bd8bf61c69d8045E399c02 (the live
    ///      IdentityRegistryUpgradeable) — NOT the 0x8004... vanity address,
    ///      which is still the 8004 team's unupgraded placeholder.
    IIdentityRegistry public immutable IDENTITY_REGISTRY;

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error MaxSupplyReached();
    error IdentityNotOwnedByRecipient();
    error AgentAlreadyPaired();
    error SeatAlreadyPaired();
    error EmptyBatch();
    error ZeroAddress();
    error NotSeatOwner();
    error NoPairingChange();
    error PairCooldown();
    error RegistryNotContract();
    error MintQuantityExceedsMaxSupply(uint256 requested, uint256 maxSupply);
    error NotAgentOwner();
    error MaxSupplyExceedsCeiling(uint256 requested, uint256 ceiling);
    error SeatNotPaired();
    error PairingNotStale();
    error AgentAdapterNotSet();
    error AgentAdapterAlreadySet(address current);
    error AgentsAfterFirstMint();
    error AgentIdsOutOfRange(uint256 first, uint256 last);

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event SeatPaired(uint256 indexed tokenId, uint256 indexed agentId, address indexed to);
    event SeatRepaired(uint256 indexed tokenId, uint256 indexed oldAgentId, uint256 indexed newAgentId);
    /// @notice Emitted when a seat transfer auto-clears its pairing. The
    ///         license follows the token: the seller's agent is unpaired and
    ///         the buyer's seat arrives clean.
    event SeatUnpaired(uint256 indexed tokenId, uint256 indexed agentId);
    /// @notice Emitted when the owner sets the ERC-8217 binding adapter.
    event AgentAdapterSet(address indexed adapter);
    /// @notice Emitted for each tokenId registered with the binding adapter.
    event AgentRegistered(uint256 indexed tokenId, uint256 indexed agentId);

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------

    /// @notice Next token ID to mint. Starts at 1 (matches metadata numbering).
    uint256 public nextTokenId = 1;
    /// @notice Max token supply (SeaDrop metadata). Initialized to
    ///         INITIAL_MAX_SUPPLY; owner-adjustable via setMaxSupply.
    uint256 internal _maxSupply;
    /// @notice Provenance hash (SeaDrop metadata; unset by default).
    bytes32 internal _provenanceHash;
    /// @notice Contract-level metadata URI for marketplaces.
    string internal _contractURI;
    /// @notice Royalty receiver mirror (kept in sync with ERC-2981).
    address internal _royaltyReceiver;
    /// @notice Royalty bps mirror (kept in sync with ERC-2981).
    uint96 internal _royaltyBps;

    /// @notice Hard ceiling for maxSupply: the collection is 10,000 seats,
    ///         fixed. setMaxSupply can only lower the cap, never raise it
    ///         above this (owner decision 2026-09-28).
    uint256 public constant MAX_SUPPLY_CEILING = 10_000;

    /// @notice SeaDrop contracts allowed to call mintSeaDrop.
    mapping(address => bool) internal _allowedSeaDrop;
    /// @notice Enumeration of allowed SeaDrop contracts.
    address[] internal _enumeratedAllowedSeaDrop;
    /// @notice Total ever minted per wallet VIA SeaDrop (for getMintStats).
    ///         Tracked separately from balanceOf so transfers don't reset a
    ///         wallet's drop-stage cap — matches ERC721A _numberMinted
    ///         semantics that SeaDrop's per-wallet enforcement expects.
    mapping(address => uint256) internal _seaDropMinted;

    /// @notice seat tokenId => paired ERC-8004 agentId (0 = unpaired).
    mapping(uint256 => uint256) public seatToAgent;
    /// @notice ERC-8004 agentId => seat tokenId (0 = unpaired; one seat per identity).
    mapping(uint256 => uint256) public agentToSeat;
    /// @notice seat tokenId => timestamp of the last pairSeat/repairSeat.
    ///         Not reset on transfer (by design — resets are gameable via
    ///         self-transfer).
    mapping(uint256 => uint256) public lastPairAt;

    /// @notice ERC-8217 binding adapter. Set once by the owner before any
    ///         mint; immutable afterwards. The adapter mints and permanently
    ///         owns one ERC-8004 identity per registered tokenId — holders
    ///         control (not own) the identity through it.
    address public agentAdapter;
    /// @notice seat tokenId => bound ERC-8004 agentId + 1 (0 = not registered).
    ///         Written by registerAgents, pre-mint only.
    mapping(uint256 => uint256) internal _agentPlusOne;

    string private _baseTokenURI;

    // ------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address identityRegistry_,
        address[] memory allowedSeaDrop_,
        string memory baseURI_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) ERC721("TRACES", "TRACES") Ownable(initialOwner) {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        if (identityRegistry_.code.length == 0) revert RegistryNotContract();
        IDENTITY_REGISTRY = IIdentityRegistry(identityRegistry_);
        _updateAllowedSeaDrop(allowedSeaDrop_);
        _maxSupply = INITIAL_MAX_SUPPLY;
        _baseTokenURI = baseURI_;
        _setRoyaltyInfo(royaltyReceiver_, royaltyBps_);
        emit TransferValidatorUpdated(address(0), DEFAULT_TRANSFER_VALIDATOR);
    }

    // ------------------------------------------------------------------------
    // SeaDrop: minting (the ONLY public mint path; SeaDrop owns the sale)
    // ------------------------------------------------------------------------

    /**
     * @notice Mint `quantity` seats to `minter`. Callable ONLY by an allowed
     *         SeaDrop contract — all sale logic (allowlist/public stages,
     *         prices, windows, wallet caps) lives in SeaDrop's configuration,
     *         set via the forwarder functions below.
     * @dev State (nextTokenId) is bumped BEFORE _safeMint so SeaDrop's
     *      getMintStats reads are correct even if a malicious receiver
     *      reenters (additionally guarded by nonReentrant).
     */
    function mintSeaDrop(address minter, uint256 quantity)
        external
        override
        nonReentrant
    {
        _onlyAllowedSeaDrop(msg.sender);
        if (quantity == 0) revert EmptyBatch();
        uint256 firstId = nextTokenId;
        uint256 lastId = firstId + quantity - 1;
        if (lastId > _maxSupply) {
            revert MintQuantityExceedsMaxSupply(firstId + quantity - 1, _maxSupply);
        }
        nextTokenId = lastId + 1;
        _seaDropMinted[minter] += quantity;
        for (uint256 i = 0; i < quantity; ++i) {
            uint256 tokenId = firstId + i;
            _safeMint(minter, tokenId);
            // Mint = identity: a token with a pre-registered bound agent is
            // born paired to it, so the seat license works with zero holder
            // action. Tokens without a registered agent keep the legacy
            // behavior (unpaired; pairSeat with a self-owned agent).
            uint256 agentPlusOne = _agentPlusOne[tokenId];
            if (agentPlusOne != 0) {
                uint256 agentId = agentPlusOne - 1;
                seatToAgent[tokenId] = agentId;
                agentToSeat[agentId] = tokenId;
                emit SeatPaired(tokenId, agentId, minter);
            }
        }
    }

    /**
     * @notice Mint stats SeaDrop uses to enforce maxSupply,
     *         maxTotalMintableByWallet, and maxTokenSupplyForStage.
     */
    function getMintStats(address minter)
        external
        view
        override
        returns (
            uint256 minterNumMinted,
            uint256 currentTotalSupply,
            uint256 maxSupply_
        )
    {
        minterNumMinted = _seaDropMinted[minter];
        currentTotalSupply = totalSupply();
        maxSupply_ = _maxSupply;
    }

    // ------------------------------------------------------------------------
    // SeaDrop: drop configuration forwarders (owner-only)
    // ------------------------------------------------------------------------

    function _onlyAllowedSeaDrop(address seaDrop) internal view {
        if (!_allowedSeaDrop[seaDrop]) revert OnlyAllowedSeaDrop();
    }

    function _checkAllowedSeaDropImpl(address seaDropImpl) internal view {
        _onlyAllowedSeaDrop(seaDropImpl);
    }

    function updateAllowedSeaDrop(address[] calldata allowedSeaDrop)
        external
        override
        onlyOwner
    {
        _updateAllowedSeaDrop(allowedSeaDrop);
    }

    function _updateAllowedSeaDrop(address[] memory allowedSeaDrop) internal {
        uint256 prevLen = _enumeratedAllowedSeaDrop.length;
        for (uint256 i = 0; i < prevLen; ) {
            _allowedSeaDrop[_enumeratedAllowedSeaDrop[i]] = false;
            unchecked { ++i; }
        }
        uint256 len = allowedSeaDrop.length;
        for (uint256 i = 0; i < len; ) {
            _allowedSeaDrop[allowedSeaDrop[i]] = true;
            unchecked { ++i; }
        }
        _enumeratedAllowedSeaDrop = allowedSeaDrop;
        emit AllowedSeaDropUpdated(allowedSeaDrop);
    }

    /// @notice The allowed SeaDrop contract addresses.
    function getAllowedSeaDrop() external view returns (address[] memory) {
        return _enumeratedAllowedSeaDrop;
    }

    function updatePublicDrop(address seaDropImpl, PublicDrop calldata publicDrop)
        external
        override
        onlyOwner
    {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updatePublicDrop(publicDrop);
    }

    function updateAllowList(address seaDropImpl, AllowListData calldata allowListData)
        external
        override
        onlyOwner
    {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updateAllowList(allowListData);
    }

    function updateTokenGatedDrop(
        address seaDropImpl,
        address allowedNftToken,
        TokenGatedDropStage calldata dropStage
    ) external override onlyOwner {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updateTokenGatedDrop(allowedNftToken, dropStage);
    }

    function updateDropURI(address seaDropImpl, string calldata dropURI)
        external
        override
        onlyOwner
    {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updateDropURI(dropURI);
    }

    function updateCreatorPayoutAddress(address seaDropImpl, address payoutAddress)
        external
        override
        onlyOwner
    {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updateCreatorPayoutAddress(payoutAddress);
    }

    function updateAllowedFeeRecipient(
        address seaDropImpl,
        address feeRecipient,
        bool allowed
    ) external override onlyOwner {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updateAllowedFeeRecipient(feeRecipient, allowed);
    }

    function updateSignedMintValidationParams(
        address seaDropImpl,
        address signer,
        SignedMintValidationParams memory signedMintValidationParams
    ) external override onlyOwner {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updateSignedMintValidationParams(
            signer,
            signedMintValidationParams
        );
    }

    function updatePayer(
        address seaDropImpl,
        address payer,
        bool allowed
    ) external override onlyOwner {
        _checkAllowedSeaDropImpl(seaDropImpl);
        ISeaDropConfig(seaDropImpl).updatePayer(payer, allowed);
    }

    // ------------------------------------------------------------------------
    // SeaDrop: token contract metadata (ISeaDropTokenContractMetadata)
    // ------------------------------------------------------------------------

    function setBaseURI(string calldata newBaseURI) external override onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BatchMetadataUpdate(1, totalSupply());
    }

    function baseURI() external view override returns (string memory) {
        return _baseTokenURI;
    }

    function setContractURI(string calldata newContractURI)
        external
        override
        onlyOwner
    {
        _contractURI = newContractURI;
        emit ContractURIUpdated(newContractURI);
    }

    function contractURI() external view override returns (string memory) {
        return _contractURI;
    }

    function setMaxSupply(uint256 newMaxSupply) external override onlyOwner {
        uint256 minted = totalSupply();
        if (newMaxSupply < minted) {
            revert NewMaxSupplyCannotBeLessThenTotalMinted(newMaxSupply, minted);
        }
        if (newMaxSupply > MAX_SUPPLY_CEILING) {
            revert MaxSupplyExceedsCeiling(newMaxSupply, MAX_SUPPLY_CEILING);
        }
        _maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(newMaxSupply);
    }

    function maxSupply() external view override returns (uint256) {
        return _maxSupply;
    }

    function setProvenanceHash(bytes32 newProvenanceHash)
        external
        override
        onlyOwner
    {
        if (totalSupply() != 0) revert ProvenanceHashCannotBeSetAfterMintStarted();
        bytes32 prev = _provenanceHash;
        _provenanceHash = newProvenanceHash;
        emit ProvenanceHashUpdated(prev, newProvenanceHash);
    }

    function provenanceHash() external view override returns (bytes32) {
        return _provenanceHash;
    }

    function setRoyaltyInfo(ERC2981.RoyaltyInfo calldata newInfo)
        external
        override
        onlyOwner
    {
        _setRoyaltyInfo(newInfo.receiver, newInfo.royaltyFraction);
    }

    function royaltyAddress() external view override returns (address) {
        return _royaltyReceiver;
    }

    function royaltyBasisPoints() external view override returns (uint256) {
        return _royaltyBps;
    }

    function _setRoyaltyInfo(address receiver, uint96 bps) internal {
        if (receiver == address(0)) revert RoyaltyAddressCannotBeZeroAddress();
        if (bps > 10_000) revert InvalidRoyaltyBasisPoints(bps);
        _royaltyReceiver = receiver;
        _royaltyBps = bps;
        _setDefaultRoyalty(receiver, bps);
        emit RoyaltyInfoUpdated(receiver, bps);
    }

    // ------------------------------------------------------------------------
    // Pairing (activation — done on the 402 site, post-mint)
    // ------------------------------------------------------------------------

    /**
     * @notice Activate a seat: pair it 1:1 with an ERC-8004 agent identity.
     *         Only the current seat holder can call; the caller must own
     *         `agentId` in the Identity Registry, the seat must be unpaired,
     *         and the agent must not already be paired to another seat.
     *         First pairing is free of the cooldown; re-pairings wait 72h.
     * @dev This is the license activation step. Buy the NFT anywhere
     *      (OpenSea drop, secondary); bring it here to make it a license.
     *      Seats arrive unpaired after any transfer (pairings auto-clear).
     *      To change an existing pairing on a seat you still hold, use
     *      repairSeat.
     */
    function pairSeat(uint256 tokenId, uint256 agentId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotSeatOwner();
        if (seatToAgent[tokenId] != 0) revert SeatAlreadyPaired();
        _checkPairing(msg.sender, agentId);
        _enforcePairCooldown(tokenId);
        lastPairAt[tokenId] = block.timestamp;
        seatToAgent[tokenId] = agentId;
        agentToSeat[agentId] = tokenId;
        emit SeatPaired(tokenId, agentId, msg.sender);
    }

    /**
     * @notice Re-pair a seat you hold to a different agent. The new agent
     *         must be owned by the caller and unpaired. Carries a 72h
     *         cooldown per seat: one seat cannot be serially rotated across
     *         unlimited agents to multiplex licenses.
     * @dev Also works on a never-paired seat (equivalent to pairSeat).
     *      The license always follows the token holder.
     */
    function repairSeat(uint256 tokenId, uint256 newAgentId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotSeatOwner();
        uint256 oldAgentId = seatToAgent[tokenId];
        if (oldAgentId == newAgentId) revert NoPairingChange();
        _checkPairing(msg.sender, newAgentId);
        _enforcePairCooldown(tokenId);
        lastPairAt[tokenId] = block.timestamp;
        if (oldAgentId != 0) {
            agentToSeat[oldAgentId] = 0;
        }
        seatToAgent[tokenId] = newAgentId;
        agentToSeat[newAgentId] = tokenId;
        emit SeatRepaired(tokenId, oldAgentId, newAgentId);
    }

    /**
     * @notice Clear a stale pairing from the agent side. Callable by the
     *         current owner of an agent whose paired seat they do NOT own.
     *         Covers the case where the ERC-8004 agent NFT itself moved
     *         (transfer, etc.) while the seat stayed put: the seat side
     *         auto-clears on seat transfer, but the agent side had no
     *         permissionless clear, leaving the new agent owner unable to
     *         pair their agent anywhere. The seat's pairing cooldown is NOT
     *         reset — the seat owner still waits out the original 72h
     *         before re-pairing, so this is cleanup, not a rotation bypass.
     */
    function clearStalePairing(uint256 agentId) external {
        uint256 seatId = agentToSeat[agentId];
        if (seatId == 0) revert SeatNotPaired();
        if (IDENTITY_REGISTRY.ownerOf(agentId) != msg.sender) {
            revert NotAgentOwner();
        }
        if (ownerOf(seatId) == msg.sender) revert PairingNotStale();
        agentToSeat[agentId] = 0;
        seatToAgent[seatId] = 0;
        emit SeatUnpaired(seatId, agentId);
    }

    /// @dev The caller must own `agentId` in the Identity Registry and the
    ///      agent must not already be paired to a seat.
    function _checkPairing(address to, uint256 agentId) internal view {
        if (IDENTITY_REGISTRY.ownerOf(agentId) != to) revert IdentityNotOwnedByRecipient();
        if (agentToSeat[agentId] != 0) revert AgentAlreadyPaired();
    }

    /// @dev 72h between pairing actions on the same seat. Never reset on
    ///      transfer — resets are gameable via self-transfer, and the whole
    ///      point is that pair -> transfer -> pair rotation must wait.
    function _enforcePairCooldown(uint256 tokenId) internal view {
        uint256 last = lastPairAt[tokenId];
        if (last != 0 && block.timestamp < last + PAIR_COOLDOWN) revert PairCooldown();
    }

    // ------------------------------------------------------------------------
    // ERC-8217 agent binding (mint = identity)
    // ------------------------------------------------------------------------

    /**
     * @notice Set the ERC-8217 binding adapter (one-time, pre-mint).
     *         The adapter must already be deployed and initialized against
     *         the canonical ERC-8004 Identity Registry. Cannot be changed
     *         afterwards: bindings written through it are permanent.
     */
    function setAgentAdapter(address adapter) external onlyOwner {
        if (agentAdapter != address(0)) revert AgentAdapterAlreadySet(agentAdapter);
        if (adapter == address(0)) revert ZeroAddress();
        if (totalSupply() != 0) revert AgentsAfterFirstMint();
        agentAdapter = adapter;
        emit AgentAdapterSet(adapter);
    }

    /**
     * @notice Register ERC-8004 agent identities for tokenIds [first, last]
     *         via the binding adapter. Owner-only, pre-mint only: the adapter
     *         only lets the token contract bind IDs that have no owner yet.
     * @dev Each agent's URI is prefix + tokenId + suffix (decide the soul
     *      URL scheme before running this — it is written onchain).
     *      Registration is idempotent per tokenId: already-registered IDs
     *      are skipped, so ranges can be retried or split across batches.
     *      Keep batches modest (a few hundred IDs): each registration mints
     *      an ERC-8004 identity plus adapter storage writes.
     */
    function registerAgents(uint256 first, uint256 last, string calldata prefix, string calldata suffix)
        external
        onlyOwner
        nonReentrant
    {
        address adapter = agentAdapter;
        if (adapter == address(0)) revert AgentAdapterNotSet();
        if (totalSupply() != 0) revert AgentsAfterFirstMint();
        if (first == 0 || last < first || last > _maxSupply) {
            revert AgentIdsOutOfRange(first, last);
        }
        IAgentBindingAdapter binding = IAgentBindingAdapter(adapter);
        for (uint256 id = first; id <= last; ++id) {
            if (_agentPlusOne[id] != 0) continue;
            uint256 agentId = binding.register(
                0, // ERC721
                address(this),
                id,
                string.concat(prefix, id.toString(), suffix)
            );
            _agentPlusOne[id] = agentId + 1;
            emit AgentRegistered(id, agentId);
        }
    }

    /**
     * @notice The bound ERC-8004 agent for a tokenId.
     * @return registered True if an agent was registered pre-mint.
     * @return agentId The bound agent ID (0 when unregistered).
     */
    function agentOf(uint256 tokenId) external view returns (bool registered, uint256 agentId) {
        uint256 plusOne = _agentPlusOne[tokenId];
        if (plusOne == 0) return (false, 0);
        return (true, plusOne - 1);
    }

    // ------------------------------------------------------------------------
    // Onchain metadata (ERC-8048 soul — inherits the reference module)
    // ------------------------------------------------------------------------
    //
    // Reads go through ERC8048.metadata (draft-conformant, returns bytes).
    // Keys: "context" (soul/persona), "name", "trait[<slot>]", "tier",
    // "rank", "image", "endpoint[web]". tokenURI is untouched.

    /**
     * @notice Write an onchain metadata value (UTF-8 text). Owner-only.
     *         Reverts for locked keys — locking is permanent, lock post-reveal.
     */
    function setTokenMetadata(uint256 tokenId, string calldata key, string calldata value)
        external
        onlyOwner
    {
        _setMetadata(tokenId, key, bytes(value));
    }

    /**
     * @notice Batch-write one metadata key across many tokens. Owner-only.
     * @dev tokenIds and values must be the same length.
     */
    function setTokenMetadataBatch(
        uint256[] calldata tokenIds,
        string calldata key,
        string[] calldata values
    ) external onlyOwner {
        if (tokenIds.length != values.length) revert EmptyBatch();
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            _setMetadata(tokenIds[i], key, bytes(values[i]));
        }
    }

    /**
     * @notice Permanently lock a metadata key. After this, no one — not
     *         even the owner — can write that key again. Lock post-reveal.
     */
    function lockMetadata(string calldata key) external onlyOwner {
        _lockMetadata(key);
    }

    // ------------------------------------------------------------------------
    // Owner controls
    // ------------------------------------------------------------------------

    function _requireCanSetValidator() internal view override {
        _checkOwner();
    }

    // ------------------------------------------------------------------------
    // Metadata / views
    // ------------------------------------------------------------------------

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    /// @notice tokenURI = baseURI + tokenId + ".json" (e.g. .../1.json).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseURI(), tokenId.toString(), ".json");
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC2981, ERC8048, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(INonFungibleSeaDropToken).interfaceId ||
            interfaceId == type(ISeaDropTokenContractMetadata).interfaceId ||
            interfaceId == type(ICreatorToken).interfaceId ||
            interfaceId == type(ICreatorTokenLegacy).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @dev OZ v5 transfer hook: on real transfers the seat's pairing is
    ///      resolved to its bound agent FIRST, so the license and the identity
    ///      both follow the token holder — no stale seller pairings, no buyer
    ///      repair step. A token with no registered bound agent keeps the
    ///      legacy behavior (pairing cleared; buyer pairs their own agent).
    ///      Then the transfer is gated through the ERC-721C validator.
    ///      Mints/burns are never gated (reference semantics).
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address from)
    {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            uint256 agentId = seatToAgent[tokenId];
            if (agentId != 0) {
                seatToAgent[tokenId] = 0;
                agentToSeat[agentId] = 0;
                emit SeatUnpaired(tokenId, agentId);
            }
            uint256 boundPlusOne = _agentPlusOne[tokenId];
            if (boundPlusOne != 0) {
                uint256 boundAgentId = boundPlusOne - 1;
                seatToAgent[tokenId] = boundAgentId;
                agentToSeat[boundAgentId] = tokenId;
                emit SeatPaired(tokenId, boundAgentId, to);
            }
            _validateTransferWithValidator(_msgSender(), from, to, tokenId);
        }
        return from;
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }
}
