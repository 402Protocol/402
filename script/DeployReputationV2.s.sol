// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/src/Script.sol";
import {Four02ReputationRegistryV2} from "../contracts/Four02ReputationRegistryV2.sol";

/// @notice Deploys the 402 Reputation Registry V2 (adds EventType.WorkerGhosted)
///         to Ink mainnet. Supersedes the V1 registry at
///         0x33E2c56035C059553a37a3A56199B5b5b3DA3365 (abandoned: empty writer
///         allowlist, zero recorded rows — nothing to migrate).
///         Ownership goes to the founder's fresh wallet; the deployer pays gas only.
///         AFTER DEPLOY: the owner must call addWriter(bountyEscrow) once the
///         BountyEscrow deploys, and the /jobs API's REPUTATION_REGISTRY
///         constant must be switched to the V2 address for resume reads.
contract DeployReputationV2 is Script {
    address constant OWNER = 0xE15B4338073db2aaD308bdFf4bBEd351857FaDEf;

    function run() external {
        vm.startBroadcast();
        Four02ReputationRegistryV2 registry = new Four02ReputationRegistryV2(OWNER);
        vm.stopBroadcast();
        console.log("Four02ReputationRegistryV2 deployed:", address(registry));
        console.log("owner:", registry.owner());
    }
}
