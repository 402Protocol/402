// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";
import {ITransferValidator} from "@creator-token-standards/interfaces/ITransferValidator.sol";

/// @notice Controllable stand-in for the canonical ERC-8004 Identity Registry.
contract AuditMockRegistry {
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
contract AuditMockUSDC {
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

/// @notice Transfer validator that bricks every transfer.
contract RevertingValidator is ITransferValidator {
    function applyCollectionTransferPolicy(address, address, address) external view override {}
    function validateTransfer(address, address, address) external view override {}
    function validateTransfer(address, address, address, uint256) external view override {
        revert("VALIDATOR_BLOCKS_ALL");
    }
    function validateTransfer(address, address, address, uint256, uint256) external override {}
    function beforeAuthorizedTransfer(address, address, uint256) external override {}
    function afterAuthorizedTransfer(address, uint256) external override {}
    function beforeAuthorizedTransfer(address, address) external override {}
    function afterAuthorizedTransfer(address) external override {}
    function beforeAuthorizedTransfer(address, uint256) external override {}
    function beforeAuthorizedTransferWithAmount(address, uint256, uint256) external override {}
    function afterAuthorizedTransferWithAmount(address, uint256) external override {}
}

/// @notice Recipient that reverts onERC721Received.
contract RevertingReceiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("RECEIVER_REVERTS");
    }
}

