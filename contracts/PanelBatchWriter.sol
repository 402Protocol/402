// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Four02ReputationRegistryV2} from "./Four02ReputationRegistryV2.sol";

/// @title PanelBatchWriter
/// @notice Keeper-gated batch writer that records per-epoch reviewer-panel
///         scores into Four02ReputationRegistryV2.
///
/// @dev The owner allowlists THIS contract via the registry's `addWriter`,
///      then a designated keeper submits one batch per epoch. One job, one
///      function: `submitBatch`. Nothing here moves funds, settles disputes,
///      or touches escrow state — panels are advisory + reputation only.
///
/// @dev EVENT MAPPING (read before auditing — this is a deliberate compromise):
///      The deployed V2 registry's EventType enum is fixed (0-9, non-upgradeable
///      by design) and has no review/panel variant, so panel scores are recorded
///      as `EventType.EscrowCompleted` with:
///        - value = quorum-agreement rate in BASIS POINTS (0-10000), NOT USDC.
///          The registry's `value` field is documented as "USDC (6 decimals)
///          where applicable, else 0" — for panel events USDC is not applicable,
///          so bps are used instead. This does NOT corrupt derived scores:
///          `_reliability` ignores EscrowCompleted entirely, and `_disputeRate`
///          uses event weights, never values. The `events` mapping is public,
///          so the bps are directly readable onchain.
///        - refId = keccak256(abi.encodePacked("402:panel-review/v1", epochId, agentId))
///          which disambiguates panel events from real escrow completions in
///          the 8004 `readFeedback` views (tag1 reads "escrow_completed" for both).
///        - counterparty = address(0) (no counterparty to a review).
///      Known wart: each recorded event adds weight to `_disputeRate`'s
///      "completed commerce" denominator. This is bounded: the registry's
///      pairCompletionCap (currently 5) stops counting (agentId, 0) pairs after
///      5 epochs, and reviewers with no disputes are unaffected (0/x = 0).
///      The clean long-term fix is a registry V3 appending a dedicated
///      `PanelReviewed` variant (10) — encoding-stable, no migration of 0-9.
///      Until then, this mapping is the least-bad carrier.
///
/// @dev INTEGRATOR GUIDANCE (8004 consumers): tag1 "escrow_completed" mixes
///      real escrow completions with panel-review snapshots. Scope queries by
///      the `writer` field: panel events are written by THIS contract's
///      address, and their `value` is agreement-bps (0-10000), NOT USDC.
///      `readFeedback` does not expose `refId` — consumers needing the
///      panel/escrow disambiguation must read the public `events` mapping
///      directly (refId starts with keccak256("402:panel-review/v1",...)).
///
/// @dev Reviewer scores are quorum-signed EIP-712 attestations aggregated
///      offchain (see src/jobs/panel-keeper.ts). What lands onchain is a
///      per-epoch snapshot: LIFETIME agreement bps per reviewer as of the
///      epoch, not a delta. Attestations remain the audit trail; the chain
///      holds the commitment.
///
/// @dev epochId encoding: UTC day as YYYYMMDD * 1000 + chunkIndex, e.g.
///      epoch 20260929 chunk 0 -> 20260929000. The replay guard is per
///      (epoch, chunk) so the keeper can split large reviewer sets across
///      multiple transactions without re-submission collisions.
///      Freshness: the epoch's day must be within ±2 days of block.timestamp,
///      so a compromised keeper cannot pre-emptively squat future epochs.
///
/// @dev agentIds must be STRICTLY INCREASING. This kills duplicates and
///      forces a canonical batch order (the keeper sorts ascending), so the
///      batchHash commitment is unambiguous.
contract PanelBatchWriter is Ownable {
    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------

    /// @notice Emitted when a batch is recorded. batchHash commits to the
    ///         exact batch contents: keccak256(abi.encode(agentIds, agreementBps)).
    event BatchSubmitted(
        uint256 indexed epochId,
        uint256 count,
        bytes32 batchHash
    );

    /// @notice Emitted when a keeper rotation is proposed.
    event KeeperProposed(
        address indexed oldPending,
        address indexed newPending
    );

    /// @notice Emitted when the keeper changes.
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error NotKeeper();
    error NotProposedKeeper();
    error RenounceDisabled();
    error ZeroAddress();
    error InvalidEpochId();
    error EpochOutOfWindow();
    error EpochAlreadySubmitted();
    error BatchSizeInvalid();
    error LengthMismatch();
    error ZeroAgentId();
    error AgentIdsNotSorted();
    error ScoreOutOfRange();
    error BatchHashMismatch();

    // ------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------

    /// @notice The live reputation registry (immutable after deploy).
    Four02ReputationRegistryV2 public immutable REGISTRY;

    /// @notice Max agents per submitBatch call (bounds the loop's gas).
    /// @dev MEASURED (forge, cold storage, brand-new agents — worst case):
    ///      one recordCommerceEvent iteration costs ~290.5k gas, so
    ///      70 entries cost ~20.3M gas. Ink's block gas limit is 30M, leaving
    ///      ~10M headroom for the keeper's overhead and RPC variance.
    ///      The previous value of 200 would need ~58M gas and could NEVER
    ///      land onchain — a liveness brick. Repeat-reviewer batches are
    ///      cheaper (warm storage), so 70 is a conservative worst-case cap.
    uint256 public constant MAX_BATCH = 70;

    /// @notice Address allowed to call submitBatch (two-step rotation).
    address public keeper;

    /// @notice Pending keeper awaiting acceptKeeper() (zero = none).
    address public pendingKeeper;

    /// @notice epochId => already submitted (replay guard).
    mapping(uint256 => bool) public epochSubmitted;

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /// @param registry_ Four02ReputationRegistryV2 to write to.
    /// @param keeper_ Initial keeper address (the batch-submission bot/EOA).
    /// @param initialOwner Contract owner (timelock/multisig at deploy).
    constructor(
        address registry_,
        address keeper_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (registry_ == address(0)) revert ZeroAddress();
        if (keeper_ == address(0)) revert ZeroAddress();
        REGISTRY = Four02ReputationRegistryV2(registry_);
        keeper = keeper_;
    }

    // ------------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------------

    /// @notice Renouncing ownership is disabled: it would brick keeper
    ///         rotation (proposeKeeper is owner-only) forever.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Propose a new keeper. The proposal takes effect only when the
    ///         proposed address calls acceptKeeper() — a fat-fingered address
    ///         can never lock the keeper role.
    function proposeKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        address oldPending = pendingKeeper;
        pendingKeeper = newKeeper;
        emit KeeperProposed(oldPending, newKeeper);
    }

    /// @notice Accept a pending keeper proposal. Only the proposed address.
    function acceptKeeper() external {
        address p = pendingKeeper;
        if (p == address(0) || msg.sender != p) revert NotProposedKeeper();
        address oldKeeper = keeper;
        keeper = p;
        pendingKeeper = address(0);
        emit KeeperUpdated(oldKeeper, p);
    }

    // ------------------------------------------------------------------------
    // Keeper
    // ------------------------------------------------------------------------

    /// @notice Record one epoch's reviewer scores.
    /// @dev Whole batch reverts on any bad entry (zero/unsorted agentId,
    ///      bps > 10000, length mismatch, hash mismatch, stale/future epoch):
    ///      no silent partial writes — the keeper fixes the input and
    ///      resubmits the epoch. The replay guard is set BEFORE the loop
    ///      (checks-effects-interactions); a mid-loop revert rolls the whole
    ///      transaction back, leaving the epoch unsubmitted.
    /// @param epochId YYYYMMDD * 1000 + chunkIndex (see dev note above);
    ///        the day component must be within ±2 days of block.timestamp.
    /// @param agentIds ERC-8004 reviewer agent ids, strictly increasing.
    /// @param agreementBps Quorum-agreement rate per agent, 0-10000.
    /// @param batchHash keccak256(abi.encode(agentIds, agreementBps)) —
    ///        committed onchain so anyone can verify the keeper's batch
    ///        instead of trusting it.
    function submitBatch(
        uint256 epochId,
        uint256[] calldata agentIds,
        uint256[] calldata agreementBps,
        bytes32 batchHash
    ) external {
        if (msg.sender != keeper) revert NotKeeper();
        if (epochId == 0) revert InvalidEpochId();
        _checkEpochFresh(epochId);
        if (epochSubmitted[epochId]) revert EpochAlreadySubmitted();
        if (agentIds.length != agreementBps.length) revert LengthMismatch();
        if (agentIds.length == 0 || agentIds.length > MAX_BATCH)
            revert BatchSizeInvalid();
        if (batchHash != keccak256(abi.encode(agentIds, agreementBps)))
            revert BatchHashMismatch();

        epochSubmitted[epochId] = true;

        // Emitted before the loop (checks-effects-interactions): a revert
        // rolls the event back with everything else, so a mined
        // BatchSubmitted always means the full batch landed.
        emit BatchSubmitted(epochId, agentIds.length, batchHash);

        uint256 prev = 0;
        for (uint256 i = 0; i < agentIds.length; i++) {
            uint256 agentId = agentIds[i];
            if (agentId == 0) revert ZeroAgentId();
            if (agentId <= prev) revert AgentIdsNotSorted();
            prev = agentId;
            uint256 bps = agreementBps[i];
            if (bps > 10_000) revert ScoreOutOfRange();
            REGISTRY.recordCommerceEvent(
                agentId,
                Four02ReputationRegistryV2.EventType.EscrowCompleted,
                bps,
                keccak256(
                    abi.encodePacked("402:panel-review/v1", epochId, agentId)
                ),
                address(0)
            );
        }
    }

    // ------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------

    /// @notice Revert unless the epoch's UTC day is within ±2 days of now.
    /// @dev Kills pre-emptive epoch griefing: a compromised keeper cannot
    ///      squat far-future epochIds to block legitimate later batches.
    function _checkEpochFresh(uint256 epochId) internal view {
        uint256 epochDay = epochId / 1000;
        uint256 y = epochDay / 10000;
        uint256 m = (epochDay / 100) % 100;
        uint256 d = epochDay % 100;
        if (y < 2020 || y > 2200 || m == 0 || m > 12) revert EpochOutOfWindow();
        if (d == 0 || d > _daysInMonth(y, m)) revert EpochOutOfWindow();
        uint256 epochDays = _daysFromCivil(y, m, d);
        uint256 today = block.timestamp / 86400;
        // |epochDays - today| <= 2, underflow-safe on uint256.
        if (epochDays > today + 2 || epochDays + 2 < today)
            revert EpochOutOfWindow();
    }

    /// @notice Days in a Gregorian month (proleptic).
    function _daysInMonth(uint256 y, uint256 m) internal pure returns (uint256) {
        if (m == 2) {
            bool leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
            return leap ? 29 : 28;
        }
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30;
        return 31;
    }

    /// @notice Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    function _daysFromCivil(
        uint256 y,
        uint256 m,
        uint256 d
    ) internal pure returns (uint256) {
        unchecked {
            y -= m <= 2 ? 1 : 0;
            uint256 era = y / 400;
            uint256 yoe = y - era * 400; // [0, 399]
            uint256 mp = (m + 9) % 12; // [0, 11]
            uint256 doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
            uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
            return era * 146097 + doe - 719468;
        }
    }
}
