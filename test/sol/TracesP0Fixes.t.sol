// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";

/// @notice Controllable stand-in for the canonical ERC-8004 Identity Registry.
contract P0MockRegistry {
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
contract P0MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @title TRACES P0 fixes — regression suite for the 2026-09-28 double audit
/// @notice Covers the three founder-approved fixes:
///         1. Merkle whitelist + contract-enforced phases + rollover
///            (surprise snapshot; each terminal claims once)
///         2. Pairings auto-clear on transfer (license follows the holder)
///         3. 72h repairSeat cooldown (no license multiplexing)
///         Plus the small hardening items: setBaseURI, registry code check.
contract TracesP0FixesTest is Test {
    TracesLicense internal traces;
    P0MockRegistry internal registry;
    P0MockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal alice = address(0xA11C3);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);
    address internal dave = address(0xDA9E);

    uint256 internal constant WL_PRICE = 10_000_000;
    uint256 internal constant PUBLIC_PRICE = 12_000_000;

    // Whitelist fixture: 4 terminals across 4 wallets.
    address[4] internal wlWallets;
    uint256[4] internal wlTerminals = [uint256(7), 42, 100, 101];
    bytes32 internal wlRoot;
    bytes32[][4] internal wlProofs;

    function setUp() public {
        registry = new P0MockRegistry();
        usdc = new P0MockUSDC();
        traces = new TracesLicense(
            owner, address(usdc), treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", address(registry)
        );
        wlWallets = [alice, bob, carol, dave];
        _buildWhitelistTree();
    }

    // -- Merkle helpers (mirror OZ sorted-pair hashing) --------------------

    function _leaf(address wallet, uint256 terminalId) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wallet, terminalId))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _buildWhitelistTree() internal {
        bytes32[4] memory leaves = [
            _leaf(wlWallets[0], wlTerminals[0]),
            _leaf(wlWallets[1], wlTerminals[1]),
            _leaf(wlWallets[2], wlTerminals[2]),
            _leaf(wlWallets[3], wlTerminals[3])
        ];
        // sort leaves ascending
        for (uint256 i = 0; i < 4; ++i) {
            for (uint256 j = i + 1; j < 4; ++j) {
                if (leaves[j] < leaves[i]) {
                    (leaves[i], leaves[j]) = (leaves[j], leaves[i]);
                }
            }
        }
        bytes32 h01 = _hashPair(leaves[0], leaves[1]);
        bytes32 h23 = _hashPair(leaves[2], leaves[3]);
        wlRoot = _hashPair(h01, h23);
        // proofs: leaf -> [sibling, uncle]
        for (uint256 k = 0; k < 4; ++k) {
            bytes32 target = _leaf(wlWallets[k], wlTerminals[k]);
            bytes32 sibling;
            bytes32 uncle;
            if (target == leaves[0]) { sibling = leaves[1]; uncle = h23; }
            else if (target == leaves[1]) { sibling = leaves[0]; uncle = h23; }
            else if (target == leaves[2]) { sibling = leaves[3]; uncle = h01; }
            else { sibling = leaves[2]; uncle = h01; }
            wlProofs[k].push(sibling);
            wlProofs[k].push(uncle);
        }
    }

    function _openWhitelist(uint64 start, uint64 end) internal {
        vm.startPrank(owner);
        traces.setWhitelistMerkleRoot(wlRoot);
        traces.setWhitelistWindow(start, end);
        traces.setMintOpen(true);
        vm.stopPrank();
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(traces), amount);
    }

    // -- Whitelist lifecycle -------------------------------------------------

    function test_WhitelistMultiLeafTreeVerifies() public {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(start, end);
        vm.warp(start);

        // a non-member's proof fails even for a real terminal id
        address erin = address(0xE121);
        _fund(erin, WL_PRICE);
        vm.prank(erin);
        vm.expectRevert(TracesLicense.InvalidProof.selector);
        traces.whitelistMint(wlTerminals[0], wlProofs[0]);

        // alice cannot reuse bob's proof (leaf binds the wallet)
        _fund(alice, WL_PRICE);
        vm.prank(alice);
        vm.expectRevert(TracesLicense.InvalidProof.selector);
        traces.whitelistMint(wlTerminals[1], wlProofs[1]);

        // every whitelisted wallet claims its terminal's seat at $10
        for (uint256 k = 0; k < 4; ++k) {
            if (k != 0) _fund(wlWallets[k], WL_PRICE);
            vm.prank(wlWallets[k]);
            traces.whitelistMint(wlTerminals[k], wlProofs[k]);
            assertEq(traces.ownerOf(k + 1), wlWallets[k]);
        }
        assertEq(usdc.balanceOf(treasury), WL_PRICE * 4);
    }

    function test_WhitelistRolloverToPublic() public {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(start, end);
        vm.warp(start);

        // only 2 of 4 whitelist members claim
        for (uint256 k = 0; k < 2; ++k) {
            _fund(wlWallets[k], WL_PRICE);
            vm.prank(wlWallets[k]);
            traces.whitelistMint(wlTerminals[k], wlProofs[k]);
        }

        // after the window: whitelist closed, public opens at $12.
        // unclaimed allocation is just remaining supply — nothing reserved.
        vm.warp(end + 1);
        address stranger = address(0x57A);
        _fund(stranger, PUBLIC_PRICE);
        vm.prank(stranger);
        vm.expectRevert(TracesLicense.WhitelistNotActive.selector);
        traces.whitelistMint(wlTerminals[2], wlProofs[2]);

        vm.prank(stranger);
        traces.mint(stranger);
        assertEq(traces.ownerOf(3), stranger);
        assertEq(usdc.balanceOf(treasury), WL_PRICE * 2 + PUBLIC_PRICE);
    }

    function test_WhitelistMintCountsTowardWalletCap() public {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(start, end);
        vm.warp(start);

        // alice claims her 1 whitelist seat, then fills to the cap publicly
        _fund(alice, WL_PRICE + PUBLIC_PRICE * 9);
        vm.prank(alice);
        traces.whitelistMint(wlTerminals[0], wlProofs[0]);
        vm.warp(end + 1);
        vm.prank(alice);
        traces.mintBatch(alice, 9);
        assertEq(traces.balanceOf(alice), 10);

        vm.prank(alice);
        vm.expectRevert(TracesLicense.WalletCapExceeded.selector);
        traces.mint(alice);
    }

    function test_TeamMintWorksDuringWhitelist() public {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(start, end);
        vm.warp(start);

        vm.prank(owner);
        traces.teamMint(carol);
        assertEq(traces.ownerOf(1), carol);
        assertEq(traces.teamMinted(), 1);
    }

    function test_WhitelistParamsLockAfterStart() public {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(start, end);

        // before start: owner can still adjust
        vm.prank(owner);
        traces.setWhitelistPrice(9_000_000);
        assertEq(traces.whitelistPrice(), 9_000_000);

        vm.warp(start);

        // after start: root, window, and price are all locked
        vm.prank(owner);
        vm.expectRevert(TracesLicense.WhitelistLocked.selector);
        traces.setWhitelistMerkleRoot(bytes32(uint256(1)));
        vm.prank(owner);
        vm.expectRevert(TracesLicense.WhitelistLocked.selector);
        traces.setWhitelistWindow(uint64(block.timestamp), uint64(block.timestamp + 1));
        vm.prank(owner);
        vm.expectRevert(TracesLicense.WhitelistLocked.selector);
        traces.setWhitelistPrice(1);
    }

    function test_WhitelistWindowValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(TracesLicense.InvalidWindow.selector);
        traces.setWhitelistWindow(0, 100); // zero start
        vm.expectRevert(TracesLicense.InvalidWindow.selector);
        traces.setWhitelistWindow(100, 100); // end <= start
        vm.expectRevert(TracesLicense.InvalidWindow.selector);
        traces.setWhitelistWindow(200, 100); // end < start
        vm.stopPrank();
    }

    // -- Constructor hardening ----------------------------------------------

    function test_ConstructorRevertsOnEoaRegistry() public {
        address eoa = address(0xE0A);
        vm.expectRevert(TracesLicense.RegistryNotContract.selector);
        new TracesLicense(
            owner, address(usdc), treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", eoa
        );
    }

    // -- Auto-clear + cooldown integration -----------------------------------

    function test_SecondhandBuyerFlowEndToEnd() public {
        // alice mints + pairs, sells to bob; bob's seat is clean and he
        // activates immediately with pairSeat (no repair, no cooldown).
        uint256 aliceAgent = registry.register(alice);
        uint256 bobAgent = registry.register(bob);

        vm.prank(owner);
        traces.setMintOpen(true);
        _fund(alice, PUBLIC_PRICE);
        vm.prank(alice);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, aliceAgent);

        vm.prank(alice);
        traces.transferFrom(alice, bob, 1);
        assertEq(traces.seatToAgent(1), 0, "clean on arrival");

        vm.prank(bob);
        traces.pairSeat(1, bobAgent);
        assertEq(traces.seatToAgent(1), bobAgent);
        assertEq(traces.agentToSeat(bobAgent), 1);
    }

    function test_SafeTransferAlsoClears() public {
        uint256 aliceAgent = registry.register(alice);
        vm.prank(owner);
        traces.setMintOpen(true);
        _fund(alice, PUBLIC_PRICE);
        vm.prank(alice);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, aliceAgent);

        vm.prank(alice);
        traces.safeTransferFrom(alice, bob, 1);
        assertEq(traces.seatToAgent(1), 0);
        assertEq(traces.agentToSeat(aliceAgent), 0);
    }
}
