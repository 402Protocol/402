// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/src/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TracesLicense} from "../../contracts/TracesLicense.sol";

/// @notice Minimal stand-in for the real ERC-8004 Identity Registry interface.
///         Etched over the canonical address on the fork because the live
///         Ink deployment is still the 8004 team's placeholder (no register).
contract MockIdentityRegistry {
    uint256 public nextId = 1;
    mapping(uint256 => address) public ownerOf_;
    mapping(address => uint256[]) public owned;

    function register(string memory) external returns (uint256 agentId) {
        agentId = nextId++;
        ownerOf_[agentId] = msg.sender;
        owned[msg.sender].push(agentId);
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address o = ownerOf_[agentId];
        require(o != address(0), "nonexistent");
        return o;
    }
}

/// @notice Ink-mainnet fork rehearsal for TracesLicense:
///         - deploys the real contract on a fork of Ink mainnet
///         - etches a mock 8004 registry at the canonical address (the live
///           Ink deployment is the 8004 team's placeholder; real impl pending)
///         - runs the full mint flow against REAL Ink USDC
contract TracesForkRehearsalTest is Test {
    // Live IdentityRegistryUpgradeable on Ink mainnet (verified). The
    // 0x8004... vanity address is still the 8004 team's placeholder.
    address constant IDENTITY_REGISTRY = 0x7274e874CA62410a93Bd8bf61c69d8045E399c02;
    address constant INK_USDC = 0x2D270e6886d130D724215A266106e6832161EAEd;

    function testForkRehearsal() external {
        vm.createSelectFork("https://rpc-gel.inkonchain.com");

        // NOTE: etch the mock over the live registry address for a
        // deterministic rehearsal (we don't want to burn real agentIds).
        MockIdentityRegistry mock = new MockIdentityRegistry();
        vm.etch(IDENTITY_REGISTRY, address(mock).code);

        address buyer = vm.addr(0xBEEF1234);
        address treasury = address(0xCAFE);
        uint256 price = 1_000_000; // 1 USDC for the rehearsal

        vm.deal(buyer, 10 ether);
        deal(INK_USDC, buyer, 100_000_000); // 100 real Ink USDC on the fork

        // 1. Deploy the license contract, pairing with the live registry.
        TracesLicense license = new TracesLicense(
            buyer,
            INK_USDC,
            treasury,
            price,
            "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/",
            IDENTITY_REGISTRY
        );
        console.log("deployed:", address(license));

        // 2. Register 3 agent identities (mock at canonical address).
        vm.startPrank(buyer);
        uint256 id1 = MockIdentityRegistry(IDENTITY_REGISTRY).register("ipfs://rehearsal/agent-1.json");
        uint256 id2 = MockIdentityRegistry(IDENTITY_REGISTRY).register("ipfs://rehearsal/agent-2.json");
        uint256 id3 = MockIdentityRegistry(IDENTITY_REGISTRY).register("ipfs://rehearsal/agent-3.json");
        console.log("agentIds:", id1, id2, id3);

        // 3. Open the mint, buy 2 seats in one batch with real USDC.
        license.setMintOpen(true);
        IERC20(INK_USDC).approve(address(license), price * 2);
        uint256[] memory ids = new uint256[](2);
        ids[0] = id1;
        ids[1] = id2;
        license.mintBatch(buyer, ids);

        // 4. Free team claim.
        license.teamMint(buyer, id3);
        vm.stopPrank();

        // 5. Assertions.
        assertEq(license.ownerOf(1), buyer, "seat 1 owner");
        assertEq(license.ownerOf(2), buyer, "seat 2 owner");
        assertEq(license.ownerOf(3), buyer, "team seat owner");
        assertEq(license.seatToAgent(1), id1, "seat 1 pairing");
        assertEq(license.seatToAgent(2), id2, "seat 2 pairing");
        assertEq(license.seatToAgent(3), id3, "team seat pairing");
        assertEq(license.agentToSeat(id1), 1, "reverse pairing");
        assertEq(IERC20(INK_USDC).balanceOf(treasury), price * 2, "treasury paid real USDC");
        assertEq(
            license.tokenURI(1),
            "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/1.json",
            "tokenURI"
        );
        (address receiver, uint256 royalty) = license.royaltyInfo(1, 1_000_000);
        assertEq(receiver, treasury, "royalty receiver");
        assertEq(royalty, 50_000, "5% royalty");

        console.log("FORK REHEARSAL PASSED");
    }
}
