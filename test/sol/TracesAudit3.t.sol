// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Controllable stand-in for the canonical ERC-8004 Identity Registry.
contract A3MockRegistry {
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
contract A3MockUSDC {
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

/// @notice Malicious ERC-20: tries to reenter whitelistMint during the
///         payment pull, before the outer call finishes.
contract A3EvilUSDC {
    TracesLicense public traces;
    bool public armed;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setTraces(TracesLicense t) external {
        traces = t;
    }

    function arm() external {
        armed = true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (armed) {
            armed = false;
            // Reenter the whitelist mint mid-payment: attempt a double claim
            // of the same terminal before the outer call settles.
            try traces.whitelistMint(7, new bytes32[](0)) {} catch {}
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @title TRACES Audit 3 — adversarial security audit (post-P0-fix)
/// @notice Verifies each P0 fix holds under attack, then hunts for new
///         issues in the changed code: merkle/phase edge cases, cooldown
///         bypasses, auto-clear interplay, constructor validation.
///         Read-only: the contract is never modified.
contract TracesAudit3Test is Test {
    TracesLicense internal traces;
    A3MockRegistry internal registry;
    A3MockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal payer = address(0xCAFE);
    address internal alice = address(0xA11C3);
    address internal bob = address(0xB0B);
    address internal attacker = address(0xBAD);

    uint256 internal constant WL_PRICE = 10_000_000;
    uint256 internal constant PUBLIC_PRICE = 12_000_000;

    function setUp() public {
        registry = new A3MockRegistry();
        usdc = new A3MockUSDC();
        traces = new TracesLicense(
            owner, address(usdc), treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", address(registry)
        );
    }

    // -- helpers -----------------------------------------------------------

    function _leaf(address wallet, uint256 terminalId) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wallet, terminalId))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(traces), amount);
    }

    function _openMint() internal {
        vm.prank(owner);
        traces.setMintOpen(true);
    }

    /// @dev Configures a 2-leaf whitelist tree (alice:7, bob:42) with an
    ///      active window starting now. Returns alice's and bob's proofs.
    function _setupWl2() internal returns (bytes32[] memory proofAlice, bytes32[] memory proofBob) {
        bytes32 leafA = _leaf(alice, 7);
        bytes32 leafB = _leaf(bob, 42);
        bytes32 root = _hashPair(leafA, leafB);
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 7 days);
        vm.startPrank(owner);
        traces.setWhitelistMerkleRoot(root);
        traces.setWhitelistWindow(start, end);
        traces.setMintOpen(true);
        vm.stopPrank();
        proofAlice = new bytes32[](1);
        proofAlice[0] = leafB;
        proofBob = new bytes32[](1);
        proofBob[0] = leafA;
    }

    // ------------------------------------------------------------------
    // P0-1 verification: merkle whitelist enforcement
    // ------------------------------------------------------------------

    function test_P0_WLMerkleEnforcement() public {
        (bytes32[] memory proofAlice,) = _setupWl2();

        // member claims at the WL price
        _fund(alice, WL_PRICE);
        vm.prank(alice);
        traces.whitelistMint(7, proofAlice);
        assertEq(traces.ownerOf(1), alice);
        assertTrue(traces.terminalClaimed(7));

        // double claim of the same terminal reverts
        vm.prank(alice);
        vm.expectRevert(TracesLicense.TerminalAlreadyClaimed.selector);
        traces.whitelistMint(7, proofAlice);

        // non-member with a garbage proof reverts (unclaimed terminal id)
        bytes32[] memory garbage = new bytes32[](1);
        garbage[0] = bytes32(uint256(0xDEAD));
        _fund(payer, WL_PRICE);
        vm.prank(payer);
        vm.expectRevert(TracesLicense.InvalidProof.selector);
        traces.whitelistMint(999, garbage);

        // public mint is closed during the WL window, even for members
        _fund(bob, PUBLIC_PRICE);
        vm.prank(bob);
        vm.expectRevert(TracesLicense.WhitelistPhaseActive.selector);
        traces.mint(bob);
    }

    function test_P0_ProofReplayAcrossWalletsFails() public {
        (bytes32[] memory proofAlice,) = _setupWl2();

        // bob replays alice's exact proof but the leaf binds msg.sender
        _fund(bob, WL_PRICE);
        vm.prank(bob);
        vm.expectRevert(TracesLicense.InvalidProof.selector);
        traces.whitelistMint(7, proofAlice);
    }

    // ------------------------------------------------------------------
    // P0-2 verification: auto-clear on transfer
    // ------------------------------------------------------------------

    function test_P0_AutoClearOnTransfer() public {
        uint256 agentId = registry.register(alice);
        uint256 buyerAgent = registry.register(bob);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, agentId);

        vm.prank(alice);
        traces.transferFrom(alice, bob, 1);

        assertEq(traces.seatToAgent(1), 0, "pairing cleared");
        assertEq(traces.agentToSeat(agentId), 0, "reverse pairing cleared");

        // buyer's seat arrives clean: direct activation, no repair needed
        vm.prank(bob);
        traces.pairSeat(1, buyerAgent);
        assertEq(traces.seatToAgent(1), buyerAgent);
    }

    // ------------------------------------------------------------------
    // P0-3 verification: cooldown blocks serial repairSeat
    // ------------------------------------------------------------------

    function test_P0_CooldownBlocksSerialRepairSeat() public {
        uint256 a1 = registry.register(alice);
        uint256 a2 = registry.register(alice);
        uint256 a3 = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, a1);

        vm.prank(alice);
        traces.repairSeat(1, a2); // first repair: free
        assertEq(traces.seatToAgent(1), a2);

        vm.prank(alice);
        vm.expectRevert(TracesLicense.RepairCooldown.selector);
        traces.repairSeat(1, a3); // serial rotation blocked

        vm.warp(block.timestamp + 72 hours);
        vm.prank(alice);
        traces.repairSeat(1, a3); // after cooldown: works
        assertEq(traces.seatToAgent(1), a3);
    }

    // ------------------------------------------------------------------
    // P0 verification: reentrancy during the WL payment pull
    // ------------------------------------------------------------------

    function test_P0_ReentrancyOnWhitelistMintBlocked() public {
        A3EvilUSDC evil = new A3EvilUSDC();
        TracesLicense t2 = new TracesLicense(
            owner, address(evil), treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", address(registry)
        );
        evil.setTraces(t2);

        bytes32 leaf = _leaf(attacker, 7);
        uint64 start = uint64(block.timestamp);
        vm.startPrank(owner);
        t2.setWhitelistMerkleRoot(leaf);
        t2.setWhitelistWindow(start, start + 7 days);
        t2.setMintOpen(true);
        vm.stopPrank();

        evil.mint(attacker, WL_PRICE);
        vm.prank(attacker);
        evil.approve(address(t2), WL_PRICE);

        evil.arm();
        vm.prank(attacker);
        t2.whitelistMint(7, new bytes32[](0)); // evil token reenters mid-call

        // exactly one seat, one payment: no double claim, no double pull
        assertEq(t2.totalSupply(), 1);
        assertEq(t2.ownerOf(1), attacker);
        assertTrue(t2.terminalClaimed(7));
        assertEq(evil.balanceOf(treasury), WL_PRICE);
        assertEq(evil.balanceOf(attacker), 0);
    }

    // ------------------------------------------------------------------
    // P0 verification: phase boundary timestamps
    // ------------------------------------------------------------------

    function test_P0_PhaseBoundaries() public {
        (bytes32[] memory proofAlice,) = _setupWl2();
        uint64 start = traces.whitelistStart();
        uint64 end = traces.whitelistEnd();

        // before the window: WL inactive, public closed (window configured)
        vm.warp(start - 1);
        _fund(alice, WL_PRICE);
        vm.prank(alice);
        vm.expectRevert(TracesLicense.WhitelistNotActive.selector);
        traces.whitelistMint(7, proofAlice);
        vm.prank(alice);
        vm.expectRevert(TracesLicense.MintClosed.selector);
        traces.mint(alice);

        // window is inclusive on both ends
        vm.warp(start);
        vm.prank(alice);
        traces.whitelistMint(7, proofAlice);
        assertEq(traces.ownerOf(1), alice);

        vm.warp(end);
        _fund(bob, WL_PRICE);
        // bob already used terminal 42? no — fresh claim at the last second
        (, bytes32[] memory proofBob) = _setupWl2b();
        vm.prank(bob);
        traces.whitelistMint(42, proofBob);
        assertEq(traces.ownerOf(2), bob);

        // one second after end: WL closed, public open at $12
        vm.warp(end + 1);
        _fund(payer, PUBLIC_PRICE + WL_PRICE);
        vm.prank(payer);
        vm.expectRevert(TracesLicense.WhitelistNotActive.selector);
        traces.whitelistMint(42, proofBob);
        vm.prank(payer);
        traces.mint(payer);
        assertEq(traces.ownerOf(3), payer);
        assertEq(usdc.balanceOf(treasury), WL_PRICE * 2 + PUBLIC_PRICE);
    }

    /// @dev Rebuilds the same 2-leaf tree (for use after time warps).
    function _setupWl2b() internal view returns (bytes32[] memory proofAlice, bytes32[] memory proofBob) {
        bytes32 leafA = _leaf(alice, 7);
        bytes32 leafB = _leaf(bob, 42);
        proofAlice = new bytes32[](1);
        proofAlice[0] = leafB;
        proofBob = new bytes32[](1);
        proofBob[0] = leafA;
    }

    // ==================================================================
    // NEW FINDINGS
    // ==================================================================

    // ------------------------------------------------------------------
    // A3-H1: Cooldown bypass via transfer + pairSeat rotation.
    // pairSeat has NO cooldown check, and the P0 auto-clear hands out a
    // free unpair on every transfer — so the 72h repairSeat cooldown is
    // fully evaded by rotating: pair -> (self-)transfer -> pair -> ...
    // All in the same block, at ~2x gas per rotation instead of 1x.
    // ------------------------------------------------------------------

    function test_A3H1_CooldownBypassViaSelfTransferPairRotation() public {
        uint256 a1 = registry.register(attacker);
        uint256 a2 = registry.register(attacker);
        uint256 a3 = registry.register(attacker);
        _openMint();
        _fund(attacker, PUBLIC_PRICE);

        vm.startPrank(attacker);
        traces.mint(attacker);
        traces.pairSeat(1, a1);
        assertEq(traces.seatToAgent(1), a1, "licensed as agent 1");

        // Rotation 1: self-transfer auto-clears; pairSeat never checks cooldown.
        traces.transferFrom(attacker, attacker, 1);
        assertEq(traces.seatToAgent(1), 0, "cleared by transfer");
        traces.pairSeat(1, a2);
        assertEq(traces.seatToAgent(1), a2, "licensed as agent 2, no cooldown");

        // Rotation 2: same block, still no cooldown.
        traces.transferFrom(attacker, attacker, 1);
        traces.pairSeat(1, a3);
        assertEq(traces.seatToAgent(1), a3, "licensed as agent 3, no cooldown");
        vm.stopPrank();

        // Three serial licenses, zero seconds elapsed: the 72h cooldown
        // that was supposed to kill license multiplexing never fired.
        assertEq(traces.agentToSeat(a3), 1);
        assertEq(traces.agentToSeat(a1), 0);
        assertEq(traces.agentToSeat(a2), 0);
    }

    function test_A3H1_TwoWalletPingPongRotation() public {
        uint256 a1 = registry.register(alice);
        uint256 b1 = registry.register(bob);
        uint256 a2 = registry.register(alice);
        _openMint();
        _fund(alice, PUBLIC_PRICE);

        vm.prank(alice);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, a1);

        // alice -> bob: pairing auto-clears, bob pairs for free
        vm.prank(alice);
        traces.transferFrom(alice, bob, 1);
        vm.prank(bob);
        traces.pairSeat(1, b1);
        assertEq(traces.seatToAgent(1), b1);

        // bob -> alice: pairing auto-clears, alice pairs a THIRD agent, free
        vm.prank(bob);
        traces.transferFrom(bob, alice, 1);
        vm.prank(alice);
        traces.pairSeat(1, a2);
        assertEq(traces.seatToAgent(1), a2, "third agent licensed, cooldown never checked");
    }

    // ------------------------------------------------------------------
    // A3-L1: constructor checks the registry for code but NOT the payment
    // token. Deploying with an EOA payment token bricks all paid mints
    // (SafeERC20 reverts) — inconsistent validation, deploy-time footgun.
    // Proves it bricks (reverts) rather than allowing free mints.
    // ------------------------------------------------------------------

    function test_A3L1_EoaPaymentTokenBricksPaidMints() public {
        address eoaToken = address(0xE0A);
        TracesLicense t2 = new TracesLicense(
            owner, eoaToken, treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", address(registry)
        );
        vm.prank(owner);
        t2.setMintOpen(true);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, eoaToken)
        );
        t2.mint(payer);

        assertEq(t2.totalSupply(), 0, "no free mint: it reverts, but the deploy is bricked");
    }

    // ------------------------------------------------------------------
    // A3-L2: lastRepairAt persists across transfers by design — so a
    // secondhand buyer INHERITS the seller's cooldown clock. Buy, pair,
    // then immediately rotate agents -> RepairCooldown from the seller's
    // repair, even though the buyer never repaired anything.
    // ------------------------------------------------------------------

    function test_A3L2_BuyerInheritsSellerCooldown() public {
        uint256 a1 = registry.register(alice);
        uint256 a2 = registry.register(alice);
        uint256 b1 = registry.register(bob);
        uint256 b2 = registry.register(bob);
        _openMint();
        _fund(alice, PUBLIC_PRICE);

        vm.prank(alice);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, a1);
        vm.prank(alice);
        traces.repairSeat(1, a2); // seller's repair starts the 72h clock

        // immediate secondary sale; buyer's seat arrives clean
        vm.prank(alice);
        traces.transferFrom(alice, bob, 1);
        vm.prank(bob);
        traces.pairSeat(1, b1); // free activation: fine

        // ...but the buyer cannot rotate agents: seller's clock still runs
        vm.prank(bob);
        vm.expectRevert(TracesLicense.RepairCooldown.selector);
        traces.repairSeat(1, b2);
    }

    // ------------------------------------------------------------------
    // A3-I1 (informational): a self-transfer (from == to) still trips the
    // auto-clear — a holder can wipe their own pairing with a no-op transfer.
    // Documented tradeoff of clearing on every real transfer.
    // ------------------------------------------------------------------

    function test_A3I1_SelfTransferWipesOwnPairing() public {
        uint256 agentId = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, agentId);
        assertEq(traces.ownerOf(1), alice);

        vm.prank(alice);
        traces.transferFrom(alice, alice, 1); // ownership unchanged...

        assertEq(traces.ownerOf(1), alice);
        assertEq(traces.seatToAgent(1), 0, "...but the pairing is gone");
        assertEq(traces.agentToSeat(agentId), 0);
    }
}
