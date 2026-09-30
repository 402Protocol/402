// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ICreatorToken} from "@creator-token-standards/interfaces/ICreatorToken.sol";
import {ICreatorTokenLegacy} from "@creator-token-standards/interfaces/ICreatorTokenLegacy.sol";
import {ERC721CCompat} from "./ERC721CCompat.sol";

/// @notice Minimal view of the canonical ERC-8004 Identity Registry (ERC-721).
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @title TracesLicense
/// @notice TRACES: 10,000 agent seat licenses on Ink. The collection launches
///         as a normal NFT drop (e.g. OpenSea); each seat becomes a license
///         when paired 1:1 with a canonical ERC-8004 agent identity via
///         pairSeat — minting workers, not JPEGs.
///
///         Whitelist: Quotrons terminal-NFT holders (1:1 per terminal) mint
///         at the whitelist price during the whitelist window by proving
///         inclusion in a Merkle root built from a SURPRISE snapshot of
///         Robinhood Chain at a past block. Unclaimed whitelist allocation
///         rolls into the public sale automatically (shared 10k supply).
///
///         License integrity: pairings auto-clear when a seat transfers, so
///         the license always follows the token holder. repairSeat carries
///         a 72h cooldown so one seat cannot serially license unlimited
///         agents. Job-board integrations MUST additionally check that the
///         same wallet owns both the seat and the agent identity
///         (agentToSeat != 0 alone is not sufficient — agent identities are
///         transferable ERC-721s).
/// @dev Non-upgradeable by design (same posture as AgentEscrow).
///      ERC-721C-compatible transfer gating via ERC721CCompat (see its docs
///      for why the Limit Break contracts are not inherited directly).
contract TracesLicense is ERC721, ERC721Enumerable, ERC2981, Ownable, ReentrancyGuard, ERC721CCompat {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    // ------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------

    /// @notice Total seat supply. Token IDs run 1..MAX_SUPPLY, strictly sequential.
    uint256 public constant MAX_SUPPLY = 10_000;
    /// @notice Max seats receivable per wallet (team mints count too).
    uint256 public constant MAX_PER_WALLET = 10;
    /// @notice Free team claims available via teamMint.
    uint256 public constant TEAM_SUPPLY = 100;
    /// @notice ERC-2981 royalty: 5% to treasury.
    uint96 public constant ROYALTY_BPS = 500;
    /// @notice Cooldown between repairSeat calls on the same seat. Kills
    ///         license multiplexing (one seat serially licensing N agents)
    ///         while staying invisible to legitimate secondhand buyers, who
    ///         pair once via pairSeat after auto-clear.
    uint256 public constant REPAIR_COOLDOWN = 72 hours;

    /// @notice ERC-8004 Identity Registry seats pair against.
    /// @dev Immutable, set at deploy. On Ink mainnet this is
    ///      0x7274e874CA62410a93Bd8bf61c69d8045E399c02 (the live
    ///      IdentityRegistryUpgradeable) — NOT the 0x8004... vanity address,
    ///      which is still the 8004 team's unupgraded placeholder.
    IIdentityRegistry public immutable IDENTITY_REGISTRY;

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error MintClosed();
    error MaxSupplyReached();
    error WalletCapExceeded();
    error IdentityNotOwnedByRecipient();
    error AgentAlreadyPaired();
    error SeatAlreadyPaired();
    error TeamSupplyExhausted();
    error EmptyBatch();
    error ZeroAddress();
    error NotSeatOwner();
    error NoPairingChange();
    error InvalidProof();
    error TerminalAlreadyClaimed();
    error WhitelistNotActive();
    error WhitelistPhaseActive();
    error WhitelistLocked();
    error InvalidWindow();
    error RepairCooldown();
    error RegistryNotContract();

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event SeatPaired(uint256 indexed tokenId, uint256 indexed agentId, address indexed to);
    event SeatRepaired(uint256 indexed tokenId, uint256 indexed oldAgentId, uint256 indexed newAgentId);
    /// @notice Emitted when a seat transfer auto-clears its pairing. The
    ///         license follows the token: the seller's agent is unpaired and
    ///         the buyer's seat arrives clean.
    event SeatUnpaired(uint256 indexed tokenId, uint256 indexed agentId);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event WhitelistPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event WhitelistMerkleRootUpdated(bytes32 root);
    event WhitelistWindowUpdated(uint64 start, uint64 end);
    event WhitelistMint(address indexed to, uint256 indexed terminalId, uint256 indexed tokenId);
    event MintOpenUpdated(bool open);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event BaseURIUpdated(string newBaseURI);

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------

    /// @notice USDC (or chain equivalent) pulled from the payer on mint.
    IERC20 public immutable paymentToken;
    /// @notice Receives mint payments and ERC-2981 royalties.
    address public treasury;
    /// @notice Public seat price in payment-token base units (6 decimals on Ink USDC).
    uint256 public price;
    /// @notice Whitelist seat price in payment-token base units.
    uint256 public whitelistPrice;
    /// @notice Public minting starts closed; founder opens when ready.
    bool public mintOpen;
    /// @notice Next token ID to mint. Starts at 1 (matches metadata numbering).
    uint256 public nextTokenId = 1;
    /// @notice Team claims used so far (cap: TEAM_SUPPLY).
    uint256 public teamMinted;

    /// @notice Merkle root of the whitelist: leaves are
    ///         keccak256(bytes.concat(keccak256(abi.encode(wallet, terminalId))))
    ///         for each (snapshot wallet, Quotrons terminal tokenId) pair.
    ///         Built from a SURPRISE snapshot of Robinhood Chain at a past
    ///         block — never announced in advance, so terminals cannot be
    ///         farmed into fresh wallets ahead of it.
    bytes32 public whitelistMerkleRoot;
    /// @notice Whitelist window [start, end]. Zero start = no whitelist
    ///         configured (plain sale). Set before the window opens; locked
    ///         once the window starts.
    uint64 public whitelistStart;
    uint64 public whitelistEnd;
    /// @notice Quotrons terminal tokenId => claimed. Each terminal entitles
    ///         its snapshot holder to exactly one whitelist mint.
    mapping(uint256 => bool) public terminalClaimed;

    /// @notice seat tokenId => paired ERC-8004 agentId (0 = unpaired).
    mapping(uint256 => uint256) public seatToAgent;
    /// @notice ERC-8004 agentId => seat tokenId (0 = unpaired; one seat per identity).
    mapping(uint256 => uint256) public agentToSeat;
    /// @notice seat tokenId => timestamp of the last repairSeat call.
    mapping(uint256 => uint256) public lastRepairAt;

    string private _baseTokenURI;

    // ------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address paymentToken_,
        address treasury_,
        uint256 whitelistPrice_,
        uint256 publicPrice_,
        string memory baseURI_,
        address identityRegistry_
    ) ERC721("TRACES", "TRACES") Ownable(initialOwner) {
        if (paymentToken_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        if (identityRegistry_.code.length == 0) revert RegistryNotContract();
        paymentToken = IERC20(paymentToken_);
        treasury = treasury_;
        whitelistPrice = whitelistPrice_;
        price = publicPrice_;
        _baseTokenURI = baseURI_;
        IDENTITY_REGISTRY = IIdentityRegistry(identityRegistry_);
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        emit TransferValidatorUpdated(address(0), DEFAULT_TRANSFER_VALIDATOR);
    }

    // ------------------------------------------------------------------------
    // Minting (plain sale — no identity pairing at mint)
    // ------------------------------------------------------------------------

    /**
     * @notice Mint one seat to `to` at the public price. No identity needed:
     *         this is a normal NFT sale (e.g. an OpenSea drop). Pairing
     *         happens later via pairSeat on the 402 site.
     * @dev Reverts during the whitelist window — whitelist claimants use
     *      whitelistMint; everyone else waits for the public phase. After
     *      the window ends, unclaimed whitelist allocation is simply part
     *      of the remaining public supply (shared 10k cap).
     *      The payer (msg.sender) may differ from the recipient: a human
     *      pays, the agent's wallet receives.
     */
    function mint(address to) external nonReentrant {
        if (!mintOpen) revert MintClosed();
        _requirePublicPhase();
        uint256 tokenId = _prepareMint(to, 1);
        paymentToken.safeTransferFrom(msg.sender, treasury, price);
        _mintSeat(to, tokenId);
    }

    /**
     * @notice Mint `n` seats to `to` in one transaction (public phase only).
     */
    function mintBatch(address to, uint256 n) external nonReentrant {
        if (!mintOpen) revert MintClosed();
        _requirePublicPhase();
        if (n == 0) revert EmptyBatch();
        uint256 firstId = _prepareMint(to, n);
        paymentToken.safeTransferFrom(msg.sender, treasury, price * n);
        for (uint256 i = 0; i < n; ++i) {
            _mintSeat(to, firstId + i);
        }
    }

    /**
     * @notice Whitelist mint: one seat at the whitelist price for a Quotrons
     *         terminal holder. The caller proves they held `terminalId` at
     *         the snapshot block via a Merkle proof against
     *         whitelistMerkleRoot. Each terminal claims exactly once; the
     *         seat goes to the claiming (snapshot) wallet.
     * @dev Leaf construction (offchain snapshot script must match):
     *      keccak256(bytes.concat(keccak256(abi.encode(wallet, terminalId)))),
     *      with OpenZeppelin sorted-pair hashing up the tree.
     */
    function whitelistMint(uint256 terminalId, bytes32[] calldata proof) external nonReentrant {
        if (!mintOpen) revert MintClosed();
        if (
            whitelistStart == 0 ||
            block.timestamp < whitelistStart ||
            block.timestamp > whitelistEnd
        ) revert WhitelistNotActive();
        if (terminalClaimed[terminalId]) revert TerminalAlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, terminalId))));
        if (!MerkleProof.verify(proof, whitelistMerkleRoot, leaf)) revert InvalidProof();
        terminalClaimed[terminalId] = true;

        uint256 tokenId = _prepareMint(msg.sender, 1);
        paymentToken.safeTransferFrom(msg.sender, treasury, whitelistPrice);
        _mintSeat(msg.sender, tokenId);
        emit WhitelistMint(msg.sender, terminalId, tokenId);
    }

    /**
     * @notice Founder-only free claims (team allocation). Same wallet-cap
     *         rules as paid mints; price is 0. Works while the public mint
     *         is still closed.
     */
    function teamMint(address to) external nonReentrant onlyOwner {
        if (teamMinted >= TEAM_SUPPLY) revert TeamSupplyExhausted();
        uint256 tokenId = _prepareMint(to, 1);
        teamMinted += 1;
        _mintSeat(to, tokenId);
    }

    // ------------------------------------------------------------------------
    // Pairing (activation — done on the 402 site, post-mint)
    // ------------------------------------------------------------------------

    /**
     * @notice Activate a seat: pair it 1:1 with an ERC-8004 agent identity.
     *         Only the current seat holder can call; the caller must own
     *         `agentId` in the Identity Registry, the seat must be unpaired,
     *         and the agent must not already be paired to another seat.
     * @dev This is the license activation step. Buy the NFT anywhere
     *      (OpenSea drop, secondary); bring it here to make it a license.
     *      Seats arrive unpaired after any transfer (pairings auto-clear),
     *      so secondhand buyers activate with pairSeat directly. To change
     *      an existing pairing on a seat you still hold, use repairSeat.
     */
    function pairSeat(uint256 tokenId, uint256 agentId) external {
        address seatOwner = ownerOf(tokenId);
        if (seatOwner != msg.sender) revert NotSeatOwner();
        if (seatToAgent[tokenId] != 0) revert SeatAlreadyPaired();
        _checkPairing(msg.sender, agentId);
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
        address seatOwner = ownerOf(tokenId);
        if (seatOwner != msg.sender) revert NotSeatOwner();
        uint256 oldAgentId = seatToAgent[tokenId];
        if (oldAgentId == newAgentId) revert NoPairingChange();
        uint256 lastRepair = lastRepairAt[tokenId];
        if (lastRepair != 0 && block.timestamp < lastRepair + REPAIR_COOLDOWN) {
            revert RepairCooldown();
        }
        _checkPairing(msg.sender, newAgentId);
        lastRepairAt[tokenId] = block.timestamp;
        if (oldAgentId != 0) {
            agentToSeat[oldAgentId] = 0;
        }
        seatToAgent[tokenId] = newAgentId;
        agentToSeat[newAgentId] = tokenId;
        emit SeatRepaired(tokenId, oldAgentId, newAgentId);
    }

    /**
     * @dev Shared pre-mint checks. Returns the first token ID of the batch.
     *      Sequential IDs are guaranteed because nextTokenId only moves
     *      forward on successful mints.
     */
    function _prepareMint(address to, uint256 n) internal view returns (uint256 firstTokenId) {
        if (to == address(0)) revert ZeroAddress();
        firstTokenId = nextTokenId;
        if (firstTokenId + n - 1 > MAX_SUPPLY) revert MaxSupplyReached();
        if (balanceOf(to) + n > MAX_PER_WALLET) revert WalletCapExceeded();
    }

    /// @dev Public mints are closed before the whitelist window opens and
    ///      restricted to whitelistMint during it. No window configured
    ///      (start == 0) means a plain sale with no whitelist phase.
    function _requirePublicPhase() internal view {
        if (whitelistStart == 0) return;
        if (block.timestamp < whitelistStart) revert MintClosed();
        if (block.timestamp <= whitelistEnd) revert WhitelistPhaseActive();
    }

    /// @dev The caller must own `agentId` in the Identity Registry and the
    ///      agent must not already be paired to a seat.
    function _checkPairing(address to, uint256 agentId) internal view {
        if (IDENTITY_REGISTRY.ownerOf(agentId) != to) revert IdentityNotOwnedByRecipient();
        if (agentToSeat[agentId] != 0) revert AgentAlreadyPaired();
    }

    function _mintSeat(address to, uint256 tokenId) internal {
        nextTokenId = tokenId + 1;
        _safeMint(to, tokenId);
    }

    // ------------------------------------------------------------------------
    // Owner controls
    // ------------------------------------------------------------------------

    function setPrice(uint256 newPrice) external onlyOwner {
        emit PriceUpdated(price, newPrice);
        price = newPrice;
    }

    /// @dev Whitelist params lock once the window starts: no moving the
    ///      goalposts mid-sale.
    function _requireWhitelistNotStarted() internal view {
        if (whitelistStart != 0 && block.timestamp >= whitelistStart) revert WhitelistLocked();
    }

    function setWhitelistPrice(uint256 newPrice) external onlyOwner {
        _requireWhitelistNotStarted();
        emit WhitelistPriceUpdated(whitelistPrice, newPrice);
        whitelistPrice = newPrice;
    }

    function setWhitelistMerkleRoot(bytes32 root) external onlyOwner {
        _requireWhitelistNotStarted();
        whitelistMerkleRoot = root;
        emit WhitelistMerkleRootUpdated(root);
    }

    function setWhitelistWindow(uint64 start, uint64 end) external onlyOwner {
        _requireWhitelistNotStarted();
        if (start == 0 || end <= start) revert InvalidWindow();
        whitelistStart = start;
        whitelistEnd = end;
        emit WhitelistWindowUpdated(start, end);
    }

    function setMintOpen(bool open) external onlyOwner {
        emit MintOpenUpdated(open);
        mintOpen = open;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
        _setDefaultRoyalty(newTreasury, ROYALTY_BPS);
    }

    /// @notice Update the metadata base URI (e.g. if the deploy-time CID was
    ///         wrong). Owner-only; emits for indexer visibility.
    function setBaseURI(string memory newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

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
        override(ERC721, ERC721Enumerable, ERC2981)
        returns (bool)
    {
        return
            interfaceId == type(ICreatorToken).interfaceId ||
            interfaceId == type(ICreatorTokenLegacy).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @dev OZ v5 transfer hook: on real transfers the seat's pairing is
    ///      auto-cleared FIRST, so the license always follows the token
    ///      holder — no stale seller pairings, no buyer repair step. Then
    ///      the transfer is gated through the ERC-721C validator.
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
