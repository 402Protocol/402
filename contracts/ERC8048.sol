// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Four Zero Two Labs, Inc.
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/// @title ERC8048 — Onchain Metadata reference (draft ERC-8048)
/// @notice Reusable onchain key-value metadata for ERC-721 collections on Ink.
///         Implements the draft's required core exactly:
///           - metadata(uint256 tokenId, string key) -> bytes
///           - MetadataSet(uint256 indexed tokenId, string indexed indexedKey,
///                        string key, bytes value)
///           - ERC-165 interface id 0xdf670be1
///         Write policy is the inheriting contract's decision: call
///         _setMetadata from your own owner/authority-gated functions.
///         Includes an optional permanent per-key lock (402 extension, not in
///         the draft): once a key is locked, it can never be written again —
///         the "nobody can rewrite the soul, not even us" guarantee. Lock
///         post-reveal.
/// @dev Values are bytes; store UTF-8 text with bytes(string). The ERC-721T
///      agent profile reserves keys: "context", "endpoint[<type>]",
///      "address[<chain-id>]". tokenURI is untouched by this module.
abstract contract ERC8048 is ERC165 {
    /// @notice ERC-165 interface id of the draft's IERC8048Metadata.
    bytes4 internal constant _IERC8048_ID = 0xdf670be1;

    /// @notice tokenId => key => value (bytes).
    mapping(uint256 => mapping(string => bytes)) internal _onchainMetadata;
    /// @notice Permanently locked keys (402 extension).
    mapping(string => bool) public metadataLocked;

    event MetadataSet(
        uint256 indexed tokenId, string indexed indexedKey, string key, bytes value
    );
    /// @notice Emitted when a metadata key is permanently locked (402 extension).
    event MetadataKeyLocked(string key);

    error MetadataLocked(string key);
    error EmptyKey();

    /// @notice Get the onchain metadata value for a tokenId/key pair.
    /// @dev Returns empty bytes when unset. The draft does not require the
    ///      token to exist; existence checks are the caller's policy.
    function metadata(uint256 tokenId, string calldata key)
        external
        view
        virtual
        returns (bytes memory)
    {
        return _onchainMetadata[tokenId][key];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override
        returns (bool)
    {
        return interfaceId == _IERC8048_ID || super.supportsInterface(interfaceId);
    }

    /// @dev Write a value. Reverts on empty keys and locked keys. Emits
    ///      the draft's required MetadataSet event. Gate this in the
    ///      inheriting contract (owner-only, authority, etc.).
    function _setMetadata(uint256 tokenId, string calldata key, bytes calldata value)
        internal
    {
        if (bytes(key).length == 0) revert EmptyKey();
        if (metadataLocked[key]) revert MetadataLocked(key);
        _onchainMetadata[tokenId][key] = value;
        emit MetadataSet(tokenId, key, key, value);
    }

    /// @dev Permanently lock a key. Irreversible — lock only when every
    ///      token's value for the key is final.
    function _lockMetadata(string calldata key) internal {
        if (bytes(key).length == 0) revert EmptyKey();
        metadataLocked[key] = true;
        emit MetadataKeyLocked(key);
    }
}
