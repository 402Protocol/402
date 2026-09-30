// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicenseSeaDrop} from "../../contracts/TracesLicenseSeaDrop.sol";
import {INonFungibleSeaDropToken} from "../../contracts/seadrop/INonFungibleSeaDropToken.sol";
import {ISeaDropTokenContractMetadata} from "../../contracts/seadrop/ISeaDropTokenContractMetadata.sol";
import {
    PublicDrop,
    AllowListData,
    TokenGatedDropStage,
    SignedMintValidationParams
} from "../../contracts/seadrop/SeaDropStructs.sol";

/// @notice Minimal ERC-8004 identity registry stand-in.
contract MockIdentityRegistry {
    uint256 public nextId = 1;
    mapping(uint256 => address) public owners;

    function register() external returns (uint256 agentId) {
        agentId = nextId++;
        owners[agentId] = msg.sender;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address o = owners[agentId];
        require(o != address(0), "no agent");
        return o;
    }

    function transferAgent(uint256 agentId, address to) external {
        require(owners[agentId] == msg.sender, "not agent owner");
        owners[agentId] = to;
    }
}

/// @notice Mock SeaDrop: records forwarder calls, can mint via mintSeaDrop.
contract MockSeaDrop {
    event CallRecorded(string name);

    string public lastCall;
    address public lastPayout;
    PublicDrop public lastPublicDrop;
    AllowListData public lastAllowList;

    function _record(string memory n) internal {
        lastCall = n;
        emit CallRecorded(n);
    }

    function mintVia(address token, address to, uint256 qty) external {
        INonFungibleSeaDropToken(token).mintSeaDrop(to, qty);
    }

    function updatePublicDrop(PublicDrop calldata d) external {
        lastPublicDrop = d;
        _record("updatePublicDrop");
    }

    function updateAllowList(AllowListData calldata d) external {
        lastAllowList = d;
        _record("updateAllowList");
    }

    function updateTokenGatedDrop(address, TokenGatedDropStage calldata) external {
        _record("updateTokenGatedDrop");
    }

    function updateDropURI(string calldata) external {
        _record("updateDropURI");
    }

    function updateCreatorPayoutAddress(address p) external {
        lastPayout = p;
        _record("updateCreatorPayoutAddress");
    }

    function updateAllowedFeeRecipient(address, bool) external {
        _record("updateAllowedFeeRecipient");
    }

    function updateSignedMintValidationParams(address, SignedMintValidationParams calldata) external {
        _record("updateSignedMintValidationParams");
    }

    function updatePayer(address, bool) external {
        _record("updatePayer");
    }
}

