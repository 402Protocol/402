// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";

/// @notice 8004 registry stand-in WITH agent transfers (the real Identity
///         Registry is ERC-721: agent identities are transferable).
contract Audit2MockRegistry {
    mapping(uint256 => address) private _owners;
    uint256 private _nextId = 1;

    function register(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _owners[id] = to;
        return id;
    }

    function transferAgent(uint256 agentId, address to) external {
        require(_owners[agentId] == msg.sender, "not agent owner");
        _owners[agentId] = to;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _owners[agentId];
    }
}

/// @notice Minimal mintable ERC-20 (6 decimals, like USDC).
contract Audit2MockUSDC {
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

/// @title TRACES Audit 2 — mechanism-design demos (economics)
/// @notice Demonstrates license-multiplexing, license rental via agent
///         transfer, and team self-dealing. Analytical findings (whitelist
///         design, snapshot timing, royalty evasion, wash trading) are in
///         the report; these tests prove the onchain mechanisms behind them.
contract TracesAudit2Test is Test {
    TracesLicense internal traces;
    Audit2MockRegistry internal registry;
    Audit2MockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal payer = address(0xCAFE);
    address internal alice = address(0xA11C3);
    address internal bob = address(0xB0B);

    uint256 internal constant WL_PRICE = 10_000_000; // $10.00 whitelist
    uint256 internal constant PUBLIC_PRICE = 12_000_000; // $12.00 public

    function setUp() public {
        registry = new Audit2MockRegistry();
        usdc = new Audit2MockUSDC();
        traces = new TracesLicense(
            owner, address(usdc), treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", address(registry)
        );
    }

    function _openMint() internal {
        vm.prank(owner);
        traces.setMintOpen(true);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(traces), amount);
    }

    /// @notice Simulates the naive job-board eligibility check
    ///         "agent has a paired seat" (agentToSeat[agentId] != 0).
    function _naiveEligible(uint256 agentId) internal view returns (bool) {
        return traces.agentToSeat(agentId) != 0;
    }

    /// @notice The hardened check the report recommends: the same EOA must
    ///         own both the seat and the agent identity.
    function _hardenedEligible(uint256 agentId) internal view returns (bool) {
        uint256 seatId = traces.agentToSeat(agentId);
        if (seatId == 0) return false;
        return
            traces.ownerOf(seatId) == registry.ownerOf(agentId) &&
            traces.seatToAgent(seatId) == agentId;
    }

    // ------------------------------------------------------------------
    // FIX-Demo-1 (was Demo-1): LICENSE MULTIPLEXING IS BLOCKED. repairSeat
    // now carries a 72h per-seat cooldown, so one seat can no longer be
    // serially rotated across unlimited agents at gas cost. Regression test
    // for the audit finding.
    // ------------------------------------------------------------------
    function test_FixDemo1_LicenseMultiplexingBlocked() public {
        uint256 a1 = registry.register(alice);
        uint256 a2 = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice); // ONE seat

        vm.startPrank(alice);
        traces.pairSeat(1, a1);
        assertTrue(_naiveEligible(a1), "agent 1 licensed");

        // First rotation is free (legit re-pair UX)...
        traces.repairSeat(1, a2);
        assertTrue(_naiveEligible(a2), "agent 2 licensed with same seat");
        assertFalse(_naiveEligible(a1), "agent 1 dropped");

        // ...but the second rotation inside 72h reverts. Multiplexing dead.
        vm.expectRevert(TracesLicense.RepairCooldown.selector);
        traces.repairSeat(1, a1);
        vm.stopPrank();

        // After the cooldown, legitimate re-pairing works again.
        vm.warp(block.timestamp + 72 hours);
        vm.prank(alice);
        traces.repairSeat(1, a1);
        assertTrue(_naiveEligible(a1));
        assertTrue(_hardenedEligible(a1));
    }

    // ------------------------------------------------------------------
    // Demo-2: LICENSE RENTAL via agent-identity transfer. Alice pairs
    // seat->agent, then transfers the AGENT identity (ERC-721) to Bob.
    // Bob now controls a "licensed" agent while owning no seat. The naive
    // check still passes; the hardened check catches it.
    // ------------------------------------------------------------------
    function test_Demo2_RentalViaAgentTransfer() public {
        uint256 agentId = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, agentId);
        assertTrue(_naiveEligible(agentId));

        // Alice rents out the license: transfers the agent identity to Bob,
        // keeps the seat herself.
        vm.prank(alice);
        registry.transferAgent(agentId, bob);

        assertEq(registry.ownerOf(agentId), bob, "bob owns the agent now");
        assertEq(traces.ownerOf(1), alice, "alice still owns the seat");
        assertTrue(_naiveEligible(agentId), "NAIVE CHECK STILL PASSES: rented license works");
        assertFalse(
            _hardenedEligible(agentId),
            "hardened check rejects: seat owner != agent owner"
        );
    }

    // ------------------------------------------------------------------
    // Demo-3: TEAM SELF-DEALING. 100 free team mints + free agent
    // registrations = a 100-"licensed"-agent swarm for gas money. The
    // mechanism for faking worker activity exists natively.
    // ------------------------------------------------------------------
    function test_Demo3_TeamSelfDealing() public {
        // Owner spreads 100 free seats across 10 wallets (10/wallet cap).
        for (uint256 w = 0; w < 10; ++w) {
            address wallet = address(uint160(0x7000 + w));
            for (uint256 i = 0; i < 10; ++i) {
                vm.prank(owner);
                traces.teamMint(wallet);
            }
            // Each wallet registers one agent and pairs one seat.
            uint256 agentId = registry.register(wallet);
            vm.prank(wallet);
            traces.pairSeat(w * 10 + 1, agentId);
            assertTrue(_naiveEligible(agentId));
        }
        assertEq(traces.teamMinted(), 100);
        assertEq(usdc.balanceOf(treasury), 0, "zero USDC spent");
    }

    // ------------------------------------------------------------------
    // FIX-Demo-4 (was Demo-4): POINT-IN-TIME pairing now has a 72h
    // cooldown — repairSeat can no longer be called back-to-back in the
    // same block. Regression test for the audit finding.
    // ------------------------------------------------------------------
    function test_FixDemo4_RepairCooldownEnforced() public {
        uint256 a1 = registry.register(alice);
        uint256 a2 = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);

        vm.startPrank(alice);
        traces.pairSeat(1, a1);
        traces.repairSeat(1, a2); // first repair: free
        vm.expectRevert(TracesLicense.RepairCooldown.selector);
        traces.repairSeat(1, a1); // same block: reverts now
        vm.stopPrank();

        assertEq(traces.seatToAgent(1), a2);
    }
}
