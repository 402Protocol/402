// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ICreatorToken} from "@creator-token-standards/interfaces/ICreatorToken.sol";
import {ICreatorTokenLegacy} from "@creator-token-standards/interfaces/ICreatorTokenLegacy.sol";
import {ERC721CCompat} from "./ERC721CCompat.sol";

/// @notice Minimal view of the canonical ERC-8004 Identity Registry (ERC-721).
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @title TracesLicense
/// @notice TRACES: 10,000 agent seat licenses on Ink. Each seat is paired
///         1:1 with a canonical ERC-8004 agent identity at mint time —
///         minting workers, not JPEGs.
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

    /// @notice ERC-8004 Identity Registry this collection pairs with.
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
    error TeamSupplyExhausted();
    error EmptyBatch();
    error ZeroAddress();
    error NotSeatOwner();
    error NoPairingChange();

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event SeatPaired(uint256 indexed tokenId, uint256 indexed agentId, address indexed to);
    event SeatRepaired(uint256 indexed tokenId, uint256 indexed oldAgentId, uint256 indexed newAgentId);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event MintOpenUpdated(bool open);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------

    /// @notice USDC (or chain equivalent) pulled from the payer on mint.
    IERC20 public immutable paymentToken;
    /// @notice Receives mint payments and ERC-2981 royalties.
    address public treasury;
    /// @notice Seat price in payment-token base units (6 decimals on Ink USDC). TBD at deploy.
    uint256 public price;
    /// @notice Public minting starts closed; founder opens when ready.
    bool public mintOpen;
    /// @notice Next token ID to mint. Starts at 1 (matches metadata numbering).
    uint256 public nextTokenId = 1;
    /// @notice Team claims used so far (cap: TEAM_SUPPLY).
    uint256 public teamMinted;

    /// @notice seat tokenId => paired ERC-8004 agentId.
    mapping(uint256 => uint256) public seatToAgent;
    /// @notice ERC-8004 agentId => seat tokenId (0 = unpaired; one seat per identity).
    mapping(uint256 => uint256) public agentToSeat;

    string private _baseTokenURI;

    // ------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address paymentToken_,
        address treasury_,
        uint256 initialPrice,
        string memory baseURI_,
        address identityRegistry_
    ) ERC721("TRACES", "TRACES") Ownable(initialOwner) {
        if (paymentToken_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        paymentToken = IERC20(paymentToken_);
        treasury = treasury_;
        price = initialPrice;
        _baseTokenURI = baseURI_;
        IDENTITY_REGISTRY = IIdentityRegistry(identityRegistry_);
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
        emit TransferValidatorUpdated(address(0), DEFAULT_TRANSFER_VALIDATOR);
    }

    // ------------------------------------------------------------------------
    // Minting
    // ------------------------------------------------------------------------

    /**
     * @notice Mint one seat to `to`, paired with ERC-8004 `agentId`.
     * @dev The payer (msg.sender) may differ from the recipient: a human
     *      pays, the agent's wallet receives. `to` MUST own `agentId`.
     */
    function mint(address to, uint256 agentId) external nonReentrant {
        if (!mintOpen) revert MintClosed();
        uint256 tokenId = _prepareMint(to, agentId, 1);
        paymentToken.safeTransferFrom(msg.sender, treasury, price);
        _mintSeat(to, tokenId, agentId);
    }

    /**
     * @notice Mint several seats to `to` in one transaction (e.g. a 10-agent fleet).
     * @dev Duplicate agentIds in the batch revert on the second occurrence.
     */
    function mintBatch(address to, uint256[] calldata agentIds) external nonReentrant {
        if (!mintOpen) revert MintClosed();
        uint256 n = agentIds.length;
        if (n == 0) revert EmptyBatch();
        uint256 firstId = _prepareMint(to, agentIds[0], n);
        paymentToken.safeTransferFrom(msg.sender, treasury, price * n);
        for (uint256 i = 0; i < n; ++i) {
            _mintSeat(to, firstId + i, agentIds[i]);
        }
    }

    /**
     * @notice Founder-only free claims (team allocation). Same pairing and
     *         wallet-cap rules as paid mints; price is 0. Works while the
     *         public mint is still closed.
     */
    function teamMint(address to, uint256 agentId) external nonReentrant onlyOwner {
        if (teamMinted >= TEAM_SUPPLY) revert TeamSupplyExhausted();
        uint256 tokenId = _prepareMint(to, agentId, 1);
        teamMinted += 1;
        _mintSeat(to, tokenId, agentId);
    }

    /**
     * @notice Re-pair a seat to a different agent. Only the seat holder can
     *         call this; the new agent must be owned by the caller and unpaired.
     * @dev The secondary-market path: after buying a seat secondhand, the
     *      buyer re-pairs it to their own agent. The old agent's pairing is
     *      cleared so it can pair with another seat later. The license
     *      always follows the token holder.
     */
    function repairSeat(uint256 tokenId, uint256 newAgentId) external {
        address seatOwner = ownerOf(tokenId);
        if (seatOwner != msg.sender) revert NotSeatOwner();
        uint256 oldAgentId = seatToAgent[tokenId];
        if (oldAgentId == newAgentId) revert NoPairingChange();
        _checkPairing(msg.sender, newAgentId);
        if (oldAgentId != 0) {
            agentToSeat[oldAgentId] = 0;
        }
        seatToAgent[tokenId] = newAgentId;
        agentToSeat[newAgentId] = tokenId;
        emit SeatRepaired(tokenId, oldAgentId, newAgentId);
    }

    /**
     * @dev Shared pre-mint checks. Returns the first token ID of the batch.
     *      Effects (nextTokenId bump) happen in _mintSeat per token so a
     *      mid-batch revert leaves no gaps... (revert rolls back anyway;
     *      sequential IDs are guaranteed because nextTokenId only moves
     *      forward on successful mints).
     */
    function _prepareMint(address to, uint256 firstAgentId, uint256 n)
        internal
        view
        returns (uint256 firstTokenId)
    {
        if (to == address(0)) revert ZeroAddress();
        firstTokenId = nextTokenId;
        if (firstTokenId + n - 1 > MAX_SUPPLY) revert MaxSupplyReached();
        if (balanceOf(to) + n > MAX_PER_WALLET) revert WalletCapExceeded();
        // Validate the first pairing eagerly for a clean error; the rest
        // are validated inside _mintSeat as the batch is written.
        _checkPairing(to, firstAgentId);
    }

    function _checkPairing(address to, uint256 agentId) internal view {
        if (IDENTITY_REGISTRY.ownerOf(agentId) != to) revert IdentityNotOwnedByRecipient();
        if (agentToSeat[agentId] != 0) revert AgentAlreadyPaired();
    }

    function _mintSeat(address to, uint256 tokenId, uint256 agentId) internal {
        _checkPairing(to, agentId);
        nextTokenId = tokenId + 1;
        seatToAgent[tokenId] = agentId;
        agentToSeat[agentId] = tokenId;
        _safeMint(to, tokenId);
        emit SeatPaired(tokenId, agentId, to);
    }

    // ------------------------------------------------------------------------
    // Owner controls
    // ------------------------------------------------------------------------

    function setPrice(uint256 newPrice) external onlyOwner {
        emit PriceUpdated(price, newPrice);
        price = newPrice;
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

    /// @dev OZ v5 transfer hook: gate real transfers through the ERC-721C
    ///      validator. Mints/burns are never gated (reference semantics).
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address from)
    {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
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
