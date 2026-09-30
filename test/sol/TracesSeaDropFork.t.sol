// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/src/Test.sol";
import {TracesLicenseSeaDrop} from "../../contracts/TracesLicenseSeaDrop.sol";
import {
    PublicDrop,
    AllowListData
} from "../../contracts/seadrop/SeaDropStructs.sol";

/// @notice Minimal view of the canonical SeaDrop for the fork test.
interface ISeaDropLive {
    function updatePublicDrop(PublicDrop calldata publicDrop) external;
    function updateAllowList(AllowListData calldata allowListData) external;
    function updateCreatorPayoutAddress(address payoutAddress) external;
    function mintPublic(
        address nftContract,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity
    ) external payable;
    function getPublicDrop(address nftContract)
        external
        view
        returns (PublicDrop memory);
}

contract MockIdentityRegistry2 {
    uint256 public nextId = 1;
    mapping(uint256 => address) public ownerOf_;

    function register() external returns (uint256 agentId) {
        agentId = nextId++;
        ownerOf_[agentId] = msg.sender;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address o = ownerOf_[agentId];
        require(o != address(0), "no agent");
        return o;
    }
}

/// @notice Ink-mainnet fork test: TracesLicenseSeaDrop against the REAL
///         canonical SeaDrop (0x00005EA00Ac477B1030CE78506496e8C2dE24bf5).
///         Proves the vendored interface's ERC-165 ID matches what the live
///         SeaDrop enforces, and that a real public-drop mint flows
///         end to end with ETH payment splitting to the payout address.
contract TracesSeaDropForkTest is Test {
    address constant SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    address constant IDENTITY_REGISTRY = 0x7274e874CA62410a93Bd8bf61c69d8045E399c02;

    function testLiveSeaDropEndToEnd() external {
        vm.createSelectFork("https://rpc-gel.inkonchain.com");

        // Etch a deterministic mock registry over the canonical address.
        MockIdentityRegistry2 mock = new MockIdentityRegistry2();
        vm.etch(IDENTITY_REGISTRY, address(mock).code);
        vm.store(IDENTITY_REGISTRY, bytes32(uint256(0)), bytes32(uint256(1)));

        address owner = address(0xA11CE);
        address payout = address(0xCAFE);
        address minter = address(0xBEEF);
        vm.deal(minter, 10 ether);

        address[] memory allowed = new address[](1);
        allowed[0] = SEADROP;
        TracesLicenseSeaDrop token = new TracesLicenseSeaDrop(
            owner,
            IDENTITY_REGISTRY,
            allowed,
            "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/",
            payout,
            500
        );

        // 1. Configure the drop THROUGH our token (real SeaDrop checks our
        //    ERC-165 interface ID here — this is the compatibility proof).
        vm.startPrank(owner);
        token.updateCreatorPayoutAddress(SEADROP, payout);
        PublicDrop memory drop = PublicDrop({
            mintPrice: 0.01 ether,
            startTime: uint48(block.timestamp - 1),
            endTime: uint48(block.timestamp + 7 days),
            maxTotalMintableByWallet: 10,
            feeBps: 0,
            restrictFeeRecipients: false
        });
        token.updatePublicDrop(SEADROP, drop);
        vm.stopPrank();

        // 2. Real public mint on the live SeaDrop with real ETH.
        uint256 payoutBefore = payout.balance;
        vm.prank(minter);
        ISeaDropLive(SEADROP).mintPublic{value: 0.01 ether}(
            address(token),
            payout, // fee recipient (SeaDrop rejects the zero address)
            address(0),
            1
        );

        // 3. Assertions: token minted, payment split to payout address.
        assertEq(token.ownerOf(1), minter);
        assertEq(token.balanceOf(minter), 1);
        assertEq(payout.balance - payoutBefore, 0.01 ether);
        assertEq(token.tokenURI(1), string.concat(
            "ipfs://bafybeidhdxryx66t3sbrgnuagwtjjjteiddavvm55474sshyyh5tfnclxe/",
            "1.json"
        ));

        // 4. Activation still works post-drop: pair the seat.
        vm.prank(minter);
        uint256 minterAgent = MockIdentityRegistry2(IDENTITY_REGISTRY).register();
        vm.prank(minter);
        token.pairSeat(1, minterAgent);
        assertEq(token.seatToAgent(1), minterAgent);
    }
}
