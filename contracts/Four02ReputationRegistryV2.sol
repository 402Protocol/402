// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Four Zero Two Labs, Inc.
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Four02ReputationRegistryV2
/// @notice ERC-8004-compatible reputation registry for the 402 agent economy.
///
/// @dev V2 supersedes Four02ReputationRegistry (0x33E2c56035C059553a37a3A56199B5b5b3DA3365,
///      deployed 2026-09-25, superseded with an EMPTY writer allowlist and zero
///      recorded rows — nothing to migrate). The ONLY behavioral delta is the
///      appended EventType.WorkerGhosted (variant 9): existing variant
///      encodings (0-8) are unchanged, and all existing views behave
///      identically for the old event types. New contract, new deploy — the
///      old registry is abandoned, not upgraded.
/// @dev Design (see specs/2026-09-25-reputation-registry.md):
/// - Reputation is derived from verifiable onchain COMMERCE events, not
///   opinions. The only write path is recordCommerceEvent, callable solely by
///   allowlisted 402 protocol contracts (invoice registry, escrow vault,
///   arbitration). There is no public feedback, no review-bombing, no sybil
///   reviews. The 8004 write functions (giveFeedback, revokeFeedback,
///   appendResponse) are deliberately NOT implemented.
/// - Raw events are append-only and permanent. Scores are derived VIEW
///   functions over the raw log, so weights and windows can be retuned by the
///   owner without migrating history. Headline scores decay linearly to zero
///   over `decayWindow` (default 365 days); the raw history never fades.
/// - Keyed to ERC-8004 agentId (uint256), so reputation survives wallet
///   rotation. This contract never consults an identity registry and does not
///   know about TRACES; TRACES (and anything else) reads this registry.
/// - The standard ERC-8004 read interface (getLastIndex, readFeedback,
///   getSummary, readAllFeedback, getResponseCount, getClients,
///   getIdentityRegistry, getVersion) is preserved with identical function
///   names, parameters, and return shapes so existing 8004 tooling can query
///   this registry. In 8004 terms, each authorized writer contract plays the
///   role of a feedback "client".
/// - Non-upgradeable by design (same posture as AgentEscrow/TracesLicense).
///   Deploy with a timelock + multisig as owner; the owner controls the
///   writer allowlist and score weights.
/// - All data is public onchain by design: reputation is a sunlight system.
contract Four02ReputationRegistryV2 is Ownable {
    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------

    /// @notice Commerce event kinds a 402 protocol contract can record.
    /// @dev ENCODING STABILITY: existing variants (0-8) keep their values
    ///      from V1. WorkerGhosted is appended LAST (9) so onchain history
    ///      and 8004 tag filters never shift. Never insert before it.
    enum EventType {
        InvoicePaidOnTime, // 0
        InvoicePaidLate, // 1
        InvoiceUnpaid, // 2
        EscrowCompleted, // 3
        DisputeOpened, // 4
        DisputeWithdrawn, // 5
        DisputeResolved, // 6
        ArbitrationWon, // 7
        ArbitrationLost, // 8
        WorkerGhosted // 9
    }

    /// @notice One append-only commerce event for an agent.
    /// @param eventType Kind of commerce event.
    /// @param value USDC amount (6 decimals) where applicable, else 0.
    /// @param timestamp When the event was recorded.
    /// @param refId Writer-defined correlation id (e.g. invoice or dispute
    ///        id). Pairs a DisputeOpened with its DisputeWithdrawn.
    /// @param writer The authorized 402 protocol contract that recorded it.
    /// @param counterparty The other party to the commerce event, if any.
    struct CommerceEvent {
        EventType eventType;
        uint256 value;
        uint64 timestamp;
        bytes32 refId;
        address writer;
        address counterparty;
    }

    /// @notice Point-in-time reputation snapshot for an agent.
    /// @param reliability 0-100, value-weighted payment reliability.
    /// @param disputeRateBps Active dispute signals (unwithdrawn AND
    ///        unresolved DisputeOpened + WorkerGhosted) per completed
    ///        commerce event, in basis points (10000 = 100%).
    /// @param arbitrationWins Lifetime arbitration wins (no decay).
    /// @param arbitrationLosses Lifetime arbitration losses (no decay).
    /// @param totalEvents Raw event count (never decays).
    /// @param lastEventTimestamp Timestamp of the newest event (0 if none).
    struct AgentSummary {
        uint256 reliability;
        uint256 disputeRateBps;
        uint256 arbitrationWins;
        uint256 arbitrationLosses;
        uint256 totalEvents;
        uint64 lastEventTimestamp;
    }

    /// @dev Internal carrier for readAllFeedback's seven return arrays
    ///      (keeps any single function under the stack limit).
    struct FeedbackArrays {
        address[] clients;
        uint64[] feedbackIndexes;
        int128[] values;
        uint8[] valueDecimals;
        string[] tag1s;
        string[] tag2s;
        bool[] revokedStatuses;
    }

    /// @dev Packed 8004 tag-filter hashes (one stack slot instead of three).
    struct TagHashes {
        bytes32 tag1;
        bytes32 tag2;
        bytes32 empty;
    }

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    /// @notice Emitted on every recorded commerce event.
    event CommerceEventRecorded(
        uint256 indexed agentId,
        EventType indexed eventType,
        uint256 value,
        bytes32 indexed refId,
        address writer,
        address counterparty
    );
    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);
    event WeightsUpdated(uint256 onTimeWeightBps, uint256 lateWeightBps);
    event GhostPenaltyUpdated(uint256 ghostPenaltyUsdc);
    event DecayWindowUpdated(uint256 decayWindow);
    event PairCompletionCapUpdated(uint256 pairCompletionCap);

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error NotWriter();
    error ZeroAddress();
    error NotContract(); // addWriter: writers must be contracts, not EOAs
    error ZeroAgentId();
    error EmptyClientList();
    error FeedbackIndexOutOfBounds();
    error ValueTooLarge();
    error BadWeight();
    error BadGhostPenalty();
    error BadDecayWindow();
    error BadPairCap();

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------

    /// @notice agentId => all commerce events, append-only.
    mapping(uint256 => CommerceEvent[]) public events;

    /// @notice agentId => writer => indices into events[agentId].
    /// @dev Backs the 8004 per-client feedback indexing (1-indexed externally).
    mapping(uint256 => mapping(address => uint256[])) private _writerEventIdx;

    /// @notice agentId => writers that have recorded for the agent.
    /// @dev The 8004 "clients" of an agent.
    mapping(uint256 => address[]) private _writersOf;
    mapping(uint256 => mapping(address => bool)) private _writerSeen;

    /// @notice agentId => refId => a DisputeWithdrawn was recorded.
    /// @dev A withdrawn dispute neutralizes its DisputeOpened in disputeRate.
    mapping(uint256 => mapping(bytes32 => bool)) private _disputeWithdrawn;

    /// @notice agentId => refId => a DisputeResolved was recorded.
    /// @dev A RESOLVED dispute is no longer an ACTIVE signal: it neutralizes
    ///      its DisputeOpened in disputeRate (the arbitration outcome itself
    ///      stays visible in arbitrationRecord). Without this, any party
    ///      could permanently ding a worker's disputeRate by raising a
    ///      dispute the worker then WINS — the scar would outlive the
    ///      exoneration. WorkerGhosted is never neutralized: a no-show is
    ///      terminal, there is nothing to withdraw or resolve.
    mapping(uint256 => mapping(bytes32 => bool)) private _disputeResolved;

    /// @notice 402 protocol contracts allowed to record commerce events.
    mapping(address => bool) public isWriter;

    /// @notice Credit for on-time invoice value, in basis points (10000 = 100%).
    uint256 public onTimeWeightBps = 10_000;
    /// @notice Credit for late invoice value, in basis points (5000 = 50%).
    uint256 public lateWeightBps = 5_000;
    /// @notice USDC-denominated penalty (6 decimals) added to reliability's
    /// denominator per WorkerGhosted event, with zero credit. Default $100:
    /// ghosting one bounty halves a one-$100-clean-invoice reliability.
    /// Owner-retunable like the other weights; scores are derived views, so
    /// retuning takes effect immediately with no history migration.
    /// Capped at MAX_GHOST_PENALTY_USDC: an uncapped penalty could overflow
    /// the reliability math and brick the view for ghosted agents.
    uint256 public ghostPenaltyUsdc = 100_000_000;
    /// @notice Linear decay window for headline scores (default 365 days).
    /// Capped at MAX_DECAY_WINDOW for the same overflow reason.
    uint256 public decayWindow = 365 days;

    /// @notice Upper bound for setGhostPenalty ($1M USDC, 6 decimals).
    /// 10,000x the default: generous headroom, still overflow-safe in the
    /// reliability math (penalty * decayWindow stays far below 2^256).
    uint256 public constant MAX_GHOST_PENALTY_USDC = 1_000_000_000_000;
    /// @notice Upper bound for setDecayWindow (10 years). Keeps
    /// (decayWindow * 10_000) and (value * decayWeight * weightBps) inside
    /// uint256 for every reachable input.
    uint256 public constant MAX_DECAY_WINDOW = 3650 days;
    /// @notice Upper bound for setPairCompletionCap. The cap is a count, not
    /// a value, so 1000 is far beyond any honest pair's completions while
    /// keeping the mapping math trivially safe.
    uint256 public constant MAX_PAIR_COMPLETION_CAP = 1000;

    /// @notice agentId => counterparty => counted EscrowCompleted events.
    /// @dev F1 anti-farming: two colluding wallets can recycle bounty capital
    /// (the M2 guard only blocks same-wallet self-dealing) and manufacture a
    /// perfect worker resume for ~$40/50 jobs. Completions beyond
    /// pairCompletionCap from the same (agentId, counterparty) pair are still
    /// appended to the raw log (sunlight preserved) but excluded from the
    /// score math via _eventCounted.
    mapping(uint256 => mapping(address => uint64)) private _pairCompletions;

    /// @notice agentId => event index (at append time) => whether the event
    /// counts in the derived score views (_reliability, _disputeRate).
    /// @dev Only EscrowCompleted events can be uncounted (F1 pair cap).
    /// Ghost and dispute events are NEVER capped: accountability signals are
    /// uncapped by design. The 8004 read interface (readFeedback et al.)
    /// shows ALL events regardless — sunlight, not scoring, is its job.
    mapping(uint256 => mapping(uint256 => bool)) private _eventCounted;

    /// @notice Max COUNTED EscrowCompleted events per (agentId, counterparty)
    /// pair. Default 5: an honest worker rarely completes 5+ paid jobs for
    /// the same payer without the relationship being real economic activity
    /// (and even then, the raw events stay visible). Owner-retunable like the
    /// other score params; applies prospectively to newly recorded events
    /// (already-marked events keep their counted/uncounted flags).
    uint256 public pairCompletionCap = 5;

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /// @param initialOwner Should be a timelock + multisig at deploy.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ------------------------------------------------------------------------
    // Writes (authorized writers only)
    // ------------------------------------------------------------------------

    /// @notice Record one commerce event for an agent.
    /// @dev Callable only by allowlisted 402 protocol contracts. Writers are
    ///      trusted to report truthfully and in causal order (e.g. a
    ///      DisputeWithdrawn after its DisputeOpened, sharing refId).
    /// @param agentId ERC-8004 agent id (must be nonzero).
    /// @param eventType Kind of commerce event.
    /// @param value USDC amount (6 decimals) where applicable, else 0.
    /// @param refId Writer-defined correlation id (pairs disputes).
    /// @param counterparty The other party, if any (else address(0)).
    function recordCommerceEvent(
        uint256 agentId,
        EventType eventType,
        uint256 value,
        bytes32 refId,
        address counterparty
    ) external {
        if (!isWriter[msg.sender]) revert NotWriter();
        if (agentId == 0) revert ZeroAgentId();
        // Values must fit int128: readFeedback/getSummary expose them as
        // int128, and the reliability math multiplies value by the decay
        // weight — an uncapped value could overflow and brick the views for
        // the agent. Writers are trusted, this is defense in depth.
        if (value > uint256(int256(type(int128).max))) revert ValueTooLarge();

        events[agentId].push(
            CommerceEvent({
                eventType: eventType,
                value: value,
                timestamp: uint64(block.timestamp),
                refId: refId,
                writer: msg.sender,
                counterparty: counterparty
            })
        );
        uint256 newIndex = events[agentId].length - 1;
        _writerEventIdx[agentId][msg.sender].push(newIndex);
        if (!_writerSeen[agentId][msg.sender]) {
            _writerSeen[agentId][msg.sender] = true;
            _writersOf[agentId].push(msg.sender);
        }
        // F1: cap COUNTED completions per (agentId, counterparty) pair. The
        // event is always appended (sunlight); beyond the cap it is simply
        // excluded from the score views. Ghost/dispute events are never
        // capped — accountability is uncapped.
        bool counted = true;
        if (eventType == EventType.EscrowCompleted) {
            uint64 pairCount = _pairCompletions[agentId][counterparty];
            if (pairCount >= pairCompletionCap) {
                counted = false;
            } else {
                _pairCompletions[agentId][counterparty] = pairCount + 1;
            }
        }
        _eventCounted[agentId][newIndex] = counted;
        if (eventType == EventType.DisputeWithdrawn) {
            _disputeWithdrawn[agentId][refId] = true;
        }
        if (eventType == EventType.DisputeResolved) {
            _disputeResolved[agentId][refId] = true;
        }

        emit CommerceEventRecorded(agentId, eventType, value, refId, msg.sender, counterparty);
    }

    // ------------------------------------------------------------------------
    // Writer allowlist (owner only)
    // ------------------------------------------------------------------------

    /// @notice Authorize a 402 protocol contract to record commerce events.
    /// @dev Writers must be contracts: an EOA can sign transactions
    /// directly, so allowlisting one would hand a single key unconstrained,
    /// unaudited reputation-write power over every agentId — outside the
    /// "trusted protocol contract" assumption the allowlist documents. A
    /// malicious owner could still deploy a malicious writer contract, but
    /// that is at least a deliberate, reviewable deployment, not a pasted
    /// address.
    function addWriter(address writer) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        if (writer.code.length == 0) revert NotContract();
        isWriter[writer] = true;
        emit WriterAdded(writer);
    }

    /// @notice Revoke a writer's authorization (its past events stay onchain).
    function removeWriter(address writer) external onlyOwner {
        isWriter[writer] = false;
        emit WriterRemoved(writer);
    }

    // ------------------------------------------------------------------------
    // Score tuning (owner only)
    // ------------------------------------------------------------------------

    /// @notice Retune reliability weights. Scores are derived views, so this
    ///         takes effect immediately with no history migration.
    /// @param onTimeWeightBps_ Credit per on-time value (<= 10000).
    /// @param lateWeightBps_ Credit per late value (<= 10000).
    function setWeights(uint256 onTimeWeightBps_, uint256 lateWeightBps_) external onlyOwner {
        if (onTimeWeightBps_ > 10_000 || lateWeightBps_ > 10_000) revert BadWeight();
        onTimeWeightBps = onTimeWeightBps_;
        lateWeightBps = lateWeightBps_;
        emit WeightsUpdated(onTimeWeightBps_, lateWeightBps_);
    }

    /// @notice Retune the WorkerGhosted reliability penalty. Scores are
    ///         derived views, so this takes effect immediately with no
    ///         history migration.
    /// @param ghostPenaltyUsdc_ USDC (6 decimals) added per ghost to
    ///        reliability's denominator, with zero credit. Must be nonzero
    ///        (a zero penalty would make ghosts invisible to reliability)
    ///        and at most MAX_GHOST_PENALTY_USDC (overflow safety).
    function setGhostPenalty(uint256 ghostPenaltyUsdc_) external onlyOwner {
        if (ghostPenaltyUsdc_ == 0 || ghostPenaltyUsdc_ > MAX_GHOST_PENALTY_USDC) revert BadGhostPenalty();
        ghostPenaltyUsdc = ghostPenaltyUsdc_;
        emit GhostPenaltyUpdated(ghostPenaltyUsdc_);
    }

    /// @notice Retune the linear decay window for headline scores.
    /// @param decayWindow_ Must be nonzero and at most MAX_DECAY_WINDOW
    ///        (overflow safety — the reliability math multiplies by it).
    function setDecayWindow(uint256 decayWindow_) external onlyOwner {
        if (decayWindow_ == 0 || decayWindow_ > MAX_DECAY_WINDOW) revert BadDecayWindow();
        decayWindow = decayWindow_;
        emit DecayWindowUpdated(decayWindow_);
    }

    /// @notice Retune the per-pair completion cap (F1 anti-farming).
    /// @param pairCompletionCap_ Max COUNTED EscrowCompleted events per
    ///        (agentId, counterparty) pair; at most MAX_PAIR_COMPLETION_CAP.
    ///        Applies to subsequently recorded events: events already marked
    ///        counted/uncounted keep their flags (no history migration, and
    ///        no silent rewrite of past scores). 0 is allowed (no completion
    ///        ever counts) but not recommended — it neuters the disputeRate
    ///        denominator for escrow completions.
    function setPairCompletionCap(uint256 pairCompletionCap_) external onlyOwner {
        if (pairCompletionCap_ > MAX_PAIR_COMPLETION_CAP) revert BadPairCap();
        pairCompletionCap = pairCompletionCap_;
        emit PairCompletionCapUpdated(pairCompletionCap_);
    }

    // ------------------------------------------------------------------------
    // Derived scores (views over the raw log)
    // ------------------------------------------------------------------------

    /// @notice Payment reliability, 0-100, value-weighted with linear decay.
    /// @dev 100 * (onTimeW*onTimeVal + lateW*lateVal) / (totalInvoiceVal +
    ///      ghostPenaltyUsdc * ghostCount). WorkerGhosted events add the
    ///      owner-set USDC penalty to the denominator with zero credit, so a
    ///      no-show dings reliability meaningfully regardless of the
    ///      (zero-valued) event value. Returns 0 when there is no
    ///      (undecayed) invoice or ghost history.
    function reliability(uint256 agentId) external view returns (uint256) {
        return _reliability(agentId);
    }

    /// @notice Active dispute signals per completed commerce event, in bps.
    /// @dev Dispute signals = DisputeOpened neutralized by NEITHER a
    ///      matching DisputeWithdrawn NOR a matching DisputeResolved (same
    ///      refId), PLUS WorkerGhosted (a ghost is a dispute signal and is
    ///      never withdrawn or resolved). A resolved dispute is no longer
    ///      active — the arbitration outcome stays visible in
    ///      arbitrationRecord. Completed commerce = escrows completed +
    ///      invoices paid (on time or late). F2: with no (undecayed)
    ///      completed commerce but active dispute signals, returns 10000
    ///      (a worker with only ghosts/disputes must not show a clean 0);
    ///      returns 0 only when there are no signals at all.
    function disputeRate(uint256 agentId) external view returns (uint256) {
        return _disputeRate(agentId);
    }

    /// @notice Lifetime arbitration (wins, losses). Raw counts, no decay.
    function arbitrationRecord(uint256 agentId) external view returns (uint256 wins, uint256 losses) {
        return _arbitrationRecord(agentId);
    }

    /// @notice One-shot reputation snapshot for an agent.
    function summary(uint256 agentId) external view returns (AgentSummary memory) {
        (uint256 wins, uint256 losses) = _arbitrationRecord(agentId);
        CommerceEvent[] storage evts = events[agentId];
        uint256 n = evts.length;
        return AgentSummary({
            reliability: _reliability(agentId),
            disputeRateBps: _disputeRate(agentId),
            arbitrationWins: wins,
            arbitrationLosses: losses,
            totalEvents: n,
            lastEventTimestamp: n == 0 ? 0 : evts[n - 1].timestamp
        });
    }

    /// @notice Raw event count for an agent (never decays).
    function getEventCount(uint256 agentId) external view returns (uint256) {
        return events[agentId].length;
    }

    // ------------------------------------------------------------------------
    // ERC-8004 read interface (function names, params, return shapes preserved)
    // ------------------------------------------------------------------------

    /// @notice ERC-8004: number of feedback entries a client recorded for an agent.
    /// @dev Here "client" is the authorized writer contract.
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(_writerEventIdx[agentId][clientAddress].length);
    }

    /// @notice ERC-8004: read one feedback entry (1-indexed).
    /// @dev Maps a commerce event onto 8004 feedback: value is the USDC amount
    ///      (6 decimals), tag1 is the event type, tag2 is the 402 namespace.
    ///      Nothing is ever revoked: withdrawals are separate events.
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        if (feedbackIndex == 0) revert FeedbackIndexOutOfBounds();
        uint256[] storage idx = _writerEventIdx[agentId][clientAddress];
        if (feedbackIndex > idx.length) revert FeedbackIndexOutOfBounds();
        CommerceEvent storage e = events[agentId][idx[feedbackIndex - 1]];
        if (e.value > uint256(int256(type(int128).max))) revert ValueTooLarge();
        return (int128(int256(e.value)), 6, _eventTypeName(e.eventType), "402:commerce", false);
    }

    /// @notice ERC-8004: average value of matching feedback entries.
    /// @dev Averages the USDC values of commerce events matching the writer
    ///      and tag filters (empty tag = no filter). Reverts on an empty
    ///      client list, like the reference implementation.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        if (clientAddresses.length == 0) revert EmptyClientList();
        (uint256 total, uint256 sum) = _summaryAll(agentId, clientAddresses, tag1, tag2);
        if (total == 0) return (0, 0, 0);
        uint256 avg = sum / total;
        if (avg > uint256(int256(type(int128).max))) revert ValueTooLarge();
        return (uint64(total), int128(int256(avg)), 6);
    }

    /// @notice ERC-8004: read all matching feedback entries.
    /// @dev includeRevoked is accepted for interface compatibility and ignored:
    ///      nothing is ever revoked (withdrawals are separate events), so the
    ///      result is identical either way. An empty client list reads all writers.
    /// @dev Return order (unchanged 8004 shape): clients, feedbackIndexes,
    ///      values, valueDecimals, tag1s, tag2s, revokedStatuses.
    ///      (Unnamed returns: names are not part of the ABI; this keeps the
    ///      function under solc's stack limit.)
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool /* includeRevoked */
    )
        external
        view
        returns (
            address[] memory,
            uint64[] memory,
            int128[] memory,
            uint8[] memory,
            string[] memory,
            string[] memory,
            bool[] memory
        )
    {
        FeedbackArrays memory out = _collectFeedback(agentId, clientAddresses, tag1, tag2);
        return (
            out.clients,
            out.feedbackIndexes,
            out.values,
            out.valueDecimals,
            out.tag1s,
            out.tag2s,
            out.revokedStatuses
        );
    }

    /// @notice ERC-8004: response count. Always 0: the commerce model has no
    ///         responses. Kept for interface compatibility.
    function getResponseCount(uint256, address, uint64, address[] calldata)
        external
        pure
        returns (uint64)
    {
        return 0;
    }

    /// @notice ERC-8004: writers ("clients") that recorded for an agent.
    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _writersOf[agentId];
    }

    /// @notice ERC-8004: identity registry address. Always address(0): 402
    ///         reputation is keyed to agentId directly and never consults an
    ///         identity registry. Kept for interface compatibility.
    function getIdentityRegistry() external pure returns (address) {
        return address(0);
    }

    /// @notice ERC-8004: registry version.
    function getVersion() external pure returns (string memory) {
        return "1.0.0";
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    /// @dev Linear decay weight numerator for an event: full weight at age 0,
    ///      fading to 0 at decayWindow. Divide by decayWindow for the fraction.
    function _decayNumerator(uint64 timestamp) internal view returns (uint256) {
        uint256 age = block.timestamp - timestamp; // timestamp <= block.timestamp always
        if (age >= decayWindow) return 0;
        return decayWindow - age;
    }

    function _reliability(uint256 agentId) internal view returns (uint256) {
        CommerceEvent[] storage evts = events[agentId];
        uint256 goodVal;
        uint256 totalVal;
        uint256 n = evts.length;
        for (uint256 i; i < n; i++) {
            if (!_eventCounted[agentId][i]) continue; // F1: over-cap completions don't score
            CommerceEvent storage e = evts[i];
            uint256 w = _decayNumerator(e.timestamp);
            if (w == 0) continue;
            EventType t = e.eventType;
            if (t == EventType.InvoicePaidOnTime) {
                goodVal += (e.value * w * onTimeWeightBps) / (decayWindow * 10_000);
                totalVal += (e.value * w) / decayWindow;
            } else if (t == EventType.InvoicePaidLate) {
                goodVal += (e.value * w * lateWeightBps) / (decayWindow * 10_000);
                totalVal += (e.value * w) / decayWindow;
            } else if (t == EventType.InvoiceUnpaid) {
                totalVal += (e.value * w) / decayWindow;
            } else if (t == EventType.WorkerGhosted) {
                // A no-show dings reliability with zero credit: the owner-set
                // USDC penalty lands in the denominator only. The escrow
                // records ghosts with value = 0 (the amount is irrelevant —
                // the penalty is the accountability unit), so e.value is
                // deliberately ignored here.
                totalVal += (ghostPenaltyUsdc * w) / decayWindow;
            }
        }
        if (totalVal == 0) return 0;
        return (100 * goodVal) / totalVal;
    }

    function _disputeRate(uint256 agentId) internal view returns (uint256) {
        CommerceEvent[] storage evts = events[agentId];
        uint256 disputeW;
        uint256 completedW;
        uint256 n = evts.length;
        for (uint256 i; i < n; i++) {
            if (!_eventCounted[agentId][i]) continue; // F1: over-cap completions don't score
            CommerceEvent storage e = evts[i];
            uint256 w = _decayNumerator(e.timestamp);
            if (w == 0) continue;
            EventType t = e.eventType;
            if (t == EventType.DisputeOpened) {
                // A withdrawn OR resolved dispute (same refId) is no longer
                // an active signal: withdrawals cancel the claim, resolutions
                // end it (the outcome lives in arbitrationRecord).
                if (!_disputeWithdrawn[agentId][e.refId] && !_disputeResolved[agentId][e.refId]) {
                    disputeW += w;
                }
            } else if (t == EventType.WorkerGhosted) {
                // A ghost IS a dispute signal: it counts in the numerator
                // like DisputeOpened. Unlike DisputeOpened it is NEVER
                // canceled by DisputeWithdrawn — a no-show is terminal
                // (the bounty refunded), there is nothing to withdraw.
                disputeW += w;
            } else if (
                t == EventType.EscrowCompleted || t == EventType.InvoicePaidOnTime
                    || t == EventType.InvoicePaidLate
            ) {
                completedW += w;
            }
        }
        if (completedW == 0) return disputeW > 0 ? 10_000 : 0;
        return (10_000 * disputeW) / completedW;
    }

    function _arbitrationRecord(uint256 agentId) internal view returns (uint256 wins, uint256 losses) {
        CommerceEvent[] storage evts = events[agentId];
        uint256 n = evts.length;
        for (uint256 i; i < n; i++) {
            EventType t = evts[i].eventType;
            if (t == EventType.ArbitrationWon) wins++;
            else if (t == EventType.ArbitrationLost) losses++;
        }
    }

    /// @dev Canonical tag1 name for an event type (used by 8004 tag filters).
    function _eventTypeName(EventType t) internal pure returns (string memory) {
        if (t == EventType.InvoicePaidOnTime) return "invoice_paid_on_time";
        if (t == EventType.InvoicePaidLate) return "invoice_paid_late";
        if (t == EventType.InvoiceUnpaid) return "invoice_unpaid";
        if (t == EventType.EscrowCompleted) return "escrow_completed";
        if (t == EventType.DisputeOpened) return "dispute_opened";
        if (t == EventType.DisputeWithdrawn) return "dispute_withdrawn";
        if (t == EventType.DisputeResolved) return "dispute_resolved";
        if (t == EventType.ArbitrationWon) return "arbitration_won";
        if (t == EventType.ArbitrationLost) return "arbitration_lost";
        return "worker_ghosted";
    }

    /// @dev Whether an event matches the 8004 tag filters (empty = no filter).
    function _tagMatch(CommerceEvent storage e, TagHashes memory h) internal view returns (bool) {
        if (h.empty != h.tag1 && h.tag1 != keccak256(bytes(_eventTypeName(e.eventType)))) return false;
        if (h.empty != h.tag2 && h.tag2 != keccak256(bytes("402:commerce"))) return false;
        return true;
    }

    /// @dev Hash the 8004 tag filters once per query.
    function _tagHashes(string calldata tag1, string calldata tag2)
        internal
        pure
        returns (TagHashes memory h)
    {
        h = TagHashes({
            tag1: keccak256(bytes(tag1)),
            tag2: keccak256(bytes(tag2)),
            empty: keccak256(bytes(""))
        });
    }

    /// @dev Resolve the writer list: explicit filter, else all writers.
    function _clientList(uint256 agentId, address[] calldata clientAddresses)
        internal
        view
        returns (address[] memory clientList)
    {
        if (clientAddresses.length > 0) {
            clientList = clientAddresses;
        } else {
            clientList = _writersOf[agentId];
        }
    }

    /// @dev (count, value-sum) across writers for getSummary.
    function _summaryAll(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) internal view returns (uint256 total, uint256 sum) {
        TagHashes memory h = _tagHashes(tag1, tag2);
        for (uint256 c; c < clientAddresses.length; c++) {
            (uint256 cnt, uint256 s) = _summaryForClient(agentId, clientAddresses[c], h);
            total += cnt;
            sum += s;
        }
    }

    /// @dev (count, value-sum) of one writer's tag-matching events for getSummary.
    function _summaryForClient(uint256 agentId, address clientAddress, TagHashes memory h)
        internal
        view
        returns (uint256 count, uint256 sum)
    {
        uint256[] storage idx = _writerEventIdx[agentId][clientAddress];
        uint256 n = idx.length;
        for (uint256 j; j < n; j++) {
            CommerceEvent storage e = events[agentId][idx[j]];
            if (!_tagMatch(e, h)) continue;
            sum += e.value;
            count++;
        }
    }

    /// @dev Two-pass collector backing readAllFeedback.
    function _collectFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) internal view returns (FeedbackArrays memory out) {
        address[] memory clientList = _clientList(agentId, clientAddresses);
        TagHashes memory h = _tagHashes(tag1, tag2);

        uint256 total = _countMatching(agentId, clientList, h);
        out.clients = new address[](total);
        out.feedbackIndexes = new uint64[](total);
        out.values = new int128[](total);
        out.valueDecimals = new uint8[](total);
        out.tag1s = new string[](total);
        out.tag2s = new string[](total);
        out.revokedStatuses = new bool[](total);

        _fillMatching(agentId, clientList, h, out);
    }

    function _countMatching(uint256 agentId, address[] memory clientList, TagHashes memory h)
        internal
        view
        returns (uint256 total)
    {
        for (uint256 c; c < clientList.length; c++) {
            uint256[] storage idx = _writerEventIdx[agentId][clientList[c]];
            for (uint256 j; j < idx.length; j++) {
                if (_tagMatch(events[agentId][idx[j]], h)) total++;
            }
        }
    }

    function _fillMatching(
        uint256 agentId,
        address[] memory clientList,
        TagHashes memory h,
        FeedbackArrays memory out
    ) internal view {
        uint256 k;
        for (uint256 c; c < clientList.length; c++) {
            uint256[] storage idx = _writerEventIdx[agentId][clientList[c]];
            for (uint256 j; j < idx.length; j++) {
                CommerceEvent storage e = events[agentId][idx[j]];
                if (!_tagMatch(e, h)) continue;
                if (e.value > uint256(int256(type(int128).max))) revert ValueTooLarge();
                out.clients[k] = clientList[c];
                out.feedbackIndexes[k] = uint64(j + 1);
                out.values[k] = int128(int256(e.value));
                out.valueDecimals[k] = 6;
                out.tag1s[k] = _eventTypeName(e.eventType);
                out.tag2s[k] = "402:commerce";
                // revokedStatuses[k] stays false: nothing is ever revoked.
                k++;
            }
        }
    }
}
