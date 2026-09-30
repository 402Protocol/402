// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";

/// @notice Controllable stand-in for the canonical ERC-8004 Identity Registry,
///         WITH agent transfers (the real registry is ERC-721: agent
///         identities are transferable).
contract Audit4MockRegistry {
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
contract Audit4MockUSDC {
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

/// @title TRACES Audit 4 — mechanism/economics adversarial audit (post-P0-fix)
/// @notice Attacks the INTERACTIONS of the P0 fixes and hunts for new
///         mechanism/economic issues. Read-only audit: the contract is never
///         modified. Each test is a self-contained PoC.
contract TracesAudit4Test is Test {
    TracesLicense internal traces;
    Audit4MockRegistry internal registry;
    Audit4MockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal payer = address(0xCAFE);
    address internal alice = address(0xA11C3);
    address internal bob = address(0xB0B);

    uint256 internal constant WL_PRICE = 10_000_000; // $10.00
    uint256 internal constant PUBLIC_PRICE = 12_000_000; // $12.00

    function setUp() public {
        registry = new Audit4MockRegistry();
        usdc = new Audit4MockUSDC();
        traces = new TracesLicense(
            owner, address(usdc), treasury, WL_PRICE, PUBLIC_PRICE, "ipfs://cid/", address(registry)
        );
    }

    // -- helpers ------------------------------------------------------------

    function _openMint() internal {
        vm.prank(owner);
        traces.setMintOpen(true);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(traces), amount);
    }

    function _leaf(address wallet, uint256 terminalId) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wallet, terminalId))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b
            ? keccak256(abi.encodePacked(a, b))
            : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Builds a merkle tree over a power-of-2 leaf set (sorted pairs,
    ///      mirroring OZ). Returns the layers; root = layers[depth][0].
    function _buildLayers(bytes32[] memory leaves)
        internal
        pure
        returns (bytes32[][] memory layers, uint256 depth)
    {
        uint256 n = leaves.length;
        require(n > 0 && (n & (n - 1)) == 0, "need power of 2");
        for (uint256 i = 0; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                if (leaves[j] < leaves[i]) (leaves[i], leaves[j]) = (leaves[j], leaves[i]);
            }
        }
        layers = new bytes32[][](32);
        layers[0] = leaves;
        depth = 0;
        while (layers[depth].length > 1) {
            bytes32[] memory cur = layers[depth];
            bytes32[] memory next = new bytes32[](cur.length / 2);
            for (uint256 i = 0; i < cur.length; i += 2) {
                next[i / 2] = _hashPair(cur[i], cur[i + 1]);
            }
            layers[depth + 1] = next;
            depth++;
        }
    }

    function _proofFor(bytes32[][] memory layers, uint256 depth, bytes32 leaf)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        uint256 idx;
        bool found;
        for (uint256 i = 0; i < layers[0].length; ++i) {
            if (layers[0][i] == leaf) { idx = i; found = true; break; }
        }
        require(found, "leaf not in tree");
        proof = new bytes32[](depth);
        for (uint256 d = 0; d < depth; ++d) {
            proof[d] = layers[d][idx ^ 1];
            idx /= 2;
        }
    }

    function _openWhitelist(bytes32 root, uint64 start, uint64 end) internal {
        vm.startPrank(owner);
        traces.setWhitelistMerkleRoot(root);
        traces.setWhitelistWindow(start, end);
        traces.setMintOpen(true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // FINDING (High): the 72h repair cooldown is bypassed by the
    // transfer -> auto-clear -> pairSeat loop. pairSeat has NO cooldown,
    // and every seat transfer auto-clears the pairing for free. So the
    // attacker never calls repairSeat at all: they rotate one seat across
    // unlimited agents at ~2 txs per rotation, with zero time delay.
    // The P0 fix for A2-H1 (license multiplexing) does not achieve its
    // goal — only the repairSeat-flavored variant is dead.
    // ------------------------------------------------------------------
    function test_Audit4_CooldownBypassViaTransferPairLoop() public {
        address w1 = address(0x1111);
        address w2 = address(0x2222);
        // Attacker pre-registers one agent per wallet they control.
        uint256 a1 = registry.register(w1);
        uint256 a2 = registry.register(w2);
        uint256 a3 = registry.register(w1);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(w1); // ONE seat
        uint256 t0 = block.timestamp;

        // Rotation 1: pair -> licensed as a1.
        vm.prank(w1);
        traces.pairSeat(1, a1);
        assertEq(traces.seatToAgent(1), a1, "a1 licensed");

        // Rotation 2: transfer seat w1->w2 (auto-clears, FREE unpair),
        // then pairSeat as a2. No cooldown anywhere on this path.
        vm.prank(w1);
        traces.transferFrom(w1, w2, 1);
        assertEq(traces.seatToAgent(1), 0, "auto-cleared");
        vm.prank(w2);
        traces.pairSeat(1, a2);
        assertEq(traces.seatToAgent(1), a2, "a2 licensed");

        // Rotation 3: back to w1, pair as a3. Still the same block.
        vm.prank(w2);
        traces.transferFrom(w2, w1, 1);
        vm.prank(w1);
        traces.pairSeat(1, a3);
        assertEq(traces.seatToAgent(1), a3, "a3 licensed");

        // The 72h cooldown never engaged: lastRepairAt untouched, no time passed.
        assertEq(traces.lastRepairAt(1), 0, "cooldown clock never started");
        assertEq(block.timestamp, t0, "zero time elapsed across 3 rotations");
        // Cost: 1 mint + 3 pairSeat + 2 transfers = 6 txs for 3 serial licenses.
    }

    // ------------------------------------------------------------------
    // VERIFIED HOLDING: the cooldown DOES persist across transfers on the
    // repairSeat path (the parent's intended mitigation). After a repair,
    // moving the seat to your own wallet does not reset the clock — a
    // subsequent repairSeat still reverts. The bypass above works because
    // the attacker avoids repairSeat entirely, not because the clock resets.
    // ------------------------------------------------------------------
    function test_Audit4_RepairCooldownSurvivesSelfTransfer() public {
        address w1 = address(0x1111);
        address w2 = address(0x2222);
        uint256 a1 = registry.register(w1);
        uint256 a2 = registry.register(w1);
        uint256 a3 = registry.register(w2);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(w1);
        vm.prank(w1);
        traces.pairSeat(1, a1);
        vm.prank(w1);
        traces.repairSeat(1, a2); // first repair: free, starts the clock
        assertEq(traces.lastRepairAt(1), block.timestamp);

        // Move the seat to your own second wallet; pairing auto-clears.
        vm.prank(w1);
        traces.transferFrom(w1, w2, 1);
        assertEq(traces.seatToAgent(1), 0);

        // repairSeat on the moved seat STILL hits the cooldown — the clock
        // is per-token and survives transfers.
        vm.prank(w2);
        vm.expectRevert(TracesLicense.RepairCooldown.selector);
        traces.repairSeat(1, a3);
    }

    // ------------------------------------------------------------------
    // FINDING (Medium): the 10/wallet cap strands whitelist entitlements of
    // large terminal holders. Design says 1:1 per terminal, but a wallet
    // holding 11+ terminals at snapshot can only claim 10 — the 11th claim
    // reverts with WalletCapExceeded, and the entitlement is stranded
    // forever (the leaf binds the snapshot wallet; nobody else can claim
    // that terminal). Directly relevant: the founder holds 17 terminals.
    // ------------------------------------------------------------------
    function test_Audit4_WalletCapStrandsLargeTerminalHolder() public {
        address whale = address(0x9A1E);
        uint256 n = 16;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            leaves[i] = _leaf(whale, 1000 + i);
        }
        (bytes32[][] memory layers, uint256 depth) = _buildLayers(leaves);
        bytes32 root = layers[depth][0];

        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(root, start, end);
        vm.warp(start);
        _fund(whale, WL_PRICE * 11);

        // First 10 claims succeed (1:1 per terminal, as designed).
        for (uint256 i = 0; i < 10; ++i) {
            vm.prank(whale);
            traces.whitelistMint(1000 + i, _proofFor(layers, depth, _leaf(whale, 1000 + i)));
        }
        assertEq(traces.balanceOf(whale), 10);

        // 11th terminal: valid proof, unclaimed terminal — but the wallet
        // cap reverts. The entitlement can never be exercised.
        assertFalse(traces.terminalClaimed(1010), "terminal 1010 unclaimed");
        vm.prank(whale);
        vm.expectRevert(TracesLicense.WalletCapExceeded.selector);
        traces.whitelistMint(1010, _proofFor(layers, depth, _leaf(whale, 1010)));

        // And nobody else can claim it: the leaf binds the snapshot wallet.
        address stranger = address(0x57A);
        _fund(stranger, WL_PRICE);
        vm.prank(stranger);
        vm.expectRevert(TracesLicense.InvalidProof.selector);
        traces.whitelistMint(1010, _proofFor(layers, depth, _leaf(whale, 1010)));
    }

    // ------------------------------------------------------------------
    // FINDING (Medium): the merkle root is a trusted input — the contract
    // cannot verify it corresponds to real Quotrons terminal holdings at
    // the snapshot block. A malicious or compromised snapshot builder can
    // insert arbitrary (wallet, terminalId) leaves and those wallets mint
    // at $10. Inherent to merkle drops, but it must be an explicit launch
    // requirement: publish the snapshot block + full leaf list so anyone
    // can recompute the root independently.
    // ------------------------------------------------------------------
    function test_Audit4_WhitelistRootIsTrustedInput() public {
        // "Snapshot builder" inserts a leaf for mallory, who holds no terminal.
        address mallory = address(0xBAAD);
        bytes32 dishonestLeaf = _leaf(mallory, 424242);
        bytes32[] memory emptyProof = new bytes32[](0);

        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(dishonestLeaf, start, end); // root == single dishonest leaf
        vm.warp(start);

        // The contract happily mints the WL seat: it cannot distinguish an
        // honest root from a dishonest one.
        _fund(mallory, WL_PRICE);
        vm.prank(mallory);
        traces.whitelistMint(424242, emptyProof);
        assertEq(traces.ownerOf(1), mallory, "non-holder minted at WL price");
        assertTrue(traces.terminalClaimed(424242));
    }

    // ------------------------------------------------------------------
    // FINDING (Medium): pairSeat is the unthrottled activation path — it has
    // no cooldown at all. 100 team seats can be paired to 100 agents in a
    // single block (the A2-M3 swarm-faking capacity is fully intact), and
    // anyone can activate N bought seats instantly. The cooldown constrains
    // only CHANGES, never activations.
    // ------------------------------------------------------------------
    function test_Audit4_PairSeatHasNoActivationThrottle() public {
        uint256 seats = 20;
        address[] memory wallets = new address[](seats);
        uint256 t0 = block.timestamp;

        for (uint256 i = 0; i < seats; ++i) {
            wallets[i] = address(uint160(0x5000 + i));
            uint256 agentId = registry.register(wallets[i]);
            vm.prank(owner);
            traces.teamMint(wallets[i]);
            vm.prank(wallets[i]);
            traces.pairSeat(i + 1, agentId);
            assertEq(traces.seatToAgent(i + 1), agentId);
        }
        // 20 seats activated in one block; no cooldown was ever consulted.
        assertEq(block.timestamp, t0, "all activations in one block");
        for (uint256 i = 0; i < seats; ++i) {
            assertEq(traces.lastRepairAt(i + 1), 0, "cooldown clock untouched");
        }
    }

    // ------------------------------------------------------------------
    // INFORMATIONAL (spec support): license rental via agent-identity
    // transfer is still possible, but the seat holder can revoke it at any
    // time with a self-transfer (auto-clear). Rentals are therefore
    // trust-based and fragile — the job-board spec must not assume rental
    // persistence, and must re-check eligibility at payout, not just at
    // assignment.
    // ------------------------------------------------------------------
    function test_Audit4_SeatHolderCanRevokeRentalViaSelfTransfer() public {
        uint256 agentId = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, agentId);

        // Alice "rents" the license: transfers the AGENT identity to Bob,
        // keeps the seat. Naive check still passes; hardened check fails.
        vm.prank(alice);
        registry.transferAgent(agentId, bob);
        assertTrue(traces.agentToSeat(agentId) != 0, "naive check passes");
        assertFalse(_hardenedEligible(agentId), "hardened check rejects rental");

        // Alice revokes unilaterally: self-transfer auto-clears the pairing.
        vm.prank(alice);
        traces.transferFrom(alice, alice, 1);
        assertEq(traces.agentToSeat(agentId), 0, "rental revoked: agent unpaired");
        assertEq(traces.seatToAgent(1), 0);
    }

    /// @dev The hardened job-board eligibility check (see handoff spec).
    function _hardenedEligible(uint256 agentId) internal view returns (bool) {
        uint256 seatId = traces.agentToSeat(agentId);
        if (seatId == 0) return false;
        if (traces.seatToAgent(seatId) != agentId) return false;
        return traces.ownerOf(seatId) == registry.ownerOf(agentId);
    }

    // ------------------------------------------------------------------
    // FINDING (Low): the owner can halt the whitelist mid-window with
    // setMintOpen(false) — claims revert with MintClosed until reopened.
    // No funds at risk (reverts are clean), but WL claimants can be
    // griefed and the window can be silently eaten. Trust residual.
    // ------------------------------------------------------------------
    function test_Audit4_OwnerCanHaltWhitelistMidWindow() public {
        bytes32 leaf = _leaf(alice, 7);
        bytes32[] memory emptyProof = new bytes32[](0);
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(leaf, start, end);
        vm.warp(start + 1 days);

        vm.prank(owner);
        traces.setMintOpen(false);

        _fund(alice, WL_PRICE);
        vm.prank(alice);
        vm.expectRevert(TracesLicense.MintClosed.selector);
        traces.whitelistMint(7, emptyProof);

        // Reopening restores claims; nothing was stolen, just delayed.
        vm.prank(owner);
        traces.setMintOpen(true);
        vm.prank(alice);
        traces.whitelistMint(7, emptyProof);
        assertEq(traces.ownerOf(1), alice);
    }

    // ------------------------------------------------------------------
    // FINDING (Medium): setPrice has no timelock and no phase lock — after
    // the whitelist window the owner can reprice the public sale arbitrarily
    // (here 100x) and drain minters who approved max (standard UX). The
    // phased design widens the window: the owner observes WL demand, then
    // reprices the public phase. Quantified damage below.
    // ------------------------------------------------------------------
    function test_Audit4_PublicPriceRugAfterWhitelist() public {
        // Whitelist phase runs honestly, then ends.
        bytes32 leaf = _leaf(alice, 7);
        bytes32[] memory emptyProof = new bytes32[](0);
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 7 days);
        _openWhitelist(leaf, start, end);
        vm.warp(end + 1); // public phase

        // Victim approves max (standard wallet UX) and mints 10.
        usdc.mint(payer, PUBLIC_PRICE * 1000);
        vm.prank(payer);
        usdc.approve(address(traces), type(uint256).max);

        // Owner front-runs with a 100x price hike. No timelock, no cap.
        vm.prank(owner);
        traces.setPrice(PUBLIC_PRICE * 100);

        vm.prank(payer);
        traces.mintBatch(bob, 10);

        assertEq(
            usdc.balanceOf(treasury),
            PUBLIC_PRICE * 100 * 10,
            "victim paid 100x: $120k USDC for 10 seats"
        );
        assertEq(traces.balanceOf(bob), 10);
    }
}