/// @notice Recipient that pairSeats itself inside the mint callback.
contract CallbackPairer {
    TracesLicense public traces;
    uint256 public agentId;

    constructor(TracesLicense _traces) {
        traces = _traces;
    }

    function setAgent(uint256 id) external {
        agentId = id;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external
        returns (bytes4)
    {
        traces.pairSeat(tokenId, agentId);
        return this.onERC721Received.selector;
    }
}

/// @title TRACES Audit 1 — adversarial PoCs (security)
/// @notice Each test demonstrates a concrete finding. Informational PoCs are
///         marked as such; the rest map to ranked findings in the audit report.
contract TracesAudit1Test is Test {
    TracesLicense internal traces;
    AuditMockRegistry internal registry;
    AuditMockUSDC internal usdc;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal payer = address(0xCAFE);
    address internal alice = address(0xA11C3);
    address internal bob = address(0xB0B);

    uint256 internal constant WL_PRICE = 10_000_000; // $10.00 whitelist
    uint256 internal constant PUBLIC_PRICE = 12_000_000; // $12.00 public

    function setUp() public {
        registry = new AuditMockRegistry();
        usdc = new AuditMockUSDC();
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

    // ------------------------------------------------------------------
    // FIX-1 (was PoC-1): Stale pairing CANNOT survive transfer anymore.
    // Pairings auto-clear inside the transfer hook, so the license always
    // follows the token holder. Regression test for the audit finding.
    // ------------------------------------------------------------------
    function test_Fix1_PairingAutoClearsOnTransfer() public {
        uint256 aliceAgent = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, aliceAgent);

        // Alice sells the seat to Bob on secondary.
        vm.prank(alice);
        traces.transferFrom(alice, bob, 1);

        // FIXED: pairing state moved with the token — nothing stale.
        assertEq(traces.ownerOf(1), bob, "bob owns the seat now");
        assertEq(traces.seatToAgent(1), 0, "pairing cleared on transfer");
        assertEq(traces.agentToSeat(aliceAgent), 0, "seller's agent unpaired");

        // Bob's seat arrives clean: he activates directly with pairSeat.
        uint256 bobAgent = registry.register(bob);
        vm.prank(bob);
        traces.pairSeat(1, bobAgent);
        assertEq(traces.seatToAgent(1), bobAgent);
    }

    // ------------------------------------------------------------------
    // FIX-2 (was PoC-2): Onchain whitelist IS enforced now. During the
    // whitelist window only whitelistMint works, gated by a Merkle proof
    // over a surprise snapshot of Quotrons terminal holders. Regression
    // test for the audit finding.
    // ------------------------------------------------------------------
    function test_Fix2_WhitelistEnforcedOnchain() public {
        // Snapshot: alice holds terminal 7. Single-leaf tree: root == leaf.
        uint256 terminalId = 7;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(alice, terminalId))));
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.startPrank(owner);
        traces.setWhitelistMerkleRoot(leaf);
        traces.setWhitelistWindow(uint64(block.timestamp + 1 hours), uint64(block.timestamp + 7 days));
        traces.setMintOpen(true);
        vm.stopPrank();

        // Before the window: whitelist minting is not active (sale is open
        // but the whitelist phase has not started).
        _fund(alice, WL_PRICE);
        vm.prank(alice);
        vm.expectRevert(TracesLicense.WhitelistNotActive.selector);
        traces.whitelistMint(terminalId, emptyProof);

        vm.warp(block.timestamp + 1 hours);

        // During the window: public mint is closed to everyone...
        _fund(bob, PUBLIC_PRICE);
        vm.prank(bob);
        vm.expectRevert(TracesLicense.WhitelistPhaseActive.selector);
        traces.mint(bob);

        // ...a non-whitelisted wallet cannot claim, even with a fake proof...
        vm.prank(bob);
        vm.expectRevert(TracesLicense.InvalidProof.selector);
        traces.whitelistMint(terminalId, emptyProof);

        // ...but alice's proof verifies and she mints at the $10 WL price.
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        traces.whitelistMint(terminalId, emptyProof);
        assertEq(traces.ownerOf(1), alice);
        assertEq(usdc.balanceOf(alice), balBefore - WL_PRICE);
        assertTrue(traces.terminalClaimed(terminalId));

        // Each terminal claims exactly once.
        vm.prank(alice);
        vm.expectRevert(TracesLicense.TerminalAlreadyClaimed.selector);
        traces.whitelistMint(terminalId, emptyProof);
    }

    // ------------------------------------------------------------------
    // PoC-3: 10/wallet cap is trivially sybiled with fresh wallets.
    // ------------------------------------------------------------------
    function test_PoC3_WalletCapSybil() public {
        _openMint();
        uint256 wallets = 5;
        for (uint256 w = 0; w < wallets; ++w) {
            address fresh = address(uint160(0xF000 + w));
            _fund(payer, PUBLIC_PRICE * 10);
            vm.prank(payer);
            // payer funds each mint; each fresh wallet receives 10
            usdc.mint(payer, 0); // no-op clarity
            vm.prank(payer);
            traces.mintBatch(fresh, 10);
            assertEq(traces.balanceOf(fresh), 10);
        }
        assertEq(traces.totalSupply(), 50);
        assertEq(traces.nextTokenId(), 51);
    }

    // ------------------------------------------------------------------
    // PoC-4: Owner can 100x the price under an existing max approval.
    // A user who approved max (common UX) pays the rugged price.
    // ------------------------------------------------------------------
    function test_PoC4_OwnerPriceRugUnderMaxApproval() public {
        _openMint();
        usdc.mint(payer, PUBLIC_PRICE * 200);
        vm.prank(payer);
        usdc.approve(address(traces), type(uint256).max);

        // Owner frontruns the mint with a 100x price hike.
        vm.prank(owner);
        traces.setPrice(PUBLIC_PRICE * 100);

        vm.prank(payer);
        traces.mint(payer);

        assertEq(usdc.balanceOf(treasury), PUBLIC_PRICE * 100, "payer drained 100x");
        assertEq(traces.ownerOf(1), payer);
    }

    // ------------------------------------------------------------------
    // PoC-5: Owner can brick all secondary transfers via a reverting
    // transfer validator (collection becomes soulbound at will).
    // ------------------------------------------------------------------
    function test_PoC5_ValidatorBricksTransfers() public {
        _openMint();
        _fund(payer, PUBLIC_PRICE);
        vm.prank(payer);
        traces.mint(alice);

        RevertingValidator v = new RevertingValidator();
        vm.prank(owner);
        traces.setTransferValidator(address(v));

        vm.prank(alice);
        vm.expectRevert("VALIDATOR_BLOCKS_ALL");
        traces.transferFrom(alice, bob, 1);

        // Unbrick by disabling the validator.
        vm.prank(owner);
        traces.setTransferValidator(address(0));
        vm.prank(alice);
        traces.transferFrom(alice, bob, 1);
        assertEq(traces.ownerOf(1), bob);
    }

    // ------------------------------------------------------------------
    // PoC-6 (informational): payment-before-mint ordering is atomic — a
    // reverting receiver costs the payer nothing but gas.
    // ------------------------------------------------------------------
    function test_PoC6_MintAtomicityOnReceiverRevert() public {
        _openMint();
        _fund(payer, PUBLIC_PRICE);
        RevertingReceiver r = new RevertingReceiver();

        vm.prank(payer);
        vm.expectRevert("RECEIVER_REVERTS");
        traces.mint(address(r));

        assertEq(usdc.balanceOf(payer), PUBLIC_PRICE, "USDC untouched after revert");
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(traces.nextTokenId(), 1, "no token consumed");
    }

    // ------------------------------------------------------------------
    // PoC-7 (informational): a recipient contract CAN pairSeat inside its
    // own onERC721Received callback — ownership is set before the callback.
    // Benign (holder pairing their own seat), but proves callback ordering.
    // ------------------------------------------------------------------
    function test_PoC7_CallbackAtomicPair() public {
        _openMint();
        _fund(payer, PUBLIC_PRICE);
        CallbackPairer c = new CallbackPairer(traces);
        uint256 agentId = registry.register(address(c));
        c.setAgent(agentId);

        vm.prank(payer);
        traces.mint(address(c)); // pairs atomically inside the callback

        assertEq(traces.ownerOf(1), address(c));
        assertEq(traces.seatToAgent(1), agentId);
        assertEq(traces.agentToSeat(agentId), 1);
    }

    // ------------------------------------------------------------------
    // FIX-8 (was PoC-8): a baseURI setter exists now — a wrong CID at
    // deploy can be corrected by the owner instead of freezing metadata
    // forever. Regression test for the audit finding.
    // ------------------------------------------------------------------
    function test_Fix8_BaseURISetterExists() public {
        _openMint();
        _fund(payer, PUBLIC_PRICE);
        vm.prank(payer);
        traces.mint(alice);
        assertEq(traces.tokenURI(1), "ipfs://cid/1.json");

        vm.prank(payer);
        vm.expectRevert();
        traces.setBaseURI("ipfs://fixed/");

        vm.prank(owner);
        traces.setBaseURI("ipfs://fixed/");
        assertEq(traces.tokenURI(1), "ipfs://fixed/1.json");
    }

    // ------------------------------------------------------------------
    // PoC-9: repairSeat lets the holder silently strip a pairing — there is
    // no way for an agent owner to keep/protect a pairing on a seat they
    // don't own. (Documents the holder-sovereignty invariant.)
    // ------------------------------------------------------------------
    function test_PoC9_HolderCanStripPairingAtWill() public {
        uint256 aliceAgent = registry.register(alice);
        uint256 aliceAgent2 = registry.register(alice);
        _openMint();
        _fund(payer, PUBLIC_PRICE);

        vm.prank(payer);
        traces.mint(alice);
        vm.prank(alice);
        traces.pairSeat(1, aliceAgent);

        // Holder re-pairs to a different identity they own; old pairing gone.
        vm.prank(alice);
        traces.repairSeat(1, aliceAgent2);
        assertEq(traces.seatToAgent(1), aliceAgent2);
        assertEq(traces.agentToSeat(aliceAgent), 0);
    }

    // ------------------------------------------------------------------
    // PoC-10: supply boundary — token 10000 mints, 10001 reverts.
    // Uses stdstore to jump nextTokenId (avoids 10k real mints).
    // ------------------------------------------------------------------
    function test_PoC10_SupplyBoundary() public {
        _openMint();
        _fund(payer, PUBLIC_PRICE * 2);
        // nextTokenId lives at storage slot 18 (see forge inspect storage-layout)
        vm.store(address(traces), bytes32(uint256(18)), bytes32(uint256(10_000)));

        vm.prank(payer);
        traces.mint(alice); // token id 10000: OK
        assertEq(traces.ownerOf(10_000), alice);
        assertEq(traces.totalSupply(), 1);

        vm.prank(payer);
        vm.expectRevert(TracesLicense.MaxSupplyReached.selector);
        traces.mint(alice); // 10001: reverts

        vm.prank(payer);
        vm.expectRevert(TracesLicense.MaxSupplyReached.selector);
        traces.mintBatch(alice, 2); // also reverts via _prepareMint
    }
}
