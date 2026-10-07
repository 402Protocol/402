// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/src/Script.sol";
import {Four02SpendingPermissions} from "../contracts/Four02SpendingPermissions.sol";

/// @notice Ink-only deployment. Use a caller-selected Foundry keystore/account; no key env loading.
/// @dev Running a forge script without --broadcast simulates only. No owner or admin is installed.
contract DeploySpendingPermissions is Script {
    address constant INK_USDC = 0x2D270e6886d130D724215A266106e6832161EAEd;

    function run() external returns (Four02SpendingPermissions manager) {
        require(block.chainid == 57073, "Ink mainnet only");
        require(INK_USDC.code.length > 0, "Native USDC missing");
        vm.startBroadcast();
        manager = new Four02SpendingPermissions(INK_USDC);
        vm.stopBroadcast();
    }
}
