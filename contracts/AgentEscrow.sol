// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Reputation} from "./Reputation.sol";

/// @title AgentEscrow
/// @notice USDC escrow for agent-to-agent jobs. A payer (client) funds a job,
/// a provider (worker agent) delivers, and funds release on the payer's
/// approval. If the parties disagree, a trusted arbiter resolves the dispute.
/// @dev MVP deliberately has NO upgrade mechanism (see README "v0 limitations").
///      Settlement token is a constructor param — no chain-specific code;
///      deploy on Ink, Robinhood Chain, or any EVM chain by passing that
///      chain's USDC address.
///
///      PULL PAYMENTS (H3): terminal transitions (release / resolveDispute /
///      refund) never push tokens — they RECORD claims, and each payee
///      withdraws via claim(). A blocklisted payee's revert touches only
///      their own claim transaction; nobody else's payout can brick.
contract AgentEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard cap on the protocol fee. The 75 bps default is the
    /// founder's PROPOSAL — it is a constructor param, not a final decision.
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%

    /// @notice H4: timelock before a proposed arbiter rotation can be
    /// confirmed. Public delay: everyone sees a rotation coming and can stop
    /// using the escrow if it looks malicious.
    uint256 public constant ROTATION_DELAY = 14 days;

    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------

    enum JobState {
        None, // jobId never created
        Funded, // payer locked funds; awaiting delivery
        Delivered, // provider signalled completion; awaiting payer release
        Released, // payer released; claims recorded (provider + fee)
        Disputed, // payer or provider raised a dispute; awaiting arbiter
        Resolved, // arbiter recorded the split; claims recorded
        Refunded // deadline + grace passed with no delivery; payer claim recorded
    }

    struct Job {
        address payer;
        address provider;
        uint256 amount;
        uint64 deadline;
        bytes32 termsHash; // keccak256 of the off-chain terms (invoice digest, spec, etc.)
        JobState state;
    }

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error BadDeadline();
    error FeeTooHigh();
    error NotContract(); // H5: token_ must be a deployed contract
    error UnknownJob();
    error BadState();
    error NotPayer();
    error NotProvider();
    error NotParty();
    error NotArbiter();
    error ShareTooHigh();
    error TooEarly();
    error SelfDealing(); // M2: payer cannot be their own provider
    error NothingToClaim(); // H3: claim() with no recorded claim
    error NotProposer(); // H4: rotation proposer is neither arbiter nor guardian
    error NoRotationPending(); // H4: confirm/cancel with nothing proposed
    error RotationTooEarly(); // H4: confirm before ROTATION_DELAY elapsed

    // ------------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------------

    /// @notice The settlement token (native USDC on the deploy chain).
    IERC20 public immutable token;

    /// @notice Where protocol fees are sent.
    address public immutable feeRecipient;

    /// @notice Protocol fee in basis points, snapshot at construction.
    /// 75 = 0.75%. PROPOSED economics — founder approval required before mainnet.
    uint256 public immutable feeBps;

    /// @notice M3: grace window after the deadline before refund() opens.
    /// A provider's confirmDelivery can't lose a mempool race to a refund in
    /// the block the deadline passes; during the window only confirmDelivery
    /// (provider) and raiseDispute (either party) can move the job.
    uint64 public immutable refundDelay;

    /// @notice H4: rotation guardian — a founder-controlled EOA that may
    /// PROPOSE an arbiter rotation (the arbiter may too). Cannot touch funds;
    /// a proposal only takes effect after ROTATION_DELAY via confirmRotation().
    /// This is the recovery path if the arbiter key is lost.
    address public immutable guardian;

    /// @notice Reputation ledger, deployed by this escrow; only it can record.
    Reputation public immutable reputation;

    // ------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------

    /// @notice Trusted arbiter. Mutable ONLY via the timelocked rotation
    /// (proposeRotation / confirmRotation). Deploy as the founder's multisig
    /// regardless — rotation is the fallback, not the plan.
    address public arbiter;

    /// @notice H4: pending rotation target; address(0) = none proposed.
    address public pendingArbiter;

    /// @notice H4: earliest timestamp at which confirmRotation() may run.
    uint64 public rotationReadyAt;

    uint256 public jobCounter;
    mapping(uint256 => Job) private jobs;

    /// @notice H3: pull-payment ledger. claims[jobId][account] = wei the
    /// account may withdraw via claim(). Recorded exactly once, at the
    /// terminal transition (release / resolveDispute / refund); zeroed
    /// before the transfer in claim().
    mapping(uint256 => mapping(address => uint256)) private claims;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event JobCreated(
        uint256 indexed jobId,
        address indexed payer,
        address indexed provider,
        uint256 amount,
        uint64 deadline,
        bytes32 termsHash
    );
    event DeliveryConfirmed(uint256 indexed jobId);
    event JobReleased(uint256 indexed jobId, uint256 providerAmount, uint256 feeAmount);
    event DisputeRaised(uint256 indexed jobId, address indexed raiser);
    event DisputeResolved(uint256 indexed jobId, uint256 providerAmount, uint256 payerAmount);
    event JobRefunded(uint256 indexed jobId);
    event Claimed(uint256 indexed jobId, address indexed claimant, uint256 amount);
    event RotationProposed(
        address indexed proposer, address indexed currentArbiter, address indexed newArbiter, uint64 readyAt
    );
    event RotationConfirmed(address indexed oldArbiter, address indexed newArbiter);
    event RotationCancelled(address indexed canceller, address indexed newArbiter);

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    constructor(
        address token_,
        address arbiter_,
        address feeRecipient_,
        uint256 feeBps_,
        uint64 refundDelay_,
        address guardian_
    ) {
        if (token_ == address(0) || arbiter_ == address(0) || feeRecipient_ == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        // H5: refuse to deploy against an address with no code. Without this,
        // deploying to a new chain (e.g. Robinhood Chain) without updating the
        // token address would "succeed" while moving zero tokens — SafeERC20
        // treats empty returndata as success, so every job would be accounting
        // fiction backed by nothing.
        if (token_.code.length == 0) revert NotContract();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        token = IERC20(token_);
        arbiter = arbiter_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        refundDelay = refundDelay_;
        guardian = guardian_;
        reputation = new Reputation(address(this));
    }

    // ------------------------------------------------------------------------
    // Job lifecycle
    // ------------------------------------------------------------------------

    /// @notice Fund a new job. Caller becomes the payer. Pulls `amount` of the
    /// settlement token via `transferFrom` — the payer must `approve` first.
    /// @dev M2: reverts on self-dealing (provider == payer). One self-job
    /// used to mint a perfect reputation score at dust cost (fee rounds to
    /// zero on tiny amounts). Deliberately NO minimum job amount: legit
    /// micro-jobs are the product, and the revert kills the farming vector
    /// (farming now needs a second colluding party, which is the documented
    /// sybil caveat, not a free mint).
    function createJob(address provider, uint256 amount, uint64 deadline, bytes32 termsHash)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (provider == address(0)) revert ZeroAddress();
        if (provider == msg.sender) revert SelfDealing();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert BadDeadline();

        jobId = ++jobCounter;
        jobs[jobId] = Job({
            payer: msg.sender,
            provider: provider,
            amount: amount,
            deadline: deadline,
            termsHash: termsHash,
            state: JobState.Funded
        });

        // Effects before interactions: state is set before the token pull.
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit JobCreated(jobId, msg.sender, provider, amount, deadline, termsHash);
    }

    /// @notice Provider signals the work is done. Funded -> Delivered.
    /// @dev M3/L5: callable any time the job is Funded — including inside the
    /// refund grace window. Late delivery is specified behavior, not a quirk.
    function confirmDelivery(uint256 jobId) external {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.provider) revert NotProvider();
        if (job.state != JobState.Funded) revert BadState();
        job.state = JobState.Delivered;
        emit DeliveryConfirmed(jobId);
    }

    /// @notice Payer approves the delivery. Delivered -> Released.
    /// RECORDS claims instead of paying out (H3 pull payments): the provider
    /// withdraws `amount - fee` and the fee recipient withdraws the fee via
    /// claim(). Records a completed job for the provider.
    function release(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.payer) revert NotPayer();
        if (job.state != JobState.Delivered) revert BadState();

        job.state = JobState.Released;

        uint256 fee = (job.amount * feeBps) / BPS_DENOMINATOR;
        uint256 providerAmount = job.amount - fee;

        // Accumulated (+=), not assigned: if feeRecipient == provider the two
        // payees share one slot, and assignment would overwrite the provider's
        // share. Safe because each job records claims exactly once — terminal
        // transitions are one-way, so this is the only write to these slots.
        claims[jobId][job.provider] += providerAmount;
        if (fee > 0) {
            claims[jobId][feeRecipient] += fee;
        }
        reputation.recordCompletion(job.provider);
        emit JobReleased(jobId, providerAmount, fee);
    }

    /// @notice Payer or provider escalates. Funded/Delivered -> Disputed.
    function raiseDispute(uint256 jobId) external {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.payer && msg.sender != job.provider) revert NotParty();
        if (job.state != JobState.Funded && job.state != JobState.Delivered) revert BadState();
        job.state = JobState.Disputed;
        emit DisputeRaised(jobId, msg.sender);
    }

    /// @notice Arbiter records the split. Disputed -> Resolved.
    /// @param providerShareBps basis points of `amount` going to the provider
    /// (0 = payer wins everything, 10000 = provider wins everything).
    /// @dev No protocol fee is taken on disputed resolutions (MVP choice —
    /// the protocol didn't facilitate a clean settlement). Reputation: the
    /// provider "wins" the dispute (records a completion) when they keep at
    /// least half; otherwise records a lost dispute.
    /// RECORDS claims instead of paying out (H3): each party withdraws via
    /// claim(), so a blocklisted party can't brick the other's payout.
    function resolveDispute(uint256 jobId, uint256 providerShareBps) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != arbiter) revert NotArbiter();
        if (job.state != JobState.Disputed) revert BadState();
        if (providerShareBps > BPS_DENOMINATOR) revert ShareTooHigh();

        job.state = JobState.Resolved;

        uint256 providerAmount = (job.amount * providerShareBps) / BPS_DENOMINATOR;
        uint256 payerAmount = job.amount - providerAmount;

        // += so overlapping payee slots accumulate (see release()); each job
        // records exactly once, so this is the only write to these slots.
        if (providerAmount > 0) {
            claims[jobId][job.provider] += providerAmount;
        }
        if (payerAmount > 0) {
            claims[jobId][job.payer] += payerAmount;
        }

        if (providerShareBps >= BPS_DENOMINATOR / 2) {
            reputation.recordCompletion(job.provider);
        } else {
            reputation.recordLostDispute(job.provider);
        }
        emit DisputeResolved(jobId, providerAmount, payerAmount);
    }

    /// @notice Refund the payer once the deadline PLUS the grace window passes
    /// with no delivery. Funded -> Refunded. Permissionless: anyone may
    /// trigger it; RECORDS the payer's claim (H3) instead of pushing funds.
    /// Delivered jobs can no longer be refunded — the payer must release or
    /// dispute instead.
    /// @dev M3: the grace window kills the deadline-block mempool race where
    /// a stranger's refund could front-run the provider's confirmDelivery.
    /// Residual vector (documented, not fixed): a payer who never releases
    /// and never disputes forces the provider to dispute before the deadline.
    function refund(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.state != JobState.Funded) revert BadState();
        if (block.timestamp < uint256(job.deadline) + refundDelay) revert TooEarly();

        job.state = JobState.Refunded;
        claims[jobId][job.payer] += job.amount; // += for the uniform recording rule
        emit JobRefunded(jobId);
    }

    /// @notice Withdraw a recorded claim. Permissionless to CALL, but only
    /// the recorded payee's entry moves: claims are keyed by msg.sender.
    /// The entry is zeroed BEFORE the transfer (checks-effects-interactions)
    /// plus nonReentrant: a reentrant claim — or a second claim — finds a
    /// zero balance and reverts. A blocklisted claimant's revert touches only
    /// their own transaction; every other payee's claim is independent.
    function claim(uint256 jobId) external nonReentrant {
        uint256 amount = claims[jobId][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claims[jobId][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(jobId, msg.sender, amount);
    }

    // ------------------------------------------------------------------------
    // Arbiter rotation (H4)
    // ------------------------------------------------------------------------

    /// @notice Propose a new arbiter. Callable by the current arbiter OR the
    /// guardian (founder EOA). Starts the ROTATION_DELAY timelock; anyone may
    /// then call confirmRotation() once it elapses. Proposing again
    /// overwrites the pending target and RESTARTS the clock.
    /// @dev The guardian can never touch funds — only rotate the arbiter,
    /// and only after 14 days of public visibility.
    function proposeRotation(address newArbiter) external {
        if (msg.sender != arbiter && msg.sender != guardian) revert NotProposer();
        if (newArbiter == address(0)) revert ZeroAddress();
        pendingArbiter = newArbiter;
        rotationReadyAt = uint64(block.timestamp + ROTATION_DELAY);
        emit RotationProposed(msg.sender, arbiter, newArbiter, rotationReadyAt);
    }

    /// @notice Confirm a proposed rotation after the timelock. Permissionless:
    /// anyone may finalize it once the delay has elapsed.
    function confirmRotation() external {
        address newArbiter = pendingArbiter;
        if (newArbiter == address(0)) revert NoRotationPending();
        if (block.timestamp < rotationReadyAt) revert RotationTooEarly();
        address oldArbiter = arbiter;
        arbiter = newArbiter;
        pendingArbiter = address(0);
        rotationReadyAt = 0;
        emit RotationConfirmed(oldArbiter, newArbiter);
    }

    /// @notice Cancel a pending rotation. Callable by the arbiter or guardian
    /// (e.g. a proposal made in error, or a compromised guardian's proposal).
    function cancelRotation() external {
        if (msg.sender != arbiter && msg.sender != guardian) revert NotProposer();
        address cancelled = pendingArbiter;
        if (cancelled == address(0)) revert NoRotationPending();
        pendingArbiter = address(0);
        rotationReadyAt = 0;
        emit RotationCancelled(msg.sender, cancelled);
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _getJob(jobId);
    }

    /// @notice Wei `account` may withdraw from `jobId` via claim(). Zero when
    /// nothing is recorded (job not terminal, already claimed, or never owed).
    function claimable(uint256 jobId, address account) external view returns (uint256) {
        return claims[jobId][account];
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    function _getJob(uint256 jobId) internal view returns (Job storage job) {
        job = jobs[jobId];
        if (jobId == 0 || jobId > jobCounter) revert UnknownJob();
    }
}
