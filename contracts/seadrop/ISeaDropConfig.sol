// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    AllowListData,
    PublicDrop,
    TokenGatedDropStage,
    SignedMintValidationParams
} from "./SeaDropStructs.sol";

/// @notice Minimal view of the canonical SeaDrop contract: only the
///         drop-configuration functions the token contract forwards to.
///         Signatures mirror OpenSea's ISeaDrop exactly.
interface ISeaDropConfig {
    function updatePublicDrop(PublicDrop calldata publicDrop) external;

    function updateAllowList(AllowListData calldata allowListData) external;

    function updateTokenGatedDrop(
        address allowedNftToken,
        TokenGatedDropStage calldata dropStage
    ) external;

    function updateDropURI(string calldata dropURI) external;

    function updateCreatorPayoutAddress(address payoutAddress) external;

    function updateAllowedFeeRecipient(address feeRecipient, bool allowed)
        external;

    function updateSignedMintValidationParams(
        address signer,
        SignedMintValidationParams calldata signedMintValidationParams
    ) external;

    function updatePayer(address payer, bool allowed) external;
}
