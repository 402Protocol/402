// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";
import {ERC721CCompat} from "../../contracts/ERC721CCompat.sol";
import {ICreatorToken} from "@creator-token-standards/interfaces/ICreatorToken.sol";
import {ICreatorTokenLegacy} from "@creator-token-standards/interfaces/ICreatorTokenLegacy.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

/// @notice Controllable stand-in for the canonical ERC-8004 Identity Registry.
contract MockIdentityRegistry {
    mapping(uint256 => address) private _owners;
    uint256 private _nextId = 1;

    function register(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _owners[id] = to;
        return id;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _owners[agentId];
    }
}

/// @notice Minimal mintable ERC-20 (6 decimals, like USDC).
contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _spend(msg.sender, amount);
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _spend(from, amount);
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function _spend(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
    }
}

contract TracesLicenseTest is Test {
    TracesLicense internal traces;
    MockIdentityRegistry internal registry;
    MockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal payer = address(0xCAFE);
    address internal agent = address(0xD00D);

    uint256 internal constant PRICE = 10_000_000; // $10.00 USDC
    string internal constant BASE_URI = "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/";

    event SeatPaired(uint256 indexed tokenId, uint256 indexed agentId, address indexed to);
    event SeatRepaired(uint256 indexed tokenId, uint256 indexed oldAgentId, uint256 indexed newAgentId);

    function setUp() public {
        registry = new MockIdentityRegistry();
        usdc = new MockUSDC();
        // Pair against the mock registry (constructor param); on Ink mainnet
        // this is 0x7274e874CA62410a93Bd8bf61c69d8045E399c02, the live
        // IdentityRegistryUpgradeable.
        traces = new TracesLicense(owner, address(usdc), treasury, PRICE, BASE_URI, address(registry));
    }

    /// @dev Register `n` identities owned by `to`, using the mock that now
    ///      lives at the canonical registry address.
    function _register(address to, uint256 n) internal returns (uint256[] memory ids) {
        MockIdentityRegistry reg = MockIdentityRegistry(address(traces.IDENTITY_REGISTRY()));
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            ids[i] = reg.register(to);
        }
    }

    function _fundPayer(uint256 amount) internal {
        usdc.mint(payer, amount);
        vm.prank(payer);
        usdc.approve(address(traces), amount);
    }

    function _openMint() internal {
        vm.prank(owner);
        traces.setMintOpen(true);
    }

    // ------------------------------------------------------------------------
    // Happy path: mint needs no identity (OpenSea-drop model)
    // ------------------------------------------------------------------------

    function test_MintHappyPathNoIdentityNeeded() public {
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent); // no 8004 identity exists at all — still succeeds

        assertEq(traces.ownerOf(1), agent);
        assertEq(traces.seatToAgent(1), 0); // unpaired until activation
        assertEq(traces.nextTokenId(), 2);
        assertEq(usdc.balanceOf(treasury), PRICE);
        assertEq(usdc.balanceOf(payer), 0);
        assertEq(traces.balanceOf(agent), 1);
    }

    function test_MintBatchSequential() public {
        _openMint();
        _fundPayer(PRICE * 3);

        vm.prank(payer);
        traces.mintBatch(agent, 3);

        assertEq(traces.ownerOf(1), agent);
        assertEq(traces.ownerOf(2), agent);
        assertEq(traces.ownerOf(3), agent);
        assertEq(traces.seatToAgent(2), 0);
        assertEq(traces.nextTokenId(), 4);
        assertEq(usdc.balanceOf(treasury), PRICE * 3);
    }

    function test_MintBatchZeroReverts() public {
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.EmptyBatch.selector);
        traces.mintBatch(agent, 0);
    }

    // ------------------------------------------------------------------------
    // pairSeat (activation on the 402 site)
    // ------------------------------------------------------------------------

    function test_PairSeatHappyPath() public {
        uint256[] memory ids = _register(agent, 1);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);
        assertEq(traces.seatToAgent(1), 0);

        vm.expectEmit(true, true, true, true);
        emit SeatPaired(1, ids[0], agent);
        vm.prank(agent);
        traces.pairSeat(1, ids[0]);

        assertEq(traces.seatToAgent(1), ids[0]);
        assertEq(traces.agentToSeat(ids[0]), 1);
    }

    function test_PairSeatNotHolderReverts() public {
        address stranger = address(0xBAD);
        uint256[] memory ids = _register(stranger, 1);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);

        vm.prank(stranger);
        vm.expectRevert(TracesLicense.NotSeatOwner.selector);
        traces.pairSeat(1, ids[0]);
    }

    function test_PairSeatUnownedAgentReverts() public {
        uint256[] memory ids = _register(agent, 1); // owned by agent, not payer
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(payer);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.IdentityNotOwnedByRecipient.selector);
        traces.pairSeat(1, ids[0]); // payer doesn't own the identity
    }

    function test_PairSeatNonexistentAgentReverts() public {
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.IdentityNotOwnedByRecipient.selector);
        traces.pairSeat(1, 999); // mock returns address(0)
    }

    function test_PairSeatAlreadyPairedAgentReverts() public {
        uint256[] memory ids = _register(agent, 1);
        _openMint();
        _fundPayer(PRICE * 2);

        vm.prank(payer);
        traces.mintBatch(agent, 2);

        vm.prank(agent);
        traces.pairSeat(1, ids[0]);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.AgentAlreadyPaired.selector);
        traces.pairSeat(2, ids[0]); // one seat per identity
    }

    function test_PairSeatAlreadyPairedSeatReverts() public {
        uint256[] memory ids = _register(agent, 2);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);

        vm.prank(agent);
        traces.pairSeat(1, ids[0]);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.SeatAlreadyPaired.selector);
        traces.pairSeat(1, ids[1]); // seat 1 is already activated
    }

    function test_PairSeatNonexistentTokenReverts() public {
        uint256[] memory ids = _register(agent, 1);
        _openMint();

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999)
        );
        traces.pairSeat(999, ids[0]);
    }

    // ------------------------------------------------------------------------
    // Caps and gates
    // ------------------------------------------------------------------------

    function test_MintClosedByDefault() public {
        assertFalse(traces.mintOpen());
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.MintClosed.selector);
        traces.mint(agent);
    }

    function test_SetMintOpenOnlyOwner() public {
        vm.prank(payer);
        vm.expectRevert();
        traces.setMintOpen(true);
    }

    function test_WalletCapEnforced() public {
        _openMint();
        _fundPayer(PRICE * 11);

        vm.prank(payer);
        traces.mintBatch(agent, 10);
        assertEq(traces.balanceOf(agent), 10);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.WalletCapExceeded.selector);
        traces.mint(agent);
    }

    function test_MaxSupplyEnforced() public {
        assertEq(traces.MAX_SUPPLY(), 10_000);
        assertEq(traces.nextTokenId(), 1);
    }

    // ------------------------------------------------------------------------
    // Team mints
    // ------------------------------------------------------------------------

    function test_TeamMintFreeAndCounted() public {
        // public mint stays closed; team mint works regardless, no identity needed
        assertFalse(traces.mintOpen());

        vm.prank(owner);
        traces.teamMint(agent);

        assertEq(traces.ownerOf(1), agent);
        assertEq(traces.seatToAgent(1), 0);
        assertEq(traces.teamMinted(), 1);
        assertEq(usdc.balanceOf(treasury), 0); // free
        assertEq(traces.nextTokenId(), 2);
    }

    function test_TeamMintOnlyOwner() public {
        vm.prank(payer);
        vm.expectRevert();
        traces.teamMint(agent);
    }

    function test_TeamMintCap100() public {
        // 100 team mints across 10 wallets (10/wallet cap)
        for (uint256 w = 0; w < 10; ++w) {
            address wallet = address(uint160(0x1000 + w));
            for (uint256 i = 0; i < 10; ++i) {
                vm.prank(owner);
                traces.teamMint(wallet);
            }
        }
        assertEq(traces.teamMinted(), 100);

        vm.prank(owner);
        vm.expectRevert(TracesLicense.TeamSupplyExhausted.selector);
        traces.teamMint(address(0x9999));
    }

    function test_TeamMintCountsTowardWalletCap() public {
        for (uint256 i = 0; i < 10; ++i) {
            vm.prank(owner);
            traces.teamMint(agent);
        }
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.WalletCapExceeded.selector);
        traces.mint(agent);
    }

    // ------------------------------------------------------------------------
    // Economics: price, treasury, royalties
    // ------------------------------------------------------------------------

    function test_PricePullMath() public {
        _openMint();
        // payer approves exactly price*2; over-pull would revert
        _fundPayer(PRICE * 2);

        vm.prank(payer);
        traces.mintBatch(agent, 2);
        assertEq(usdc.balanceOf(treasury), PRICE * 2);
        assertEq(usdc.balanceOf(payer), 0);
    }

    function test_SetPriceOnlyOwner() public {
        vm.prank(owner);
        traces.setPrice(20_000_000);
        assertEq(traces.price(), 20_000_000);

        vm.prank(payer);
        vm.expectRevert();
        traces.setPrice(1);
    }

    function test_Royalty500BpsToTreasury() public {
        (address receiver, uint256 amount) = traces.royaltyInfo(1, 10_000);
        assertEq(receiver, treasury);
        assertEq(amount, 500);
    }

    function test_SetTreasuryUpdatesRoyaltyReceiver() public {
        address newTreasury = address(0x5AFE);
        vm.prank(owner);
        traces.setTreasury(newTreasury);

        assertEq(traces.treasury(), newTreasury);
        (address receiver, uint256 amount) = traces.royaltyInfo(1, 10_000);
        assertEq(receiver, newTreasury);
        assertEq(amount, 500);

        vm.prank(payer);
        vm.expectRevert();
        traces.setTreasury(address(0x1));

        vm.prank(owner);
        vm.expectRevert(TracesLicense.ZeroAddress.selector);
        traces.setTreasury(address(0));
    }

    // ------------------------------------------------------------------------
    // Metadata
    // ------------------------------------------------------------------------

    function test_TokenURIFormat() public {
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);

        assertEq(
            traces.tokenURI(1),
            "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/1.json"
        );
    }

    function test_NameAndSymbol() public {
        assertEq(traces.name(), "TRACES");
        assertEq(traces.symbol(), "TRACES");
    }

    // ------------------------------------------------------------------------
    // ERC-721C compatibility
    // ------------------------------------------------------------------------

    function test_CreatorTokenInterfacesDetected() public {
        assertTrue(traces.supportsInterface(type(ICreatorToken).interfaceId));
        assertTrue(traces.supportsInterface(type(ICreatorTokenLegacy).interfaceId));
        assertTrue(traces.supportsInterface(type(IERC2981).interfaceId));
    }

    function test_DefaultTransferValidator() public {
        assertEq(
            traces.getTransferValidator(),
            0x721C008fdff27BF06E7E123956E2Fe03B63342e3
        );
    }

    function test_SetTransferValidatorOnlyOwner() public {
        address validator = address(0x7777);
        vm.etch(validator, hex"6001"); // give it code so the check passes

        vm.prank(payer);
        vm.expectRevert();
        traces.setTransferValidator(validator);

        vm.prank(owner);
        traces.setTransferValidator(validator);
        assertEq(traces.getTransferValidator(), validator);

        // non-contract address rejected
        vm.prank(owner);
        vm.expectRevert(ERC721CCompat.ERC721CCompat__InvalidTransferValidatorContract.selector);
        traces.setTransferValidator(address(0x8888));
    }

    function test_TransfersWorkWithDefaultValidator() public {
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);

        // default validator has no code on this chain: transfers unrestricted
        vm.prank(agent);
        traces.transferFrom(agent, payer, 1);
        assertEq(traces.ownerOf(1), payer);
    }

    // ------------------------------------------------------------------------
    // repairSeat (re-pairing after pairing / secondary sale)
    // ------------------------------------------------------------------------

    function test_RepairSeatAfterSecondarySale() public {
        address buyer = address(0xBEE5);
        uint256[] memory sellerIds = _register(agent, 1);
        uint256[] memory buyerIds = _register(buyer, 1);
        _openMint();
        _fundPayer(PRICE);

        // mint, then activate on the 402 site
        vm.prank(payer);
        traces.mint(agent);
        vm.prank(agent);
        traces.pairSeat(1, sellerIds[0]);

        // secondary sale: seat moves, pairing stays stale
        vm.prank(agent);
        traces.transferFrom(agent, buyer, 1);
        assertEq(traces.seatToAgent(1), sellerIds[0]);

        // buyer re-pairs the seat to their own agent
        vm.expectEmit(true, true, true, true);
        emit SeatRepaired(1, sellerIds[0], buyerIds[0]);
        vm.prank(buyer);
        traces.repairSeat(1, buyerIds[0]);

        assertEq(traces.seatToAgent(1), buyerIds[0]);
        assertEq(traces.agentToSeat(buyerIds[0]), 1);
        assertEq(traces.agentToSeat(sellerIds[0]), 0); // old pairing cleared
        assertEq(traces.ownerOf(1), buyer);
    }

    function test_RepairSeatOnNeverPairedSeat() public {
        address buyer = address(0xBEE5);
        uint256[] memory buyerIds = _register(buyer, 1);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);
        vm.prank(agent);
        traces.transferFrom(agent, buyer, 1);

        // repairSeat on a never-paired seat behaves like activation
        vm.expectEmit(true, true, true, true);
        emit SeatRepaired(1, 0, buyerIds[0]);
        vm.prank(buyer);
        traces.repairSeat(1, buyerIds[0]);

        assertEq(traces.seatToAgent(1), buyerIds[0]);
        assertEq(traces.agentToSeat(buyerIds[0]), 1);
    }

    function test_RepairSeatNonOwnerReverts() public {
        address stranger = address(0xBAD);
        uint256[] memory ids = _register(agent, 1);
        uint256[] memory strangerIds = _register(stranger, 1);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);
        vm.prank(agent);
        traces.pairSeat(1, ids[0]);

        vm.prank(stranger);
        vm.expectRevert(TracesLicense.NotSeatOwner.selector);
        traces.repairSeat(1, strangerIds[0]);
    }

    function test_RepairSeatToUnownedAgentReverts() public {
        address stranger = address(0xBAD);
        uint256[] memory strangerIds = _register(stranger, 1);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.IdentityNotOwnedByRecipient.selector);
        traces.repairSeat(1, strangerIds[0]);
    }

    function test_RepairSeatToAlreadyPairedAgentReverts() public {
        uint256[] memory ids = _register(agent, 2);
        _openMint();
        _fundPayer(PRICE * 2);

        vm.prank(payer);
        traces.mintBatch(agent, 2);
        vm.prank(agent);
        traces.pairSeat(1, ids[0]);
        vm.prank(agent);
        traces.pairSeat(2, ids[1]);

        // agent's second identity is already paired to seat 2
        vm.prank(agent);
        vm.expectRevert(TracesLicense.AgentAlreadyPaired.selector);
        traces.repairSeat(1, ids[1]);
    }

    function test_RepairSeatSameAgentReverts() public {
        uint256[] memory ids = _register(agent, 1);
        _openMint();
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent);
        vm.prank(agent);
        traces.pairSeat(1, ids[0]);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.NoPairingChange.selector);
        traces.repairSeat(1, ids[0]);
    }

    function test_EnumerableListsOwnerSeats() public {
        address buyer = address(0xBEE5);
        _openMint();
        _fundPayer(PRICE * 3);

        vm.prank(payer);
        traces.mintBatch(agent, 2);
        vm.prank(payer);
        traces.mint(buyer);

        // secondary sale moves one seat to the buyer
        vm.prank(agent);
        traces.transferFrom(agent, buyer, 1);

        assertEq(traces.balanceOf(agent), 1);
        assertEq(traces.tokenOfOwnerByIndex(agent, 0), 2);
        assertEq(traces.balanceOf(buyer), 2);
        assertEq(traces.tokenOfOwnerByIndex(buyer, 0), 3);
        assertEq(traces.tokenOfOwnerByIndex(buyer, 1), 1);
        assertEq(traces.totalSupply(), 3);
    }
}