contract TracesSeaDropTest is Test {
    TracesLicenseSeaDrop token;
    MockIdentityRegistry registry;
    MockSeaDrop seaDrop;
    address owner = address(0xA11CE);
    address treasury = address(0xBEEF);
    address alice = address(0xA11A);
    address bob = address(0xB0B);

    string constant BASE = "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/";

    function setUp() external {
        registry = new MockIdentityRegistry();
        seaDrop = new MockSeaDrop();
        address[] memory allowed = new address[](1);
        allowed[0] = address(seaDrop);
        token = new TracesLicenseSeaDrop(
            owner,
            address(registry),
            allowed,
            BASE,
            treasury,
            500
        );
    }

    // ---- constructor ----

    function testConstructorSetsRoyalty() external view {
        (address recv, uint256 amt) = token.royaltyInfo(1, 1 ether);
        assertEq(recv, treasury);
        assertEq(amt, 0.05 ether);
        assertEq(token.royaltyAddress(), treasury);
        assertEq(token.royaltyBasisPoints(), 500);
    }

    function testConstructorRejectsCodelessRegistry() external {
        address[] memory allowed = new address[](1);
        allowed[0] = address(seaDrop);
        vm.expectRevert(TracesLicenseSeaDrop.RegistryNotContract.selector);
        new TracesLicenseSeaDrop(owner, address(0xDEAD), allowed, BASE, treasury, 500);
    }

    function testMaxSupplyInit() external view {
        assertEq(token.maxSupply(), 10_000);
    }

    // ---- SeaDrop interface identity ----

    function testSupportsSeaDropInterface() external view {
        assertTrue(
            token.supportsInterface(type(INonFungibleSeaDropToken).interfaceId)
        );
        assertTrue(
            token.supportsInterface(type(ISeaDropTokenContractMetadata).interfaceId)
        );
    }

    // ---- mintSeaDrop ----

    function testMintSeaDropSequentialFromOne() external {
        vm.prank(address(seaDrop));
        token.mintSeaDrop(alice, 3);
        assertEq(token.ownerOf(1), alice);
        assertEq(token.ownerOf(2), alice);
        assertEq(token.ownerOf(3), alice);
        assertEq(token.nextTokenId(), 4);
        assertEq(token.tokenURI(1), string.concat(BASE, "1.json"));
    }

    function testMintSeaDropRejectsNonSeaDrop() external {
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        token.mintSeaDrop(alice, 1);
    }

    function testMintSeaDropEnforcesMaxSupply() external {
        vm.startPrank(owner);
        token.setMaxSupply(2);
        vm.stopPrank();
        vm.prank(address(seaDrop));
        vm.expectRevert(
            abi.encodeWithSelector(
                TracesLicenseSeaDrop.MintQuantityExceedsMaxSupply.selector, 3, 2
            )
        );
        token.mintSeaDrop(alice, 3);
    }

    function testGetMintStats() external {
        vm.prank(address(seaDrop));
        token.mintSeaDrop(alice, 4);
        (uint256 minted, uint256 total, uint256 max) = token.getMintStats(alice);
        assertEq(minted, 4);
        assertEq(total, 4);
        assertEq(max, 10_000);
    }

    function testMintStatsSurviveTransfers() external {
        // SeaDrop's per-wallet caps must not reset when tokens move:
        // stats track cumulative SeaDrop mints, not current balance.
        vm.prank(address(seaDrop));
        token.mintSeaDrop(alice, 4);
        vm.prank(alice);
        token.transferFrom(alice, bob, 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, 2);
        (uint256 minted,,) = token.getMintStats(alice);
        assertEq(minted, 4);
        assertEq(token.balanceOf(alice), 2);
    }

    // ---- forwarders ----

    function testUpdatePublicDropForwards() external {
        PublicDrop memory d = PublicDrop({
            mintPrice: 0.01 ether,
            startTime: uint48(block.timestamp + 1),
            endTime: uint48(block.timestamp + 1 days),
            maxTotalMintableByWallet: 10,
            feeBps: 0,
            restrictFeeRecipients: false
        });
        vm.prank(owner);
        token.updatePublicDrop(address(seaDrop), d);
        assertEq(seaDrop.lastCall(), "updatePublicDrop");
        (uint80 p,,,,,) = seaDrop.lastPublicDrop();
        assertEq(p, 0.01 ether);
    }

    function testForwarderRejectsNonOwner() external {
        PublicDrop memory d;
        vm.expectRevert();
        token.updatePublicDrop(address(seaDrop), d);
    }

    function testForwarderRejectsUnknownSeaDropImpl() external {
        address fake = address(0xFACADE);
        vm.prank(owner);
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        token.updateCreatorPayoutAddress(fake, treasury);
    }

    function testUpdateCreatorPayoutAddressForwards() external {
        vm.prank(owner);
        token.updateCreatorPayoutAddress(address(seaDrop), treasury);
        assertEq(seaDrop.lastPayout(), treasury);
    }

    function testUpdateAllowedSeaDropRotation() external {
        address[] memory next = new address[](0);
        vm.prank(owner);
        token.updateAllowedSeaDrop(next);
        // old SeaDrop no longer allowed
        vm.prank(address(seaDrop));
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        token.mintSeaDrop(alice, 1);
    }

    // ---- metadata ----

    function testSetBaseURI() external {
        vm.prank(owner);
        token.setBaseURI("ipfs://new/");
        assertEq(token.baseURI(), "ipfs://new/");
    }

    function testSetMaxSupply() external {
        vm.prank(owner);
        token.setMaxSupply(5_000);
        assertEq(token.maxSupply(), 5_000);
    }

    function testSetMaxSupplyCeiling() external {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                TracesLicenseSeaDrop.MaxSupplyExceedsCeiling.selector,
                10_001,
                10_000
            )
        );
        token.setMaxSupply(10_001);
        // 10_000 itself is still allowed; lowering still works
        vm.prank(owner);
        token.setMaxSupply(10_000);
        assertEq(token.maxSupply(), 10_000);
        vm.prank(owner);
        token.setMaxSupply(9_999);
        assertEq(token.maxSupply(), 9_999);
    }

    function testSetMaxSupplyCannotGoBelowMinted() external {
        vm.prank(address(seaDrop));
        token.mintSeaDrop(alice, 5);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISeaDropTokenContractMetadata
                    .NewMaxSupplyCannotBeLessThenTotalMinted
                    .selector,
                4,
                5
            )
        );
        token.setMaxSupply(4);
    }

    function testSetProvenanceHashBeforeMint() external {
        vm.prank(owner);
        token.setProvenanceHash(bytes32(uint256(123)));
        assertEq(token.provenanceHash(), bytes32(uint256(123)));
    }

    function testSetProvenanceHashRevertsAfterMint() external {
        vm.prank(address(seaDrop));
        token.mintSeaDrop(alice, 1);
        vm.prank(owner);
        vm.expectRevert(
            ISeaDropTokenContractMetadata
                .ProvenanceHashCannotBeSetAfterMintStarted
                .selector
        );
        token.setProvenanceHash(bytes32(uint256(1)));
    }

    // ---- team allocation ----
    // Team allocation moved to SeaDrop: the team wallets are zero-price
    // leaves in the allowlist Merkle tree (cap 100). The contract no longer
    // mints — every token flows through mintSeaDrop. This test pins that
    // the owner has no mint path at all.
    function testOwnerCannotMintDirectly() external {
        vm.prank(owner);
        vm.expectRevert(INonFungibleSeaDropToken.OnlyAllowedSeaDrop.selector);
        token.mintSeaDrop(owner, 1);
        assertEq(token.totalSupply(), 0);
    }

    // ---- pairing ----

    function _mintAndPair(address who)
        internal
        returns (uint256 tokenId, uint256 agentId)
    {
        vm.prank(address(seaDrop));
        token.mintSeaDrop(who, 1);
        tokenId = token.nextTokenId() - 1;
        vm.prank(who);
        agentId = registry.register();
        vm.prank(who);
        token.pairSeat(tokenId, agentId);
    }

    function testPairSeat() external {
        (uint256 tid, uint256 aid) = _mintAndPair(alice);
        assertEq(token.seatToAgent(tid), aid);
        assertEq(token.agentToSeat(aid), tid);
    }

    function testPairSeatRejectsDoublePair() external {
        (uint256 tid,) = _mintAndPair(alice);
        vm.prank(alice);
        uint256 aid2 = registry.register();
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.SeatAlreadyPaired.selector);
        token.pairSeat(tid, aid2);
    }

    function testRepairSeatCooldown() external {
        (uint256 tid,) = _mintAndPair(alice);
        vm.prank(alice);
        uint256 aid2 = registry.register();
        // immediate repair must fail: pairSeat started the cooldown
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.repairSeat(tid, aid2);
        // after 72h it works
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(alice);
        token.repairSeat(tid, aid2);
        assertEq(token.seatToAgent(tid), aid2);
    }

    function testPairSeatCooldownBlocksRotationAttack() external {
        // H-1 fix: pair -> transfer -> pair in the same block must fail
        (uint256 tid,) = _mintAndPair(alice);
        vm.prank(alice);
        token.transferFrom(alice, bob, tid); // auto-clears pairing
        assertEq(token.seatToAgent(tid), 0);
        vm.prank(bob);
        uint256 bobAgent = registry.register();
        vm.prank(bob);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(tid, bobAgent);
        // after cooldown, the legit buyer pairs fine
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(bob);
        token.pairSeat(tid, bobAgent);
        assertEq(token.seatToAgent(tid), bobAgent);
    }

    function testTransferAutoClearsPairing() external {
        (uint256 tid, uint256 aid) = _mintAndPair(alice);
        vm.prank(alice);
        token.transferFrom(alice, bob, tid);
        assertEq(token.seatToAgent(tid), 0);
        assertEq(token.agentToSeat(aid), 0);
        assertEq(token.ownerOf(tid), bob);
    }

    function testClearStalePairing() external {
        // Alice pairs seat 1 <-> agent 1, then transfers the AGENT to Bob.
        // The seat stays with Alice; Bob's agent is bricked until cleared.
        (uint256 tid, uint256 aid) = _mintAndPair(alice);
        vm.prank(alice);
        registry.transferAgent(aid, bob);
        // Bob clears the stale pairing from the agent side.
        vm.prank(bob);
        token.clearStalePairing(aid);
        assertEq(token.seatToAgent(tid), 0);
        assertEq(token.agentToSeat(aid), 0);
        // Bob can now pair his agent with a seat he owns.
        vm.prank(address(seaDrop));
        token.mintSeaDrop(bob, 1);
        uint256 bobSeat = token.nextTokenId() - 1;
        vm.warp(block.timestamp + 72 hours + 1); // seat 1's clock untouched by clear
        vm.prank(bob);
        token.pairSeat(bobSeat, aid);
        assertEq(token.seatToAgent(bobSeat), aid);
    }

    function testClearStalePairingDoesNotResetSeatCooldown() external {
        // Clearing must be cleanup, not a rotation bypass: Alice's seat
        // keeps its original 72h clock even after Bob clears.
        (uint256 tid, uint256 aid) = _mintAndPair(alice);
        vm.prank(alice);
        registry.transferAgent(aid, bob);
        vm.prank(bob);
        token.clearStalePairing(aid);
        vm.prank(alice);
        uint256 aliceAgent2 = registry.register();
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.PairCooldown.selector);
        token.pairSeat(tid, aliceAgent2);
        vm.warp(block.timestamp + 72 hours + 1);
        vm.prank(alice);
        token.pairSeat(tid, aliceAgent2);
        assertEq(token.seatToAgent(tid), aliceAgent2);
    }

    function testClearStalePairingRejectsNonAgentOwner() external {
        (, uint256 aid) = _mintAndPair(alice);
        vm.prank(alice);
        registry.transferAgent(aid, bob);
        vm.prank(alice); // Alice no longer owns the agent
        vm.expectRevert(TracesLicenseSeaDrop.NotAgentOwner.selector);
        token.clearStalePairing(aid);
    }

    function testClearStalePairingRejectsSeatOwner() external {
        // The seat owner must use repairSeat, not the agent-side clear.
        (uint256 tid, uint256 aid) = _mintAndPair(alice);
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.PairingNotStale.selector);
        token.clearStalePairing(aid);
        assertEq(token.seatToAgent(tid), aid); // untouched
    }

    function testClearStalePairingRejectsUnpaired() external {
        vm.prank(alice);
        uint256 aid = registry.register();
        vm.prank(alice);
        vm.expectRevert(TracesLicenseSeaDrop.SeatNotPaired.selector);
        token.clearStalePairing(aid);
    }

    function testEnumerableSeatDiscovery() external {
        vm.prank(address(seaDrop));
        token.mintSeaDrop(alice, 3);
        assertEq(token.balanceOf(alice), 3);
        assertEq(token.tokenOfOwnerByIndex(alice, 0), 1);
        assertEq(token.tokenOfOwnerByIndex(alice, 2), 3);
    }
}
