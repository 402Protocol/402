// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal view of BountyEscrow needed by the validation registry.
/// @dev getJob returns the full Job struct; the tuple order must match
///      BountyEscrow's struct exactly:
///      (payer, provider, agentId, amount, deadline, termsHash, state,
///       disputedAt, disputeRaiser, preDisputeState). Enums ABI-encode as uint8.
///      NOTE: BountyEscrow exposes ONLY getJob — the `jobs` mapping is private.
///      Calling a non-existent `jobs(uint256)` selector reverts unconditionally.
interface IBountyEscrow {
    function getJob(uint256 jobId)
        external
        view
        returns (
            address payer,
            address provider,
            uint256 agentId,
            uint256 amount,
            uint64 deadline,
            bytes32 termsHash,
            uint8 state,
            uint64 disputedAt,
            address disputeRaiser,
            uint8 preDisputeState
        );

    function resolveDispute(uint256 jobId, uint256 providerShareBps) external;

    function arbiter() external view returns (address);
}

/// @notice Minimal ERC-8004 identity check: the agent must exist and be owned by the staker.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @title Four02ValidationRegistry
/// @notice Staked validation for the 8004 agent economy on Ink.
///
/// Anyone can request validation of any agent's work (`requestValidation`), and the
/// 402 marketplace routes disputed bounties here (`openDisputeCase`). Validators are
/// agents: staking requires owning an ERC-8004 agentId. They score work 0-100 through
/// commit-reveal; the median score is the Schelling outcome.
///
/// Honest validators (within HONEST_BAND of the median) split the request fee plus the
/// slashed stakes of dishonest ones pro-rata by commit-time stake, via pull-payments.
/// Dishonest validators lose SLASH_BPS of their stake.
///
/// For dispute cases, the registry is designed to BE the BountyEscrow arbiter (appointed
/// via the escrow's timelocked rotation — no escrow changes needed). Until that rotation
/// happens, dispute resolutions finalize as advisory records and the human arbiter acts
/// on them off-registry. `resolveAsHuman` is the quorum-failure backstop: it can never
/// override a successful validator vote.
///
/// Design notes:
/// - No owner, no upgrades, no parameter changes: every economic parameter is an
///   immutable set at deploy. A parameter change means a new deployment.
/// - Rewards are split PRO-RATA by commit-time stake snapshot (not equal, not live
///   stake): snapshotting at commit means topping up after committing cannot farm
///   a larger share, while larger stakes still earn proportionally more — which
///   prices bribery by slash exposure instead of converging all stakes to minimum.
/// - Each commit locks a VOTE_BOND (refunded on reveal). Committers who never reveal
///   forfeit the bond into the reward pool on resolution — this kills the
///   selective-reveal free option (commit, watch reveals, reveal only when safe).
///   Bonds are refunded in full when a request Fails or is Voided.
/// - Integer-division dust from reward splits stays locked in the contract. It is
///   sub-cent per request by construction; documented as accepted, not sweepable
///   (no privileged role exists to sweep it).
/// - `resolveRequest` is permissionless, so a validator can always finalize a stuck
///   request themselves instead of being unable to unstake.
contract Four02ValidationRegistry is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------

    /// @notice BountyEscrow JobState.Disputed (enum order: None=0, Open=1, Funded=2,
    ///         Delivered=3, Released=4, Disputed=5, ...).
    uint8 public constant ESCROW_DISPUTED = 5;

    /// @notice Maximum score; scores are 0-100 inclusive.
    uint8 public constant SCORE_MAX = 100;

    /// @notice Basis points denominator for SLASH_BPS.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------------------
    // Immutables (economic parameters + external references)
    // ------------------------------------------------------------------------

    IERC20 public immutable token;
    IBountyEscrow public immutable escrow;
    IIdentityRegistry public immutable identityRegistry;

    /// @notice Quorum-failure backstop. May resolve a dispute only when no validator
    ///         vote is live; can never override a successful vote.
    address public immutable humanFallback;

    /// @notice Minimum USDC stake (base units) to become a validator.
    uint256 public immutable MIN_STAKE;
    /// @notice Delay between requesting and completing an unstake.
    uint64 public immutable UNSTAKE_DELAY;
    /// @notice Commit phase length per request.
    uint64 public immutable COMMIT_WINDOW;
    /// @notice Reveal phase length per request (starts when commit closes).
    uint64 public immutable REVEAL_WINDOW;
    /// @notice Minimum reveals for a request to resolve (else Failed).
    uint256 public immutable QUORUM;
    /// @notice |score - median| <= HONEST_BAND counts as honest.
    uint8 public immutable HONEST_BAND;
    /// @notice Basis points of stake slashed for a dishonest reveal.
    uint256 public immutable SLASH_BPS;
    /// @notice USDC fee (base units) paid by the requester per validation request.
    uint256 public immutable CASE_FEE;
    /// @notice USDC bond (base units) locked per commit, refunded on reveal.
    ///         Forfeited to the reward pool by committers who never reveal.
    ///         0 = disabled.
    uint256 public immutable VOTE_BOND;

    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------

    enum RequestKind {
        General,
        Dispute
    }

    enum RequestStatus {
        None,
        Open,
        Resolved,
        Failed,
        Voided
    }

    struct Validator {
        uint256 stake;
        uint256 agentId;
        uint64 unstakeRequestedAt; // 0 = not unstaking
        uint256 activeCommitments; // open requests this validator committed to
    }

    struct Request {
        RequestKind kind;
        RequestStatus status;
        uint256 subjectAgentId; // general: validated agent; dispute: worker agentId
        uint256 jobId; // dispute only
        address jobPayer; // dispute only (self-validation check)
        address jobProvider; // dispute only (self-validation check)
        string evidenceURI; // general only
        address requester;
        uint64 commitEnd;
        uint64 revealEnd;
        uint8 median; // set at resolution
        uint256 revealCount;
    }

    struct Vote {
        bytes32 commitment;
        bool revealed;
        uint8 score;
        uint256 stakeSnapshot; // validator stake at commit time (pro-rata rewards)
    }

    // ------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------

    mapping(address => Validator) public validators;
    mapping(address => uint256) public pendingRewards;

    mapping(uint256 => Request) public requests; // requestId => Request
    mapping(uint256 => mapping(address => Vote)) public votes; // requestId => voter => Vote
    mapping(uint256 => address[]) private requestVoters; // requestId => committers
    mapping(uint256 => uint8[]) private revealedScores; // requestId => scores

    /// @notice Latest validation request per escrow job (0 = none).
    mapping(uint256 => uint256) public disputeRequestByJob;

    uint256 public nextRequestId = 1;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event ValidatorStaked(address indexed validator, uint256 agentId, uint256 amount, uint256 totalStake);
    event UnstakeRequested(address indexed validator, uint64 availableAt);
    event UnstakeCancelled(address indexed validator);
    event ValidatorUnstaked(address indexed validator, uint256 amount);
    event ValidatorSlashed(address indexed validator, uint256 indexed requestId, uint256 amount);

    event ValidationRequested(uint256 indexed requestId, uint256 indexed agentId, address indexed requester);
    event DisputeCaseOpened(uint256 indexed requestId, uint256 indexed jobId, address indexed requester);
    event VoteCommitted(uint256 indexed requestId, address indexed validator);
    event VoteRevealed(uint256 indexed requestId, address indexed validator, uint8 score);
    event RequestResolved(
        uint256 indexed requestId, uint8 median, uint256 honestCount, uint256 slashedCount, bool escrowCalled
    );
    event RequestFailed(uint256 indexed requestId);
    event RequestVoided(uint256 indexed requestId);
    event HumanResolved(uint256 indexed jobId, uint256 providerShareBps);
    event RewardsClaimed(address indexed validator, uint256 amount);

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error ZeroAddress();
    error BelowMinStake();
    error NotValidator();
    error AlreadyUnstaking();
    error NotUnstaking();
    error UnstakeTooEarly();
    error HasActiveCommitments();
    error AgentNotFound();
    error NotAgentOwner();
    error UnknownRequest();
    error RequestNotOpen();
    error CommitClosed();
    error RevealClosed();
    error RevealNotOpen();
    error AlreadyCommitted();
    error BadCommitment();
    error ScoreTooHigh();
    error AlreadyRevealed();
    error ResolveTooEarly();
    error SelfValidation();
    error JobNotDisputed();
    error CaseAlreadyOpen();
    error VotingActive();
    error NotHumanFallback();
    error NothingToClaim();
    error SlashTooHigh();
    error BadQuorum();
    error BadHonestBand();

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    constructor(
        address token_,
        address escrow_,
        address identityRegistry_,
        address humanFallback_,
        uint256 minStake_,
        uint64 unstakeDelay_,
        uint64 commitWindow_,
        uint64 revealWindow_,
        uint256 quorum_,
        uint8 honestBand_,
        uint256 slashBps_,
        uint256 caseFee_,
        uint256 voteBond_
    ) {
        if (
            token_ == address(0) || escrow_ == address(0) || identityRegistry_ == address(0)
                || humanFallback_ == address(0)
        ) revert ZeroAddress();
        if (minStake_ == 0 || unstakeDelay_ == 0 || commitWindow_ == 0 || revealWindow_ == 0) revert ZeroAddress();
        if (quorum_ < 3) revert BadQuorum(); // 1-2 validators is not a Schelling game
        if (honestBand_ > SCORE_MAX) revert BadHonestBand(); // band > 100 makes slashing dead code
        if (slashBps_ > BPS_DENOMINATOR) revert SlashTooHigh();
        // Refuse codeless addresses: a misconfigured registry must fail at deploy,
        // not silently at first use.
        if (token_.code.length == 0 || escrow_.code.length == 0 || identityRegistry_.code.length == 0) {
            revert ZeroAddress();
        }

        token = IERC20(token_);
        escrow = IBountyEscrow(escrow_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        humanFallback = humanFallback_;
        MIN_STAKE = minStake_;
        UNSTAKE_DELAY = unstakeDelay_;
        COMMIT_WINDOW = commitWindow_;
        REVEAL_WINDOW = revealWindow_;
        QUORUM = quorum_;
        HONEST_BAND = honestBand_;
        SLASH_BPS = slashBps_;
        CASE_FEE = caseFee_;
        VOTE_BOND = voteBond_;
    }

    // ------------------------------------------------------------------------
    // Validator lifecycle
    // ------------------------------------------------------------------------

    /// @notice Stake USDC to become a validator. Agents only: `agentId` must be nonzero
    ///         and owned by the caller. Staking while an unstake is pending cancels it.
    function stake(uint256 amount, uint256 agentId) external nonReentrant {
        if (amount == 0) revert BelowMinStake();
        Validator storage v = validators[msg.sender];
        if (v.stake == 0 && amount < MIN_STAKE) revert BelowMinStake();
        if (agentId == 0) revert AgentNotFound();
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (v.stake > 0 && v.agentId != agentId) revert NotAgentOwner(); // one identity per validator

        token.safeTransferFrom(msg.sender, address(this), amount);
        v.stake += amount;
        v.agentId = agentId;
        if (v.unstakeRequestedAt != 0) {
            v.unstakeRequestedAt = 0;
            emit UnstakeCancelled(msg.sender);
        }
        emit ValidatorStaked(msg.sender, agentId, amount, v.stake);
    }

    /// @notice Begin the unstake countdown. Validators with open commitments cannot
    ///         finish withdrawing until those requests resolve — but resolution is
    ///         permissionless, so they can finalize a stuck request themselves.
    function requestUnstake() external nonReentrant {
        Validator storage v = validators[msg.sender];
        if (v.stake == 0) revert NotValidator();
        if (v.unstakeRequestedAt != 0) revert AlreadyUnstaking();
        v.unstakeRequestedAt = uint64(block.timestamp);
        emit UnstakeRequested(msg.sender, uint64(block.timestamp) + UNSTAKE_DELAY);
    }

    /// @notice Complete an unstake after the delay. Pending rewards are auto-claimed.
    function withdrawUnstake() external nonReentrant {
        Validator storage v = validators[msg.sender];
        if (v.unstakeRequestedAt == 0) revert NotUnstaking();
        if (block.timestamp < v.unstakeRequestedAt + UNSTAKE_DELAY) revert UnstakeTooEarly();
        if (v.activeCommitments != 0) revert HasActiveCommitments();

        uint256 payout = v.stake + pendingRewards[msg.sender];
        delete validators[msg.sender];
        delete pendingRewards[msg.sender];
        token.safeTransfer(msg.sender, payout);
        emit ValidatorUnstaked(msg.sender, payout);
    }

    /// @notice Pull-payment for validation rewards.
    function claimRewards() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingRewards[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------------
    // Validation requests
    // ------------------------------------------------------------------------

    /// @notice Request validation of any agent's work. The agent must exist.
    ///         The $CASE_FEE pays the honest validators (refunded if no quorum).
    function requestValidation(uint256 agentId, string calldata evidenceURI)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (agentId == 0) revert AgentNotFound();
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert AgentNotFound();
        } catch {
            revert AgentNotFound();
        }
        return _openRequest(RequestKind.General, agentId, 0, address(0), address(0), evidenceURI);
    }

    /// @notice Open a validation case on a disputed escrow job. Anyone may call once
    ///         the job is Disputed. Reverts if a live case already exists for the job.
    function openDisputeCase(uint256 jobId) external nonReentrant returns (uint256 requestId) {
        (
            address payer,
            address provider,
            uint256 agentId,
            ,
            ,
            ,
            uint8 state,
            ,
            ,

        ) = escrow.getJob(jobId);
        if (state != ESCROW_DISPUTED) revert JobNotDisputed();

        // Block only a LIVE case. A Resolved advisory record must not block a fresh
        // case if the job is disputed again (in binding mode the escrow job is
        // terminally Resolved, so JobNotDisputed above already reverts).
        uint256 existing = disputeRequestByJob[jobId];
        if (existing != 0 && requests[existing].status == RequestStatus.Open) revert CaseAlreadyOpen();

        requestId = _openRequest(RequestKind.Dispute, agentId, jobId, payer, provider, "");
        disputeRequestByJob[jobId] = requestId;
        emit DisputeCaseOpened(requestId, jobId, msg.sender);
    }

    function _openRequest(
        RequestKind kind,
        uint256 subjectAgentId,
        uint256 jobId,
        address jobPayer,
        address jobProvider,
        string memory evidenceURI
    ) internal returns (uint256 requestId) {
        if (CASE_FEE > 0) {
            token.safeTransferFrom(msg.sender, address(this), CASE_FEE);
        }
        requestId = nextRequestId++;
        Request storage r = requests[requestId];
        r.kind = kind;
        r.status = RequestStatus.Open;
        r.subjectAgentId = subjectAgentId;
        r.jobId = jobId;
        r.jobPayer = jobPayer;
        r.jobProvider = jobProvider;
        r.evidenceURI = evidenceURI;
        r.requester = msg.sender;
        r.commitEnd = uint64(block.timestamp) + COMMIT_WINDOW;
        r.revealEnd = uint64(block.timestamp) + COMMIT_WINDOW + REVEAL_WINDOW;
        emit ValidationRequested(requestId, subjectAgentId, msg.sender);
    }

    /// @notice Commit a hidden score: keccak256(abi.encodePacked(score, salt)), score 0-100.
    ///         Locks VOTE_BOND (refunded on reveal) and snapshots stake for pro-rata rewards.
    function commitVote(uint256 requestId, bytes32 commitment) external nonReentrant {
        Validator storage v = validators[msg.sender];
        if (v.stake < MIN_STAKE) revert NotValidator(); // slashed-below-min must top up first
        if (v.unstakeRequestedAt != 0) revert AlreadyUnstaking();
        if (commitment == bytes32(0)) revert BadCommitment(); // zero can never be revealed
        Request storage r = _getOpenRequest(requestId);
        if (block.timestamp > r.commitEnd) revert CommitClosed();
        if (votes[requestId][msg.sender].commitment != bytes32(0)) revert AlreadyCommitted();
        if (r.kind == RequestKind.Dispute) {
            if (msg.sender == r.jobPayer || msg.sender == r.jobProvider) revert SelfValidation();
        } else if (v.agentId == r.subjectAgentId) {
            revert SelfValidation(); // no manufacturing your own 100/100 record
        }

        if (VOTE_BOND > 0) {
            token.safeTransferFrom(msg.sender, address(this), VOTE_BOND);
        }
        Vote storage vt = votes[requestId][msg.sender];
        vt.commitment = commitment;
        vt.stakeSnapshot = v.stake;
        requestVoters[requestId].push(msg.sender);
        v.activeCommitments += 1;
        emit VoteCommitted(requestId, msg.sender);
    }

    /// @notice Reveal a committed score.
    function revealVote(uint256 requestId, uint8 score, bytes32 salt) external nonReentrant {
        Request storage r = _getOpenRequest(requestId);
        if (block.timestamp <= r.commitEnd) revert RevealNotOpen();
        if (block.timestamp > r.revealEnd) revert RevealClosed();
        if (score > SCORE_MAX) revert ScoreTooHigh();
        Vote storage vt = votes[requestId][msg.sender];
        if (vt.commitment == bytes32(0)) revert BadCommitment();
        if (vt.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(score, salt)) != vt.commitment) revert BadCommitment();

        vt.revealed = true;
        vt.score = score;
        revealedScores[requestId].push(score);
        r.revealCount += 1;
        if (VOTE_BOND > 0) {
            token.safeTransfer(msg.sender, VOTE_BOND); // bond back: you showed up
        }
        emit VoteRevealed(requestId, msg.sender, score);
    }

    /// @notice Resolve a request after the reveal window. Anyone may call.
    ///         - Quorum reached: median settles; honest split fee + slash; dispute cases
    ///           call escrow.resolveDispute if this registry is the arbiter (advisory
    ///           record otherwise).
    ///         - No quorum: Failed; the request fee is refunded.
    ///         - Dispute job left Disputed (withdrawn / resolved elsewhere): Voided.
    function resolveRequest(uint256 requestId) external nonReentrant {
        Request storage r = _getOpenRequest(requestId);
        if (block.timestamp <= r.revealEnd) revert ResolveTooEarly();

        if (r.kind == RequestKind.Dispute) {
            (, , , , , , uint8 state, , , ) = escrow.getJob(r.jobId);
            if (state != ESCROW_DISPUTED) {
                _voidRequest(requestId);
                return;
            }
        }

        if (r.revealCount < QUORUM) {
            r.status = RequestStatus.Failed;
            _releaseVoters(requestId);
            _refundBonds(requestId);
            if (CASE_FEE > 0) {
                token.safeTransfer(r.requester, CASE_FEE);
            }
            emit RequestFailed(requestId);
            return;
        }

        uint8 median = _median(revealedScores[requestId]);
        r.median = median;
        r.status = RequestStatus.Resolved;

        address[] storage voters = requestVoters[requestId];
        uint256 honestCount = 0;
        uint256 slashPool = 0;
        uint256 snapshotTotal = 0;

        // Classify first (median is fixed), then slash dishonest.
        for (uint256 i = 0; i < voters.length; i++) {
            address voter = voters[i];
            Vote storage vt = votes[requestId][voter];
            if (!vt.revealed) continue;
            uint256 distance = vt.score > median ? vt.score - median : median - vt.score;
            if (distance > HONEST_BAND) {
                uint256 slash = (validators[voter].stake * SLASH_BPS) / BPS_DENOMINATOR;
                validators[voter].stake -= slash;
                slashPool += slash;
                emit ValidatorSlashed(voter, requestId, slash);
            } else {
                honestCount += 1;
                snapshotTotal += vt.stakeSnapshot;
            }
        }

        // Committers who never revealed forfeit their bond into the reward pool.
        // (Selective-reveal defense: watching reveals and staying silent is no
        // longer a free option.)
        uint256 rewardPool = slashPool + CASE_FEE;
        if (VOTE_BOND > 0) {
            for (uint256 i = 0; i < voters.length; i++) {
                if (!votes[requestId][voters[i]].revealed) {
                    rewardPool += VOTE_BOND;
                }
            }
        }

        // median voter is always within its own band, so honestCount >= 1, and every
        // honest snapshot is >= MIN_STAKE > 0, so snapshotTotal > 0 here.
        // Pro-rata by commit-time snapshot: topping up after commit cannot farm rewards.
        if (rewardPool > 0 && honestCount > 0) {
            for (uint256 i = 0; i < voters.length; i++) {
                address voter = voters[i];
                Vote storage vt = votes[requestId][voter];
                if (!vt.revealed) continue;
                uint256 distance = vt.score > median ? vt.score - median : median - vt.score;
                if (distance <= HONEST_BAND) {
                    pendingRewards[voter] += (rewardPool * vt.stakeSnapshot) / snapshotTotal;
                }
            }
        }

        _releaseVoters(requestId);

        bool escrowCalled = false;
        if (r.kind == RequestKind.Dispute && escrow.arbiter() == address(this)) {
            escrow.resolveDispute(r.jobId, uint256(median) * 100);
            escrowCalled = true;
        }
        uint256 slashedCount = r.revealCount - honestCount;
        emit RequestResolved(requestId, median, honestCount, slashedCount, escrowCalled);
    }

    /// @notice Void a request whose dispute job left Disputed without registry resolution.
    ///         Anyone may call. Committed stakes unlock; the fee is refunded.
    function voidRequest(uint256 requestId) external nonReentrant {
        Request storage r = _getOpenRequest(requestId);
        if (r.kind != RequestKind.Dispute) revert JobNotDisputed();
        (, , , , , , uint8 state, , , ) = escrow.getJob(r.jobId);
        if (state == ESCROW_DISPUTED) revert VotingActive();
        _voidRequest(requestId);
    }

    function _voidRequest(uint256 requestId) internal {
        Request storage r = requests[requestId];
        r.status = RequestStatus.Voided;
        _releaseVoters(requestId);
        _refundBonds(requestId);
        if (disputeRequestByJob[r.jobId] == requestId) {
            delete disputeRequestByJob[r.jobId];
        }
        if (CASE_FEE > 0) {
            token.safeTransfer(r.requester, CASE_FEE);
        }
        emit RequestVoided(requestId);
    }

    /// @notice Return vote bonds to committers who never revealed. Used on the
    ///         Failed and Voided paths. On the Resolved path non-revealers forfeit
    ///         their bond into the reward pool instead (see resolveRequest).
    function _refundBonds(uint256 requestId) internal {
        if (VOTE_BOND == 0) return;
        address[] storage voters = requestVoters[requestId];
        for (uint256 i = 0; i < voters.length; i++) {
            address voter = voters[i];
            if (!votes[requestId][voter].revealed) {
                token.safeTransfer(voter, VOTE_BOND);
            }
        }
    }

    function _releaseVoters(uint256 requestId) internal {
        address[] storage voters = requestVoters[requestId];
        for (uint256 i = 0; i < voters.length; i++) {
            Validator storage v = validators[voters[i]];
            if (v.activeCommitments > 0) v.activeCommitments -= 1;
        }
    }

    /// @notice Human backstop: resolves a disputed job when validators produced no live
    ///         vote. Only `humanFallback`; reverts while a vote is live, so consensus
    ///         can never be overridden. Forwards to the escrow, which enforces that this
    ///         registry is the arbiter.
    function resolveAsHuman(uint256 jobId, uint256 providerShareBps) external nonReentrant {
        if (msg.sender != humanFallback) revert NotHumanFallback();
        uint256 requestId = disputeRequestByJob[jobId];
        if (requestId != 0 && requests[requestId].status == RequestStatus.Open) revert VotingActive();
        escrow.resolveDispute(jobId, providerShareBps);
        emit HumanResolved(jobId, providerShareBps);
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------

    /// @notice Median of revealed scores (even count: mean of two middles, rounded down).
    /// @dev Counting sort over the bounded score range (0-100): O(n) with reads only,
    ///      no storage writes. The old in-place insertion sort was O(n^2) SSTOREs and
    ///      bricked resolution past ~100-200 voters, permanently locking stakes.
    function _median(uint8[] storage scores) internal view returns (uint8 median) {
        uint256 n = scores.length;
        uint256[101] memory buckets;
        for (uint256 i = 0; i < n; i++) {
            buckets[scores[i]] += 1;
        }
        if (n % 2 == 1) {
            median = _kth(buckets, n / 2);
        } else {
            uint8 lo = _kth(buckets, n / 2 - 1);
            uint8 hi = _kth(buckets, n / 2);
            median = uint8((uint16(lo) + uint16(hi)) / 2);
        }
    }

    /// @notice k-th smallest score (0-indexed) from a counting-sort bucket array.
    function _kth(uint256[101] memory buckets, uint256 k) internal pure returns (uint8) {
        uint256 count = 0;
        for (uint256 s = 0; s <= SCORE_MAX; s++) {
            count += buckets[s];
            if (count > k) return uint8(s);
        }
        revert(); // unreachable: k < n <= total count at all call sites
    }

    function _getOpenRequest(uint256 requestId) internal view returns (Request storage r) {
        r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        if (r.status != RequestStatus.Open) revert RequestNotOpen();
    }

    /// @notice Read a single validation record (8004-draft-shaped).
    function getValidation(uint256 requestId, address validator)
        external
        view
        returns (uint256 subjectAgentId, uint8 score, string memory responseURI, uint64 validatedAt)
    {
        Request storage r = requests[requestId];
        if (r.status != RequestStatus.Resolved) revert RequestNotOpen();
        Vote storage vt = votes[requestId][validator];
        if (!vt.revealed) revert BadCommitment();
        return (r.subjectAgentId, vt.score, r.evidenceURI, r.revealEnd);
    }

    /// @notice Summary of a resolved request.
    function getRequestResult(uint256 requestId)
        external
        view
        returns (uint8 median, uint256 revealCount, RequestStatus status)
    {
        Request storage r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        return (r.median, r.revealCount, r.status);
    }
}
