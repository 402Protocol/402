// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicenseSeaDrop} from "../../contracts/TracesLicenseSeaDrop.sol";
import {ERC8048} from "../../contracts/ERC8048.sol";
import {INonFungibleSeaDropToken} from "../../contracts/seadrop/INonFungibleSeaDropToken.sol";

/// @notice Mock ERC-8217 adapter: enforces the real pre-mint rule (the token
///         contract may only bind IDs with no owner) and mints sequential
///         agent IDs, mirroring Adapter8004's observable behavior.
contract MockBindingAdapter {
    uint256 public nextAgentId = 100;
    mapping(uint256 => uint256) public boundAgent; // tokenId => agentId
    mapping(uint256 => string) public agentURI;

    function register(uint8 standard, address tokenContract, uint256 tokenId, string calldata uri)
        external
        returns (uint256 agentId)
    {
        require(standard == 0, "only ERC721");
        require(msg.sender == tokenContract, "only token contract pre-mint");
        // Pre-mint rule: the token must have no owner yet.
        try TracesLicenseSeaDrop(tokenContract).ownerOf(tokenId) returns (address) {
            revert("already owned");
        } catch {}
        require(boundAgent[tokenId] == 0, "already bound");
        agentId = nextAgentId++;
        boundAgent[tokenId] = agentId;
        agentURI[agentId] = uri;
    }

    function bindingOf(uint256 agentId)
        external
        view
        returns (uint8 standard, address tokenContract, uint256 tokenId)
    {
        return (0, address(0), agentId); // shape check only
    }
}

contract MockSeaDrop2 {
    function mintVia(address token, address to, uint256 qty) external {
        INonFungibleSeaDropToken(token).mintSeaDrop(to, qty);
    }
}

contract MockRegistry2 {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 agentId, address who) external {
        owners[agentId] = who;
    }
    function ownerOf(uint256 agentId) external view returns (address) {
        address o = owners[agentId];
        require(o != address(0), "no agent");
        return o;
    }
}

