// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Reputation
/// @notice Lightweight v0 reputation ledger for 402 providers.
/// Only the AgentEscrow contract that deployed this ledger may record outcomes.
/// @dev Score formula: completed / (completed + lostDisputes), scaled to bps.
/// Known limits (see README): sybil-vulnerable (a fresh address starts with a
/// blank slate), unweighted by job value, and dispute outcomes are binary —
/// a 90/10 arbiter split counts the same as a 51/49 one. v0 on purpose.
contract Reputation {
    error OnlyEscrow();
    error ZeroAddress();

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice The escrow contract allowed to record outcomes. Immutable.
    address public immutable escrow;

    mapping(address => uint256) public completedJobs;
    mapping(address => uint256) public lostDisputes;

    event CompletionRecorded(address indexed provider, uint256 totalCompleted);
    event LostDisputeRecorded(address indexed provider, uint256 totalLost);

    constructor(address escrow_) {
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert OnlyEscrow();
        _;
    }

    /// @notice Record a successfully completed job for `provider`.
    function recordCompletion(address provider) external onlyEscrow {
        unchecked {
            completedJobs[provider] += 1;
        }
        emit CompletionRecorded(provider, completedJobs[provider]);
    }

    /// @notice Record a dispute the provider lost.
    function recordLostDispute(address provider) external onlyEscrow {
        unchecked {
            lostDisputes[provider] += 1;
        }
        emit LostDisputeRecorded(provider, lostDisputes[provider]);
    }

    /// @notice Provider score in bps: completed*10000/(completed+lost).
    /// Returns 0 for providers with no history — "unknown", not "untrusted".
    function score(address provider) external view returns (uint256) {
        uint256 completed = completedJobs[provider];
        uint256 lost = lostDisputes[provider];
        uint256 total = completed + lost;
        if (total == 0) return 0;
        return (completed * BPS_DENOMINATOR) / total;
    }

    /// @notice Full stat line for a provider.
    function stats(address provider)
        external
        view
        returns (uint256 completed, uint256 lost, uint256 scoreBps, bool hasHistory)
    {
        completed = completedJobs[provider];
        lost = lostDisputes[provider];
        hasHistory = (completed + lost) > 0;
        scoreBps = hasHistory ? (completed * BPS_DENOMINATOR) / (completed + lost) : 0;
    }
}
