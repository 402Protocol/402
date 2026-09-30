// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/src/Script.sol";
import {AgentEscrow} from "../contracts/AgentEscrow.sol";

/// @title Deploy AgentEscrow
/// @notice Deploys the 402 escrow (+ its Reputation ledger, created by the
/// escrow's constructor) to any EVM chain.
/// @dev THIS SCRIPT IS RUN BY THE FOUNDER, WITH THE FOUNDER'S KEYS.
/// The agent that wrote this code NEVER deploys — local anvil only.
///
/// Usage:
///   1. Fill in ARBITER, FEE_RECIPIENT and GUARDIAN below (and TOKEN if
///      deploying to a chain other than Ink); review FEE_BPS and REFUND_DELAY.
///   2. forge script script/Deploy.s.sol \
///        --rpc-url <YOUR_RPC> --private-key <YOUR_DEPLOYER_KEY> --broadcast
contract Deploy is Script {
    // ------------------------------------------------------------------
    // FOUNDER: SET THESE BEFORE RUNNING
    // ------------------------------------------------------------------

    /// @notice Settlement token. Default: native Circle USDC on Ink (57073).
    /// Change this when deploying to another chain (e.g. Robinhood Chain).
    address constant TOKEN = 0x2D270e6886d130D724215A266106e6832161EAEd;

    /// @notice Trusted arbiter — YOUR EOA or YOUR multisig. The founder alone
    /// decides solo-vs-multisig; the contract takes whatever address you give.
    /// There is no way to change this after deploy (no upgrades in the MVP).
    address constant ARBITER = address(0); // <-- SET THIS

    /// @notice Where protocol fees are sent. Must be an address you control.
    address constant FEE_RECIPIENT = address(0); // <-- SET THIS

    /// @notice Protocol fee in basis points. 75 = 0.75%.
    /// PROPOSED economics — NOT final. Founder approval required before
    /// mainnet. Hard cap enforced onchain: 1000 bps (10%).
    uint256 constant FEE_BPS = 75; // <-- REVIEW THIS

    /// @notice Chain this deployment targets. The script refuses to run on any
    /// other chain (H5). When deploying to a new chain (e.g. Robinhood Chain),
    /// change BOTH this and TOKEN.
    uint256 constant EXPECTED_CHAIN_ID = 57073; // Ink

    /// @notice Refund grace window (M3): refund() opens at deadline +
    /// REFUND_DELAY. Gives the provider a delivery-exclusivity window so a
    /// confirmDelivery can't lose a mempool race to a refund in the block
    /// the deadline passes. During the window only confirmDelivery
    /// (provider) and raiseDispute (either party) can move the job.
    uint64 constant REFUND_DELAY = 1 days; // <-- REVIEW THIS

    /// @notice Rotation guardian (H4): a founder-controlled EOA that may
    /// PROPOSE an arbiter rotation (the arbiter may too). It CANNOT touch
    /// funds — a proposal only takes effect after a 14-day public timelock
    /// via confirmRotation(). This is the recovery path if the arbiter key
    /// is lost. Deploy the arbiter itself as your multisig regardless.
    address constant GUARDIAN = address(0); // <-- SET THIS

    // ------------------------------------------------------------------

    function run() external {
        require(ARBITER != address(0), "Deploy: set ARBITER");
        require(FEE_RECIPIENT != address(0), "Deploy: set FEE_RECIPIENT");
        require(GUARDIAN != address(0), "Deploy: set GUARDIAN");
        require(
            block.chainid == EXPECTED_CHAIN_ID,
            "Deploy: wrong chain - update EXPECTED_CHAIN_ID and TOKEN for the target chain"
        );

        vm.startBroadcast();
        AgentEscrow escrow = new AgentEscrow(TOKEN, ARBITER, FEE_RECIPIENT, FEE_BPS, REFUND_DELAY, GUARDIAN);
        vm.stopBroadcast();

        console.log("AgentEscrow :", address(escrow));
        console.log("Reputation  :", address(escrow.reputation()));
        console.log("token       :", address(escrow.token()));
        console.log("arbiter     :", escrow.arbiter());
        console.log("guardian    :", escrow.guardian());
        console.log("feeBps      :", escrow.feeBps());
        console.log("feeRecipient:", escrow.feeRecipient());
        console.log("refundDelay :", escrow.refundDelay());
    }
}