contract TracesAgentBindingTest is Test {
    TracesLicenseSeaDrop token;
    MockBindingAdapter adapter;
    MockSeaDrop2 seaDrop;
    MockRegistry2 registry;
    address owner = address(0xA11CE);
    address alice = address(0xA11A);
    address bob = address(0xB0B);

    string constant BASE = "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/";
    string constant PREFIX = "https://402.xyz/traces/";
    string constant SUFFIX = ".txt";

    function setUp() external {
        registry = new MockRegistry2();
        seaDrop = new MockSeaDrop2();
        adapter = new MockBindingAdapter();
        address[] memory allowed = new address[](1);
        allowed[0] = address(seaDrop);
        token = new TracesLicenseSeaDrop(
            owner,
            address(registry),
            allowed,
            BASE,
            address(0xBEEF),
            500
        );
        vm.prank(owner);
        token.setAgentAdapter(address(adapter));
    }

    // ---- setAgentAdapter ----

    function testSetAdapterOnce() external {
        assertEq(token.agentAdapter(), address(adapter));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                TracesLicenseSeaDrop.AgentAdapterAlreadySet.selector, address(adapter)
            )
        );
        token.setAgentAdapter(address(0x1234));
    }

    function testSetAdapterOnlyOwner() external {
        TracesLicenseSeaDrop t2 = _freshToken();
        vm.expectRevert();
        t2.setAgentAdapter(address(adapter));
    }

    function testSetAdapterZeroReverts() external {
        TracesLicenseSeaDrop t2 = _freshToken();
        vm.prank(owner);
        vm.expectRevert(TracesLicenseSeaDrop.ZeroAddress.selector);
        t2.setAgentAdapter(address(0));
    }

    // ---- registerAgents ----

    function testRegisterAgentsRange() external {
        vm.prank(owner);
        token.registerAgents(1, 5, PREFIX, SUFFIX);
        for (uint256 id = 1; id <= 5; ++id) {
            (bool registered, uint256 agentId) = token.agentOf(id);
            assertTrue(registered);
            assertEq(agentId, 99 + id); // mock starts at 100
            assertEq(adapter.agentURI(agentId), string.concat(PREFIX, vm.toString(id), SUFFIX));
        }
        (bool r6,) = token.agentOf(6);
        assertFalse(r6);
    }

    function testRegisterAgentsSkipsRegistered() external {
        vm.prank(owner);
        token.registerAgents(1, 3, PREFIX, SUFFIX);
        vm.prank(owner);
        token.registerAgents(2, 4, PREFIX, SUFFIX); // 2,3 skipped; 4 new
        (bool r4, uint256 a4) = token.agentOf(4);
        assertTrue(r4);
        assertEq(a4, 103);
    }

    function testRegisterAgentsRevertsAfterMint() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        vm.prank(owner);
        vm.expectRevert(TracesLicenseSeaDrop.AgentsAfterFirstMint.selector);
        token.registerAgents(2, 3, PREFIX, SUFFIX);
    }

    function testRegisterAgentsBadRange() external {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TracesLicenseSeaDrop.AgentIdsOutOfRange.selector, 0, 5)
        );
        token.registerAgents(0, 5, PREFIX, SUFFIX);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TracesLicenseSeaDrop.AgentIdsOutOfRange.selector, 1, 10001)
        );
        token.registerAgents(1, 10001, PREFIX, SUFFIX);
    }

    function testRegisterAgentsNoAdapter() external {
        TracesLicenseSeaDrop t2 = _freshToken();
        vm.prank(owner);
        vm.expectRevert(TracesLicenseSeaDrop.AgentAdapterNotSet.selector);
        t2.registerAgents(1, 2, PREFIX, SUFFIX);
    }

    function testRegisterAgentsOnlyOwner() external {
        vm.expectRevert();
        token.registerAgents(1, 2, PREFIX, SUFFIX);
    }

    // ---- mint = identity ----

    function testMintAutoPairsBoundAgent() external {
        vm.prank(owner);
        token.registerAgents(1, 2, PREFIX, SUFFIX);
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 2);
        (bool r1, uint256 a1) = token.agentOf(1);
        assertTrue(r1);
        assertEq(token.seatToAgent(1), a1);
        assertEq(token.seatToAgent(2), a1 + 1);
        assertEq(token.agentToSeat(a1), 1);
        assertEq(token.ownerOf(1), alice);
    }

    function testMintWithoutAgentStaysUnpaired() external {
        // No registration: legacy behavior — seat arrives unpaired.
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        assertEq(token.seatToAgent(1), 0);
    }

    // ---- transfer re-binding ----

    function testTransferRebindsBoundAgent() external {
        vm.prank(owner);
        token.registerAgents(1, 1, PREFIX, SUFFIX);
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        (, uint256 agentId) = token.agentOf(1);
        assertEq(token.seatToAgent(1), agentId);

        vm.prank(alice);
        token.transferFrom(alice, bob, 1);

        // License AND identity follow the token: still paired to the bound agent.
        assertEq(token.ownerOf(1), bob);
        assertEq(token.seatToAgent(1), agentId);
        assertEq(token.agentToSeat(agentId), 1);
    }

    function testTransferWithoutAgentClearsPairing() external {
        // Legacy path: no bound agent, manual pairing cleared on transfer.
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        registry.setOwner(999, alice);
        vm.prank(alice);
        token.pairSeat(1, 999);
        assertEq(token.seatToAgent(1), 999);

        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        assertEq(token.seatToAgent(1), 0);
        assertEq(token.agentToSeat(999), 0);
    }

    // ---- metadata ----

    function testMetadataSetGet() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        vm.prank(owner);
        token.setTokenMetadata(1, "context", "you are trace #1");
        assertEq(token.metadata(1, "context"), bytes("you are trace #1"));
    }

    function testMetadataLock() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        vm.prank(owner);
        token.setTokenMetadata(1, "context", "soul v1");
        vm.prank(owner);
        token.lockMetadata("context");
        assertTrue(token.metadataLocked("context"));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ERC8048.MetadataLocked.selector, "context")
        );
        token.setTokenMetadata(1, "context", "soul v2");
        // Other keys still writable.
        vm.prank(owner);
        token.setTokenMetadata(1, "tier", "gold");
        assertEq(token.metadata(1, "tier"), bytes("gold"));
    }

    function testMetadataBatch() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 3);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1; ids[1] = 2; ids[2] = 3;
        string[] memory vals = new string[](3);
        vals[0] = "a"; vals[1] = "b"; vals[2] = "c";
        vm.prank(owner);
        token.setTokenMetadataBatch(ids, "tier", vals);
        assertEq(token.metadata(2, "tier"), bytes("b"));
    }

    function testMetadataOnlyOwner() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        vm.expectRevert();
        token.setTokenMetadata(1, "context", "x");
    }

    // ---- ERC-8048 draft conformance ----

    function testSupportsInterface8048() external view {
        assertTrue(token.supportsInterface(0xdf670be1)); // IERC8048Metadata
        assertTrue(token.supportsInterface(0x01ffc9a7)); // IERC165
        assertTrue(token.supportsInterface(0x80ac58cd)); // ERC721 still there
    }

    function testMetadataSetEvent() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        vm.expectEmit(true, true, false, true);
        emit ERC8048.MetadataSet(1, "context", "context", bytes("soul"));
        vm.prank(owner);
        token.setTokenMetadata(1, "context", "soul");
    }

    function testMetadataEmptyWhenUnset() external {
        vm.prank(address(seaDrop));
        seaDrop.mintVia(address(token), alice, 1);
        assertEq(token.metadata(1, "never-set"), bytes(""));
    }

    // ---- helpers ----

    function _freshToken() internal returns (TracesLicenseSeaDrop) {
        address[] memory allowed = new address[](1);
        allowed[0] = address(seaDrop);
        return new TracesLicenseSeaDrop(owner, address(registry), allowed, BASE, address(0xBEEF), 500);
    }
}
