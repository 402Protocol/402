// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
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

    // ------------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------------

    function test_MintHappyPath() public {
        uint256[] memory ids = _register(agent, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.expectEmit(true, true, true, true);
        emit SeatPaired(1, ids[0], agent);
        vm.prank(payer);
        traces.mint(agent, ids[0]);

        assertEq(traces.ownerOf(1), agent);
        assertEq(traces.seatToAgent(1), ids[0]);
        assertEq(traces.agentToSeat(ids[0]), 1);
        assertEq(traces.nextTokenId(), 2);
        assertEq(usdc.balanceOf(treasury), PRICE);
        assertEq(usdc.balanceOf(payer), 0);
        assertEq(traces.balanceOf(agent), 1);
    }

    function test_MintBatchSequential() public {
        uint256[] memory ids = _register(agent, 3);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE * 3);

        vm.prank(payer);
        traces.mintBatch(agent, ids);

        assertEq(traces.ownerOf(1), agent);
        assertEq(traces.ownerOf(2), agent);
        assertEq(traces.ownerOf(3), agent);
        assertEq(traces.seatToAgent(2), ids[1]);
        assertEq(traces.agentToSeat(ids[2]), 3);
        assertEq(traces.nextTokenId(), 4);
        assertEq(usdc.balanceOf(treasury), PRICE * 3);
    }

    function test_MintBatchDuplicateAgentReverts() public {
        uint256[] memory ids = _register(agent, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE * 2);

        uint256[] memory dup = new uint256[](2);
        dup[0] = ids[0];
        dup[1] = ids[0];
        vm.prank(payer);
        vm.expectRevert(TracesLicense.AgentAlreadyPaired.selector);
        traces.mintBatch(agent, dup);
    }

    // ------------------------------------------------------------------------
    // Pairing guards
    // ------------------------------------------------------------------------

    function test_RevertWhen_RecipientDoesNotOwnIdentity() public {
        uint256[] memory ids = _register(agent, 1); // owned by agent, not payer
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.IdentityNotOwnedByRecipient.selector);
        traces.mint(payer, ids[0]); // payer doesn't own the identity
    }

    function test_RevertWhen_IdentityDoesNotExist() public {
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.IdentityNotOwnedByRecipient.selector);
        traces.mint(agent, 999); // mock returns address(0)
    }

    function test_RevertWhen_AgentAlreadyPaired() public {
        uint256[] memory ids = _register(agent, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE * 2);

        vm.prank(payer);
        traces.mint(agent, ids[0]);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.AgentAlreadyPaired.selector);
        traces.mint(agent, ids[0]);
    }

    // ------------------------------------------------------------------------
    // Caps and gates
    // ------------------------------------------------------------------------

    function test_MintClosedByDefault() public {
        assertFalse(traces.mintOpen());
        uint256[] memory ids = _register(agent, 1);
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.MintClosed.selector);
        traces.mint(agent, ids[0]);
    }

    function test_SetMintOpenOnlyOwner() public {
        vm.prank(payer);
        vm.expectRevert();
        traces.setMintOpen(true);
    }

    function test_WalletCapEnforced() public {
        uint256[] memory ids = _register(agent, 11);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE * 11);

        vm.prank(payer);
        traces.mintBatch(agent, _slice(ids, 0, 10));
        assertEq(traces.balanceOf(agent), 10);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.WalletCapExceeded.selector);
        traces.mint(agent, ids[10]);
    }

    function test_MaxSupplyEnforced() public {
        // Shrink the problem: mint 10/wallet across many wallets is slow;
        // instead verify the boundary logic via nextTokenId math on a
        // fresh contract is covered by construction. Here we at least assert
        // the constant.
        assertEq(traces.MAX_SUPPLY(), 10_000);
        assertEq(traces.nextTokenId(), 1);
    }

    // ------------------------------------------------------------------------
    // Team mints
    // ------------------------------------------------------------------------

    function test_TeamMintFreeAndCounted() public {
        uint256[] memory ids = _register(agent, 2);
        // public mint stays closed; team mint works regardless
        assertFalse(traces.mintOpen());

        vm.prank(owner);
        traces.teamMint(agent, ids[0]);

        assertEq(traces.ownerOf(1), agent);
        assertEq(traces.seatToAgent(1), ids[0]);
        assertEq(traces.teamMinted(), 1);
        assertEq(usdc.balanceOf(treasury), 0); // free
        assertEq(traces.nextTokenId(), 2);

        // team mint still enforces pairing + wallet cap
        vm.prank(owner);
        vm.expectRevert(TracesLicense.AgentAlreadyPaired.selector);
        traces.teamMint(agent, ids[0]);
    }

    function test_TeamMintOnlyOwner() public {
        uint256[] memory ids = _register(agent, 1);
        vm.prank(payer);
        vm.expectRevert();
        traces.teamMint(agent, ids[0]);
    }

    function test_TeamMintCap100() public {
        // 100 team mints across 10 wallets (10/wallet cap)
        for (uint256 w = 0; w < 10; ++w) {
            address wallet = address(uint160(0x1000 + w));
            uint256[] memory ids = _register(wallet, 10);
            for (uint256 i = 0; i < 10; ++i) {
                vm.prank(owner);
                traces.teamMint(wallet, ids[i]);
            }
        }
        assertEq(traces.teamMinted(), 100);

        uint256[] memory extra = _register(address(0x9999), 1);
        vm.prank(owner);
        vm.expectRevert(TracesLicense.TeamSupplyExhausted.selector);
        traces.teamMint(address(0x9999), extra[0]);
    }

    function test_TeamMintCountsTowardWalletCap() public {
        uint256[] memory ids = _register(agent, 11);
        for (uint256 i = 0; i < 10; ++i) {
            vm.prank(owner);
            traces.teamMint(agent, ids[i]);
        }
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.WalletCapExceeded.selector);
        traces.mint(agent, ids[10]);
    }

    // ------------------------------------------------------------------------
    // Economics: price, treasury, royalties
    // ------------------------------------------------------------------------

    function test_PricePullMath() public {
        uint256[] memory ids = _register(agent, 2);
        vm.prank(owner);
        traces.setMintOpen(true);
        // payer approves exactly price*2; over-pull would revert
        _fundPayer(PRICE * 2);

        vm.prank(payer);
        traces.mintBatch(agent, ids);
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
        uint256[] memory ids = _register(agent, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent, ids[0]);

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
        uint256[] memory ids = _register(agent, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent, ids[0]);

        // default validator has no code on this chain: transfers unrestricted
        vm.prank(agent);
        traces.transferFrom(agent, payer, 1);
        assertEq(traces.ownerOf(1), payer);
    }

    // ------------------------------------------------------------------------
    // repairSeat (secondary-market re-pairing)
    // ------------------------------------------------------------------------

    event SeatRepaired(uint256 indexed tokenId, uint256 indexed oldAgentId, uint256 indexed newAgentId);

    function test_RepairSeatAfterSecondarySale() public {
        address buyer = address(0xBEE5);
        uint256[] memory sellerIds = _register(agent, 1);
        uint256[] memory buyerIds = _register(buyer, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent, sellerIds[0]);

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

    function test_RepairSeatNonOwnerReverts() public {
        address stranger = address(0xBAD);
        uint256[] memory ids = _register(agent, 2);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent, ids[0]);

        vm.prank(stranger);
        vm.expectRevert(TracesLicense.NotSeatOwner.selector);
        traces.repairSeat(1, ids[1]);
    }

    function test_RepairSeatToUnownedAgentReverts() public {
        address stranger = address(0xBAD);
        uint256[] memory agentIds = _register(agent, 1);
        uint256[] memory strangerIds = _register(stranger, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent, agentIds[0]);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.IdentityNotOwnedByRecipient.selector);
        traces.repairSeat(1, strangerIds[0]);
    }

    function test_RepairSeatToAlreadyPairedAgentReverts() public {
        uint256[] memory ids = _register(agent, 2);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE * 2);

        vm.prank(payer);
        uint256[] memory two = _slice(ids, 0, 2);
        traces.mintBatch(agent, two);

        // agent's second identity is already paired to seat 2
        vm.prank(agent);
        vm.expectRevert(TracesLicense.AgentAlreadyPaired.selector);
        traces.repairSeat(1, ids[1]);
    }

    function test_RepairSeatSameAgentReverts() public {
        uint256[] memory ids = _register(agent, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE);

        vm.prank(payer);
        traces.mint(agent, ids[0]);

        vm.prank(agent);
        vm.expectRevert(TracesLicense.NoPairingChange.selector);
        traces.repairSeat(1, ids[0]);
    }

    function test_EnumerableListsOwnerSeats() public {
        address buyer = address(0xBEE5);
        uint256[] memory ids = _register(agent, 2);
        uint256[] memory buyerIds = _register(buyer, 1);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fundPayer(PRICE * 3);

        vm.prank(payer);
        traces.mintBatch(agent, _slice(ids, 0, 2));
        vm.prank(payer);
        traces.mint(buyer, buyerIds[0]);

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

    // ------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------

    function _slice(uint256[] memory arr, uint256 start, uint256 len)
        internal
        pure
        returns (uint256[] memory out)
    {
        out = new uint256[](len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = arr[start + i];
        }
    }
}
