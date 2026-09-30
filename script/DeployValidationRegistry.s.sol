// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/src/Script.sol";
import {Four02ValidationRegistry} from "../contracts/Four02ValidationRegistry.sol";

/// @notice Deploys Four02ValidationRegistry to Ink mainnet. All product parameters
///         come from env vars — the founder decides every one; nothing is
///         hardcoded here except the Ink USDC token, the BountyEscrow, and the
///         ERC-8004 identity registry addresses.
///
///         Env vars (all required except where noted):
///           FOUR02_VALIDATOR_HUMAN_FALLBACK — quorum-failure backstop (EOA).
///                                            Suggested: the founder's fresh wallet.
///           FOUR02_VALIDATOR_MIN_STAKE      — USDC base units. Suggested $100 (100000000).
///           FOUR02_VALIDATOR_UNSTAKE_DELAY  — seconds. Suggested 7 days (604800).
///           FOUR02_VALIDATOR_COMMIT_WINDOW  — seconds. Suggested 3 days (259200).
///           FOUR02_VALIDATOR_REVEAL_WINDOW  — seconds. Suggested 4 days (345600).
///           FOUR02_VALIDATOR_QUORUM         — minimum reveals. Suggested 3.
///           FOUR02_VALIDATOR_HONEST_BAND    — points. Suggested 20.
///           FOUR02_VALIDATOR_SLASH_BPS      — bps of stake. Suggested 1000 (10%).
///           FOUR02_VALIDATOR_CASE_FEE       — USDC base units. Suggested $1 (1000000).
///           FOUR02_VALIDATOR_VOTE_BOND      — USDC base units locked per commit, refunded
///                                            on reveal. Suggested $5 (5000000). 0 disables.
///
///         Deployer pays gas only (founder's treasury). The registry has NO owner
///         and NO privileged functions. AFTER DEPLOY, to make validator votes binding
///         on the marketplace, the founder proposes a BountyEscrow arbiter rotation
///         to the deployed registry address (14-day timelock applies).
///
///         ECONOMIC CAVEAT (audit 2026-09-27): do NOT rotate the escrow's arbiter to
///         this registry until the 51%-of-voters capture problem is addressed — a
///         ~$500 Sybil majority can buy any dispute outcome risk-free because the
///         majority defines "honest". Deploy advisory-first (human arbiter keeps
///         final say, follows medians by policy); the binding rotation is a
///         separate future decision requiring sortition, value-bounding, or
///         quorum scaling.
contract DeployValidationRegistry is Script {
    address constant USDC = 0x2D270e6886d130D724215A266106e6832161EAEd;
    address constant BOUNTY_ESCROW = 0xDF319a060EAA361AA906855c64CCbc941159C01C;
    address constant IDENTITY_REGISTRY = 0x7274e874CA62410a93Bd8bf61c69d8045E399c02;

    function run() external {
        address humanFallback = vm.envAddress("FOUR02_VALIDATOR_HUMAN_FALLBACK");
        uint256 minStake = vm.envUint("FOUR02_VALIDATOR_MIN_STAKE");
        uint64 unstakeDelay = uint64(vm.envUint("FOUR02_VALIDATOR_UNSTAKE_DELAY"));
        uint64 commitWindow = uint64(vm.envUint("FOUR02_VALIDATOR_COMMIT_WINDOW"));
        uint64 revealWindow = uint64(vm.envUint("FOUR02_VALIDATOR_REVEAL_WINDOW"));
        uint256 quorum = vm.envUint("FOUR02_VALIDATOR_QUORUM");
        uint8 honestBand = uint8(vm.envUint("FOUR02_VALIDATOR_HONEST_BAND"));
        uint256 slashBps = vm.envUint("FOUR02_VALIDATOR_SLASH_BPS");
        uint256 caseFee = vm.envUint("FOUR02_VALIDATOR_CASE_FEE");
        uint256 voteBond = vm.envUint("FOUR02_VALIDATOR_VOTE_BOND");

        vm.startBroadcast();
        Four02ValidationRegistry reg = new Four02ValidationRegistry(
            USDC,
            BOUNTY_ESCROW,
            IDENTITY_REGISTRY,
            humanFallback,
            minStake,
            unstakeDelay,
            commitWindow,
            revealWindow,
            quorum,
            honestBand,
            slashBps,
            caseFee,
            voteBond
        );
        vm.stopBroadcast();

        console.log("Four02ValidationRegistry deployed at:", address(reg));
        console.log("humanFallback:", reg.humanFallback());
        console.log("MIN_STAKE:", reg.MIN_STAKE());
        console.log("QUORUM:", reg.QUORUM());
        console.log("VOTE_BOND:", reg.VOTE_BOND());
    }
}
