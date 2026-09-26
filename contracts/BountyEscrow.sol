// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Four02ReputationRegistry} from "./Four02ReputationRegistry.sol";

/// @notice Minimal read interface of the ERC-8004 identity registry.
/// @dev The live registry (0x7274e874CA62410a93Bd8bf61c69d8045E399c02 on Ink,
/// chain id 57073) is ERC-721: ownerOf(agentId) is the trustless
/// wallet<->agentId binding this contract checks at claim time.
interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title BountyEscrow
/// @notice USDC escrow for the 402 job marketplace. A requester (payer) posts
/// a funded bounty with NO provider named; any enrolled agent claims it by
/// proving ERC-8004 identity ownership onchain, delivers, and gets paid on
/// the payer's approval. Disputes go to a trusted arbiter; ghosted bounties
/// refund to the payer after the deadline plus a grace window.
/// @dev Same audited skeleton as AgentEscrow: pull payments (H3), 14-day
/// timelocked arbiter rotation with guardian (H4), immutable fee with a
/// 1000 bps hard cap, M2 self-dealing revert, M3 refundDelay grace window.
///
///      Differences from AgentEscrow:
///      - createBounty names no provider. claimBounty binds one trustlessly:
///        the contract verifies IDENTITY_REGISTRY.ownerOf(agentId) ==
///        msg.sender onchain at claim time, callable exactly once from Open.
///      - Reputation goes to the deployed Four02ReputationRegistry — the ONLY
///        ledger for this contract (it deploys NO internal Reputation) —
///        keyed to the claimed ERC-8004 agentId. EVERY registry call is
///        wrapped in try/catch so a revert (e.g. this contract not yet
///        allowlisted as a writer) can NEVER brick a payout. Funds always
///        move; reputation is best-effort.
///
///      DEPLOY NOTE: the Four02ReputationRegistry at
///      0x33E2c56035C059553a37a3A56199B5b5b3DA3365 ships with an EMPTY writer
///      allowlist. The registry owner must call addWriter(bountyEscrow)
///      after this contract deploys, or reputation calls no-op silently via
///      the try/catch (payouts keep working; nothing is recorded).
contract BountyEscrow is ReentrancyGuard {
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
        Open, // bounty funded; no provider yet; awaiting a claim
        Funded, // claimed by a worker; awaiting delivery
        Delivered, // provider signalled completion; awaiting payer release
        Released, // payer released; claims recorded (provider + fee)
        Disputed, // payer or provider raised a dispute; awaiting arbiter
        Resolved, // arbiter recorded the split; claims recorded
        Refunded // deadline + grace passed with no delivery; payer claim recorded
    }

    struct Job {
        address payer;
        address provider; // address(0) until claimed
        uint256 agentId; // 0 until claimed — the provider's ERC-8004 identity
        uint256 amount;
        uint64 deadline;
        bytes32 termsHash; // keccak256 of the off-chain terms (job spec)
        JobState state;
    }

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error BadDeadline();
    error FeeTooHigh();
    error NotContract(); // H5: token_ / identityRegistry_ must be deployed contracts
    error UnknownJob();
    error BadState();
    error NotPayer();
    error NotProvider();
    error NotParty();
    error NotArbiter();
    error ShareTooHigh();
    error TooEarly();
    error SelfDealing(); // M2: payer cannot claim their own bounty
    error NothingToClaim(); // H3: claim() with no recorded claim
    error NotProposer(); // H4: rotation proposer is neither arbiter nor guardian
    error NoRotationPending(); // H4: confirm/cancel with nothing proposed
    error RotationTooEarly(); // H4: confirm before ROTATION_DELAY elapsed
    error BadIdentityBinding(); // claimBounty: ownerOf(agentId) != msg.sender
    error ZeroAgentId(); // claimBounty: agentId must be nonzero

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

    /// @notice ERC-8004 identity registry consulted at claim time.
    /// Live Ink address: 0x7274e874CA62410a93Bd8bf61c69d8045E399c02.
    IIdentityRegistry public immutable identityRegistry;

    /// @notice The 402 reputation ledger. This contract never records to any
    /// other ledger; writes are best-effort (see _recordRep).
    Four02ReputationRegistry public immutable reputationRegistry;

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

    event BountyCreated(
        uint256 indexed jobId, address indexed payer, uint256 amount, uint64 deadline, bytes32 termsHash
    );
    event BountyClaimed(uint256 indexed jobId, address indexed provider, uint256 indexed agentId);
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

    /// @param feeRecipient_ Suggested: the Lounge treasury
    /// 0x1795adb30465b6f77e65f42695668617b6e34ac4 (deploy-time decision).
    /// @param identityRegistry_ Live Ink: 0x7274e874CA62410a93Bd8bf61c69d8045E399c02.
    /// @param reputationRegistry_ Deployed Four02ReputationRegistry
    /// (0x33E2c56035C059553a37a3A56199B5b5b3DA3365 on Ink). Its owner must
    /// addWriter(this) after deploy — see the DEPLOY NOTE above.
    constructor(
        address token_,
        address arbiter_,
        address feeRecipient_,
        uint256 feeBps_,
        uint64 refundDelay_,
        address guardian_,
        address identityRegistry_,
        address reputationRegistry_
    ) {
        if (
            token_ == address(0) || arbiter_ == address(0) || feeRecipient_ == address(0)
                || guardian_ == address(0) || identityRegistry_ == address(0) || reputationRegistry_ == address(0)
        ) {
            revert ZeroAddress();
        }
        // H5: refuse to deploy against an address with no code. A dead token
        // address would make every bounty accounting fiction (SafeERC20
        // treats empty returndata as success); a dead identity registry
        // would make ownerOf return empty returndata and every claim revert.
        if (token_.code.length == 0 || identityRegistry_.code.length == 0) revert NotContract();
        // Fail fast on a dead reputation registry too: calls to an EOA
        // "succeed" silently and reputation would never record.
        if (reputationRegistry_.code.length == 0) revert NotContract();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        token = IERC20(token_);
        arbiter = arbiter_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        refundDelay = refundDelay_;
        guardian = guardian_;
        identityRegistry = IIdentityRegistry(identityRegistry_);
        reputationRegistry = Four02ReputationRegistry(reputationRegistry_);
    }

    // ------------------------------------------------------------------------
    // Bounty lifecycle
    // ------------------------------------------------------------------------

    /// @notice Post a funded bounty. Caller becomes the payer. Pulls `amount`
    /// of the settlement token via `transferFrom` — the payer must `approve`
    /// first. No provider is named: the bounty sits Open until claimed.
    /// @dev Deliberately NO minimum bounty: legit micro-jobs are the
    /// product, and the M2 self-claim revert kills the reputation-farming
    /// vector (farming now needs a second colluding party, which is the
    /// documented sybil caveat, not a free mint).
    function createBounty(uint256 amount, uint64 deadline, bytes32 termsHash)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert BadDeadline();

        jobId = ++jobCounter;
        jobs[jobId] = Job({
            payer: msg.sender,
            provider: address(0),
            agentId: 0,
            amount: amount,
            deadline: deadline,
            termsHash: termsHash,
            state: JobState.Open
        });

        // Effects before interactions: state is set before the token pull.
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit BountyCreated(jobId, msg.sender, amount, deadline, termsHash);
    }

    /// @notice Claim an open bounty as the worker. Callable exactly once,
    /// only from Open. Binds the caller's wallet to an ERC-8004 agentId
    /// trustlessly: IDENTITY_REGISTRY.ownerOf(agentId) must equal msg.sender,
    /// re-checked at every claim — a stale offchain enrollment row can never
    /// claim. The agentId is what reputation events are keyed to.
    /// @dev M2: the payer cannot claim their own bounty. No nonReentrant:
    /// the only external call is a view (staticcall) to the identity
    /// registry, which cannot reenter state-changingly.
    function claimBounty(uint256 jobId, uint256 agentId) external {
        Job storage job = _getJob(jobId);
        if (job.state != JobState.Open) revert BadState();
        if (msg.sender == job.payer) revert SelfDealing();
        if (agentId == 0) revert ZeroAgentId();
        // An unknown agentId reverts inside ownerOf; a wrong binding reverts
        // here. Either way the claim fails closed.
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert BadIdentityBinding();

        job.provider = msg.sender;
        job.agentId = agentId;
        job.state = JobState.Funded;
        emit BountyClaimed(jobId, msg.sender, agentId);
    }

    /// @notice Provider signals the work is done. Funded -> Delivered.
    /// @dev M3: callable any time the job is Funded — including inside the
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
    /// claim(). Records EscrowCompleted for the worker's agentId (value =
    /// the gross bounty), best-effort via try/catch.
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
        _recordRep(
            job.agentId, Four02ReputationRegistry.EventType.EscrowCompleted, job.amount, jobId, job.payer
        );
        emit JobReleased(jobId, providerAmount, fee);
    }

    /// @notice Payer or provider escalates. Open bounties cannot be disputed
    /// (nothing claimed yet); Funded/Delivered -> Disputed. Records
    /// DisputeOpened for the worker's agentId, counterparty = the other
    /// party, best-effort via try/catch.
    function raiseDispute(uint256 jobId) external {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.payer && msg.sender != job.provider) revert NotParty();
        if (job.state != JobState.Funded && job.state != JobState.Delivered) revert BadState();
        job.state = JobState.Disputed;
        address counterparty = msg.sender == job.payer ? job.provider : job.payer;
        _recordRep(job.agentId, Four02ReputationRegistry.EventType.DisputeOpened, 0, jobId, counterparty);
        emit DisputeRaised(jobId, msg.sender);
    }

    /// @notice Arbiter records the split. Disputed -> Resolved.
    /// @param providerShareBps basis points of `amount` going to the provider
    /// (0 = payer wins everything, 10000 = provider wins everything).
    /// @dev No protocol fee is taken on disputed resolutions (MVP choice —
    /// the protocol didn't facilitate a clean settlement). Reputation: the
    /// provider "wins" (ArbitrationWon, value = provider's share) when they
    /// keep at least half; otherwise ArbitrationLost (value = payer's share).
    /// DisputeResolved is always recorded with value 0 alongside the
    /// arbitration outcome. All best-effort via try/catch.
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

        _recordRep(job.agentId, Four02ReputationRegistry.EventType.DisputeResolved, 0, jobId, job.payer);
        if (providerShareBps >= BPS_DENOMINATOR / 2) {
            _recordRep(
                job.agentId, Four02ReputationRegistry.EventType.ArbitrationWon, providerAmount, jobId, job.payer
            );
        } else {
            _recordRep(
                job.agentId, Four02ReputationRegistry.EventType.ArbitrationLost, payerAmount, jobId, job.payer
            );
        }
        emit DisputeResolved(jobId, providerAmount, payerAmount);
    }

    /// @notice Refund the payer once the deadline PLUS the grace window passes
    /// with no delivery. Open or Funded -> Refunded. Permissionless: anyone
    /// may trigger it; RECORDS the payer's claim (H3) instead of pushing
    /// funds. Delivered jobs can no longer be refunded — the payer must
    /// release or dispute instead.
    /// @dev M3: the grace window kills the deadline-block mempool race where
    /// a stranger's refund could front-run the provider's confirmDelivery.
    /// Ghost path: a claimed-but-never-delivered bounty dings the worker's
    /// agentId (DisputeOpened + DisputeResolved, value 0) — a no-show is a
    /// dispute signal. An unclaimed bounty reclaims silently: no worker was
    /// ever bound, so there is no reputation to record.
    function refund(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.state != JobState.Open && job.state != JobState.Funded) revert BadState();
        if (block.timestamp < uint256(job.deadline) + refundDelay) revert TooEarly();

        bool wasClaimed = job.state == JobState.Funded;
        uint256 agentId = job.agentId;

        job.state = JobState.Refunded;
        claims[jobId][job.payer] += job.amount; // += for the uniform recording rule

        if (wasClaimed) {
            _recordRep(agentId, Four02ReputationRegistry.EventType.DisputeOpened, 0, jobId, job.payer);
            _recordRep(agentId, Four02ReputationRegistry.EventType.DisputeResolved, 0, jobId, job.payer);
        }
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

    /// @notice Best-effort reputation write to the Four02ReputationRegistry.
    /// @dev try/catch is load-bearing: if this escrow was never allowlisted
    /// via addWriter (NotWriter revert), or the registry is otherwise
    /// unhappy, the revert is swallowed and the payout path continues
    /// untouched. Reputation must never be able to brick a payout.
    function _recordRep(
        uint256 agentId,
        Four02ReputationRegistry.EventType eventType,
        uint256 value,
        uint256 jobId,
        address counterparty
    ) internal {
        try reputationRegistry.recordCommerceEvent(agentId, eventType, value, bytes32(jobId), counterparty) {}
        catch {}
    }
}
