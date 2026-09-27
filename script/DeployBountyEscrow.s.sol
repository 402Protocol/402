// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/src/Script.sol";
import {BountyEscrow} from "../contracts/BountyEscrow.sol";

/// @notice Deploys BountyEscrow to Ink mainnet. All product parameters come
///         from env vars — the founder decides every one; nothing is
///         hardcoded here except the Ink USDC token and the ERC-8004 identity
///         registry addresses.
///
///         Env vars (all required except where noted):
///           FOUR02_ESCROW_ARBITER        — dispute arbiter (EOA or multisig)
///           FOUR02_ESCROW_FEE_RECIPIENT  — where the protocol fee lands
///           FOUR02_ESCROW_FEE_BPS        — protocol fee in bps (75 proposed, NOT approved)
///           FOUR02_ESCROW_REFUND_DELAY   — seconds past deadline before payer
///                                          may refund an unclaimed/claimed-but-
///                                          undelivered bounty
///           FOUR02_ESCROW_GUARDIAN       — guardian (14-day timelocked arbiter rotation)
///           FOUR02_ESCROW_REPUTATION     — deployed Four02ReputationRegistryV2 address
///           FOUR02_ESCROW_CLAIM_STAKE    — worker stake pulled at claim (USDC base
///                                          units, 0 = disabled). Suggested $2.
///           FOUR02_ESCROW_DISPUTE_BOND   — raiser bond pulled at raiseDispute
///                                          (USDC base units, 0 = disabled). Suggested $1.
///           FOUR02_ESCROW_DISPUTE_TIMEOUT— seconds after which either party may force
///                                          a 50/50 split (0 = disabled). Suggested 30 days.
///
///         Deployer pays gas only (founder's treasury). AFTER DEPLOY: the V2
///         registry owner must call addWriter(bountyEscrow), and the /jobs API's
///         FOUR02_BOUNTY_ESCROW env must be set to the deployed address.
contract DeployBountyEscrow is Script {
    address constant USDC = 0x2D270e6886d130D724215A266106e6832161EAEd;
    address constant IDENTITY_REGISTRY = 0x7274e874CA62410a93Bd8bf61c69d8045E399c02;

    function run() external {
        address arbiter = vm.envAddress("FOUR02_ESCROW_ARBITER");
        address feeRecipient = vm.envAddress("FOUR02_ESCROW_FEE_RECIPIENT");
        uint256 feeBps = vm.envUint("FOUR02_ESCROW_FEE_BPS");
        uint64 refundDelay = uint64(vm.envUint("FOUR02_ESCROW_REFUND_DELAY"));
        address guardian = vm.envAddress("FOUR02_ESCROW_GUARDIAN");
        address reputationRegistry = vm.envAddress("FOUR02_ESCROW_REPUTATION");
        uint256 claimStake = vm.envOr("FOUR02_ESCROW_CLAIM_STAKE", uint256(0));
        uint256 disputeBond = vm.envOr("FOUR02_ESCROW_DISPUTE_BOND", uint256(0));
        uint64 disputeTimeout = uint64(vm.envOr("FOUR02_ESCROW_DISPUTE_TIMEOUT", uint256(0)));

        vm.startBroadcast();
        BountyEscrow escrow = new BountyEscrow(
            USDC,
            arbiter,
            feeRecipient,
            feeBps,
            refundDelay,
            guardian,
            IDENTITY_REGISTRY,
            reputationRegistry,
            claimStake,
            disputeBond,
            disputeTimeout
        );
        vm.stopBroadcast();

        console.log("BountyEscrow deployed:", address(escrow));
        console.log("arbiter:", escrow.arbiter());
        console.log("guardian:", escrow.guardian());
        console.log("feeRecipient:", escrow.feeRecipient());
        console.log("feeBps:", escrow.feeBps());
        console.log("refundDelay:", escrow.refundDelay());
        console.log("claimStake:", escrow.claimStake());
        console.log("disputeBond:", escrow.disputeBond());
        console.log("disputeTimeout:", escrow.disputeTimeout());
    }
}
