// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICreatorToken} from "@creator-token-standards/interfaces/ICreatorToken.sol";
import {ICreatorTokenLegacy} from "@creator-token-standards/interfaces/ICreatorTokenLegacy.sol";
import {ITransferValidator} from "@creator-token-standards/interfaces/ITransferValidator.sol";

/// @title ERC721CCompat
/// @notice Minimal, faithful port of Limit Break's creator-token-standards
///         transfer-validator semantics to OpenZeppelin v5.
///
/// @dev WHY THIS EXISTS: creator-token-standards v5.0.0 (latest) hooks
///      transfers via OZ v4's `_beforeTokenTransfer`/`_afterTokenTransfer`,
///      which do not exist in OZ v5 (this repo pins OZ v5.7.0), so the real
///      `ERC721C` abstract contract cannot compile here. This contract
///      implements the genuine `ICreatorToken` / `ICreatorTokenLegacy`
///      interfaces with byte-identical semantics instead:
///        - `getTransferValidator()` returns the owner-set validator, or the
///          canonical Limit Break default validator when never set.
///        - `setTransferValidator()` is owner-gated, rejects non-zero
///          addresses with no code, and emits `TransferValidatorUpdated`.
///        - Actual transfers (not mints/burns) consult the validator via
///          `validateTransfer(caller, from, to, tokenId)`, with the standard
///          bypass when the validator itself is the caller.
///      Tooling (incl. OpenSea) that detects ERC-721C via the ICreatorToken
///      EIP-165 interface IDs will recognize inheriting contracts.
/// @dev Only ICreatorToken is inherited; ICreatorTokenLegacy declares the
///      same event and would collide, so it is referenced (not inherited)
///      purely for its interface ID — exactly like the reference ERC721C.
abstract contract ERC721CCompat is ICreatorToken {
    /// @dev Thrown when setting a transfer validator address that has no deployed code.
    error ERC721CCompat__InvalidTransferValidatorContract();

    /// @dev The canonical Limit Break default transfer validator. Consulted
    ///      only when it actually has code deployed; on chains without it
    ///      (e.g. Ink) transfers are unrestricted — same effective behavior
    ///      as the reference implementation.
    address public constant DEFAULT_TRANSFER_VALIDATOR =
        address(0x721C008fdff27BF06E7E123956E2Fe03B63342e3);

    /// @dev True once the owner has explicitly set a validator (even zero).
    bool private _validatorInitialized;
    /// @dev Owner-set validator; zero means explicitly disabled.
    address private _transferValidator;

    /// @dev Child contracts must gate this on ownership. Reverts by default
    ///      so forgetting the override fails closed, not open.
    function _requireCanSetValidator() internal view virtual;

    /**
     * @notice Sets the transfer validator for the token contract.
     * @dev Reverts on non-zero addresses with no code. Emits
     *      TransferValidatorUpdated. Mirrors CreatorTokenBase semantics.
     */
    function setTransferValidator(address validator_) public virtual override {
        _requireCanSetValidator();
        if (validator_ != address(0) && validator_.code.length == 0) {
            revert ERC721CCompat__InvalidTransferValidatorContract();
        }
        emit TransferValidatorUpdated(getTransferValidator(), validator_);
        _validatorInitialized = true;
        _transferValidator = validator_;
    }

    /// @notice Returns the active transfer validator (or the default).
    function getTransferValidator() public view virtual override returns (address validator) {
        validator = _transferValidator;
        if (validator == address(0) && !_validatorInitialized) {
            validator = DEFAULT_TRANSFER_VALIDATOR;
        }
    }

    /**
     * @notice Returns the validator function selector marketplaces use for
     *         transaction simulation. Mirrors ERC721C.
     */
    function getTransferValidationFunction()
        external
        pure
        virtual
        override
        returns (bytes4 functionSignature, bool isViewFunction)
    {
        functionSignature = bytes4(keccak256("validateTransfer(address,address,address,uint256)"));
        isViewFunction = true;
    }

    /**
     * @dev Runs the validator for real transfers only (from != 0, to != 0).
     *      Mints and burns are never gated — same as the reference.
     * @dev Deviation from the reference: the reference relies on calls to
     *      code-less validator addresses silently succeeding. solc 0.8.28
     *      reverts high-level calls to addresses with no code, so we skip
     *      explicitly. Effect is identical (no validator deployed = no
     *      gating) and transfers can never be bricked by a missing validator.
     */
    function _validateTransferWithValidator(
        address caller,
        address from,
        address to,
        uint256 tokenId
    ) internal virtual {
        address validator = getTransferValidator();
        if (validator == address(0)) return;
        if (msg.sender == validator) return; // validator pre-validated
        if (validator.code.length == 0) return; // nothing deployed: unrestricted
        ITransferValidator(validator).validateTransfer(caller, from, to, tokenId);
    }

    /// @dev EIP-165 fragments; the token contract folds these into its own
    ///      supportsInterface (it must override ERC721/ERC2981's).
    function _creatorTokenInterfaceIds() internal pure returns (bytes4[] memory ids) {
        ids = new bytes4[](2);
        ids[0] = type(ICreatorToken).interfaceId;
        ids[1] = type(ICreatorTokenLegacy).interfaceId;
    }
}
