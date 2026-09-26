// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/src/Script.sol";
import {Four02ReputationRegistry} from "../contracts/Four02ReputationRegistry.sol";

/// @notice Deploys the 402 Reputation Registry to Ink mainnet.
///         Ownership goes to the founder's fresh wallet; the deployer pays gas only.
contract DeployReputation is Script {
    address constant OWNER = 0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf;

    function run() external {
        vm.startBroadcast();
        Four02ReputationRegistry registry = new Four02ReputationRegistry(OWNER);
        vm.stopBroadcast();
        console.log("Four02ReputationRegistry deployed:", address(registry));
        console.log("owner:", registry.owner());
    }
}
