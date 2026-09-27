// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Four02ReputationRegistryV2} from "./Four02ReputationRegistryV2.sol";

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
///      - Reputation goes to the Four02ReputationRegistryV2 — the ONLY
///        ledger for this contract (it deploys NO internal Reputation) —
///        keyed to the claimed ERC-8004 agentId. EVERY registry call is
///        wrapped in try/catch so a revert (e.g. this contract not yet
///        allowlisted as a writer) can NEVER brick a payout. Funds always
///        move; reputation is best-effort.
///
///      DEPLOY NOTE: the Four02ReputationRegistryV2 is UNDEPLOYED (the V1
///      registry at 0x33E2c56035C059553a37a3A56199B5b5b3DA3365 is
///      superseded/abandoned with an empty writer allowlist — do NOT point
///      this at V1). After V2 deploys, its owner must call
///      addWriter(bountyEscrow), or reputation calls no-op silently via
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

    /// @notice Gas stipend for the best-effort reputation write in _recordRep.
    /// Load-bearing: the try/catch around the registry call forwards ALL
    /// remaining gas by default, and a subcall that burns gas (instead of
    /// reverting) is NOT catchable — it OOGs the whole transaction. A
    /// faulty or hostile registry could therefore brick release/refund/
    /// resolveDispute and lock every in-flight bounty, voiding the
    /// "reputation can never brick a payout" invariant. The stipend bounds
    /// the blast radius: stipend exhaustion is caught and degrades to
    /// ReputationSkipped. Measured cost of recordCommerceEvent is ~287k gas
    /// cold / ~187k warm; 500k leaves headroom. If a future gas repricing
    /// pushes the real cost over the stipend, the write is skipped (not
    /// bricked) — payouts always proceed.
    uint256 public constant REP_WRITE_GAS = 500_000;

    /// @notice Upper bound on the refund grace window. A deploy with
    /// refundDelay = type(uint64).max would make refund() unreachable and
    /// lock payer funds in unclaimed/ghosted bounties forever (there is no
    /// cancelBounty). 90 days is far beyond any sane grace window.
    uint256 public constant MAX_REFUND_DELAY = 90 days;

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
        Refunded, // deadline + grace passed with no delivery; payer claim recorded
        Cancelled // payer cancelled an unclaimed bounty; payer claim recorded
    }

    struct Job {
        address payer;
        address provider; // address(0) until claimed
        uint256 agentId; // 0 until claimed — the provider's ERC-8004 identity
        uint256 amount;
        uint64 deadline;
        bytes32 termsHash; // keccak256 of the off-chain terms (job spec)
        JobState state;
        // F4/F5 dispute bookkeeping (0 / zero until the first dispute):
        uint64 disputedAt; // when the current dispute was raised
        address disputeRaiser; // who raised the current dispute (bond payer)
        JobState preDisputeState; // Funded or Delivered; restored by withdrawDispute
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
    error RotationLocked(); // H4-fix: arbiter cannot overwrite/cancel a guardian-proposed rotation
    error BadRefundDelay(); // refundDelay is 0 (voids M3) or exceeds MAX_REFUND_DELAY
    error NoExcess(); // sweep() with no stray balance above totalReserved
    error NotRaiser(); // withdrawDispute: caller didn't raise the dispute
    error TimeoutDisabled(); // resolveDisputeTimeout with disputeTimeout == 0
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

    /// @notice F3: worker claim stake, pulled at claimBounty time. Makes
    /// claim-griefing (claim with no intent to deliver) costly: the stake is
    /// returned on release(), follows the dispute winner in resolveDispute()
    /// (>= 5000 bps to provider), and is SLASHED to the payer on a ghost
    /// refund(). 0 = disabled. Suggested: $2 USDC (2_000_000).
    uint256 public immutable claimStake;

    /// @notice F4: dispute bond, pulled from the raiser at raiseDispute time.
    /// Makes dispute-spam costly: the winner takes it in resolveDispute()
    /// (provider on > 5000 bps, payer on < 5000, feeRecipient on exactly
    /// 5000), and it is refunded on withdrawDispute(). 0 = disabled.
    /// Suggested: $1 USDC (1_000_000).
    uint256 public immutable disputeBond;

    /// @notice F4: how long after disputedAt either party may call
    /// resolveDisputeTimeout() for a 50/50 split if the arbiter never acts.
    /// 0 = disabled (disputes then rely solely on the arbiter + rotation).
    /// Suggested: 30 days.
    uint64 public immutable disputeTimeout;

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
    Four02ReputationRegistryV2 public immutable reputationRegistry;

    // ------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------

    /// @notice Trusted arbiter. Mutable ONLY via the timelocked rotation
    /// (proposeRotation / confirmRotation). Deploy as the founder's multisig
    /// regardless — rotation is the fallback, not the plan.
    address public arbiter;

    /// @notice H4: pending rotation target; address(0) = none proposed.
    address public pendingArbiter;

    /// @notice H4-fix: who proposed the pending rotation (arbiter or
    /// guardian). A guardian-proposed rotation is immune to arbiter
    /// overwrite/cancel: without this, a compromised incumbent arbiter could
    /// re-propose (or cancel) forever, restarting the 14-day clock each time
    /// and making their own removal impossible — defeating the guardian
    /// recovery path while they keep resolving disputes maliciously.
    address public pendingProposer;

    /// @notice H4: earliest timestamp at which confirmRotation() may run.
    uint64 public rotationReadyAt;

    uint256 public jobCounter;
    mapping(uint256 => Job) private jobs;

    /// @notice Total USDC this contract holds AGAINST jobs: funded via
    /// createBounty and not yet withdrawn via claim(). Terminal transitions
    /// (release/resolveDispute/refund) only move accounting into the claims
    /// ledger — the funds stay, so they don't touch this counter; claim()
    /// decrements it as funds leave. Invariant: totalReserved ==
    /// balanceOf(this) - strayDirectTransfers. Backs sweep().
    uint256 public totalReserved;

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
    /// @notice F5: the dispute raiser withdrew; the job returns to its
    /// pre-dispute state (Funded or Delivered) and the bond is refunded.
    event DisputeWithdrawn(uint256 indexed jobId, address indexed raiser);
    event JobRefunded(uint256 indexed jobId);
    /// @notice F6: the payer cancelled an unclaimed bounty; their full
    /// funding is claimable. No reputation event (no worker was ever bound).
    event BountyCancelled(uint256 indexed jobId);
    event Claimed(uint256 indexed jobId, address indexed claimant, uint256 amount);
    event RotationProposed(
        address indexed proposer, address indexed currentArbiter, address indexed newArbiter, uint64 readyAt
    );
    event RotationConfirmed(address indexed oldArbiter, address indexed newArbiter);
    event RotationCancelled(address indexed canceller, address indexed newArbiter);
    /// @notice Emitted by sweep(): stray USDC sent outside createBounty
    /// recovered to the fee recipient. Amount is always
    /// balanceOf(this) - totalReserved, so job funds are never touched.
    event ExcessSwept(address indexed to, uint256 amount);
    /// @notice Emitted when a reputation write was SKIPPED because the
    /// registry call reverted (e.g. this escrow was never allowlisted via
    /// addWriter). The payout path continued untouched — reputation is
    /// best-effort by design. Operators: an empty writer allowlist after
    /// deploy shows up here, not in a bricked payout.
    event ReputationSkipped(
        uint256 indexed jobId, uint256 indexed agentId, Four02ReputationRegistryV2.EventType eventType
    );

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /// @param feeRecipient_ Suggested: the Lounge treasury
    /// 0x1795adb30465b6f77e65f42695668617b6e34ac4 (deploy-time decision).
    /// @param identityRegistry_ Live Ink: 0x7274e874CA62410a93Bd8bf61c69d8045E399c02.
    /// @param reputationRegistry_ Deployed Four02ReputationRegistryV2
    /// (UNDEPLOYED — the V1 at 0x33E2c56035C059553a37a3A56199B5b5b3DA3365 is
    /// superseded/abandoned, do NOT use it). Its owner must addWriter(this)
    /// after deploy — see the DEPLOY NOTE above.
    /// @param claimStake_ F3 worker claim stake (0 = disabled). Suggested $2.
    /// @param disputeBond_ F4 dispute bond posted by the raiser (0 = disabled).
    /// Suggested $1.
    /// @param disputeTimeout_ F4 timeout after which either party may
    /// force a 50/50 split (0 = disabled). Suggested 30 days.
    constructor(
        address token_,
        address arbiter_,
        address feeRecipient_,
        uint256 feeBps_,
        uint64 refundDelay_,
        address guardian_,
        address identityRegistry_,
        address reputationRegistry_,
        uint256 claimStake_,
        uint256 disputeBond_,
        uint64 disputeTimeout_
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
        // A zero delay silently voids the M3 mempool-race protection (refund
        // could win the deadline block against a provider's confirmDelivery);
        // an unbounded delay locks payer funds in unclaimed bounties forever.
        if (refundDelay_ == 0 || refundDelay_ > MAX_REFUND_DELAY) revert BadRefundDelay();
        token = IERC20(token_);
        arbiter = arbiter_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        refundDelay = refundDelay_;
        claimStake = claimStake_;
        disputeBond = disputeBond_;
        disputeTimeout = disputeTimeout_;
        guardian = guardian_;
        identityRegistry = IIdentityRegistry(identityRegistry_);
        reputationRegistry = Four02ReputationRegistryV2(reputationRegistry_);
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
            state: JobState.Open,
            disputedAt: 0,
            disputeRaiser: address(0),
            preDisputeState: JobState.Open
        });

        // Effects before interactions: state is set before the token pull.
        token.safeTransferFrom(msg.sender, address(this), amount);
        totalReserved += amount; // only count what actually arrived
        emit BountyCreated(jobId, msg.sender, amount, deadline, termsHash);
    }

    /// @notice Claim an open bounty as the worker. Callable exactly once,
    /// only from Open. Binds the caller's wallet to an ERC-8004 agentId
    /// trustlessly: IDENTITY_REGISTRY.ownerOf(agentId) must equal msg.sender,
    /// re-checked at every claim — a stale offchain enrollment row can never
    /// claim. The agentId is what reputation events are keyed to.
    /// @dev M2: the payer cannot claim their own bounty. nonReentrant:
    /// ownerOf is a REGULAR external call (not a staticcall) into a
    /// deploy-time-chosen registry address — state is written only after it
    /// returns, so a malicious registry contract could otherwise reenter and
    /// overwrite provider/agentId mid-claim.
    function claimBounty(uint256 jobId, uint256 agentId) external nonReentrant {
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
        // F3: the worker posts the claim stake up front (0 = disabled).
        // Pulled AFTER state is written (nonReentrant anyway); a worker who
        // hasn't approved the stake reverts here and the claim fails closed.
        if (claimStake > 0) {
            token.safeTransferFrom(msg.sender, address(this), claimStake);
            totalReserved += claimStake;
        }
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

        // mulDiv, not (amount * feeBps) / DENOMINATOR: the naive multiply
        // overflows for amount > ~2^250 (feeBps=75) and would brick release()
        // with a panic, stranding the job in Delivered. Identical result for
        // every non-overflowing input.
        uint256 fee = Math.mulDiv(job.amount, feeBps, BPS_DENOMINATOR);
        uint256 providerAmount = job.amount - fee;

        // Accumulated (+=), not assigned: if feeRecipient == provider the two
        // payees share one slot, and assignment would overwrite the provider's
        // share. Safe because each job records claims exactly once — terminal
        // transitions are one-way, so this is the only write to these slots.
        claims[jobId][job.provider] += providerAmount;
        if (claimStake > 0) {
            // F3: honest completion returns the worker's stake on top.
            claims[jobId][job.provider] += claimStake;
        }
        if (fee > 0) {
            claims[jobId][feeRecipient] += fee;
        }
        _recordRep(
            job.agentId, Four02ReputationRegistryV2.EventType.EscrowCompleted, job.amount, jobId, job.payer
        );
        emit JobReleased(jobId, providerAmount, fee);
    }

    /// @notice Payer or provider escalates. Open bounties cannot be disputed
    /// (nothing claimed yet); Funded/Delivered -> Disputed. Records
    /// DisputeOpened for the worker's agentId, counterparty = the other
    /// party, best-effort via try/catch.
    /// @dev F4: the raiser posts the dispute bond (0 = disabled) — pulled
    /// after the state transition, under nonReentrant. F5: the pre-dispute
    /// state and raiser are recorded so withdrawDispute() can restore.
    /// nonReentrant: _recordRep makes an external call into the
    /// deploy-time registry address (a regular CALL, not a staticcall), so a
    /// hostile registry could otherwise reenter mid-dispute.
    function raiseDispute(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.payer && msg.sender != job.provider) revert NotParty();
        if (job.state != JobState.Funded && job.state != JobState.Delivered) revert BadState();
        job.preDisputeState = job.state;
        job.disputeRaiser = msg.sender;
        job.disputedAt = uint64(block.timestamp);
        job.state = JobState.Disputed;
        if (disputeBond > 0) {
            token.safeTransferFrom(msg.sender, address(this), disputeBond);
            totalReserved += disputeBond;
        }
        address counterparty = msg.sender == job.payer ? job.provider : job.payer;
        _recordRep(job.agentId, Four02ReputationRegistryV2.EventType.DisputeOpened, 0, jobId, counterparty);
        emit DisputeRaised(jobId, msg.sender);
    }

    /// @notice F5: the dispute RAISER withdraws an unresolved dispute (e.g.
    /// the parties reconciled offchain). Restores the pre-dispute state
    /// (Funded or Delivered), refunds the dispute bond, and records
    /// DisputeWithdrawn (which neutralizes the DisputeOpened in disputeRate).
    /// Only the raiser may withdraw — the other party cannot unilaterally
    /// erase a dispute raised against them.
    function withdrawDispute(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.state != JobState.Disputed) revert BadState();
        if (msg.sender != job.disputeRaiser) revert NotRaiser();
        job.state = job.preDisputeState;
        if (disputeBond > 0) {
            totalReserved -= disputeBond;
            token.safeTransfer(msg.sender, disputeBond);
        }
        address counterparty = msg.sender == job.payer ? job.provider : job.payer;
        _recordRep(job.agentId, Four02ReputationRegistryV2.EventType.DisputeWithdrawn, 0, jobId, counterparty);
        emit DisputeWithdrawn(jobId, msg.sender);
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
    /// F3: the claim stake follows the arbitration winner (>= 5000 bps to
    /// the provider, else the payer). F4: the dispute bond goes to the
    /// LARGER-share side (provider on > 5000, payer on < 5000, feeRecipient
    /// on exactly 5000).
    function resolveDispute(uint256 jobId, uint256 providerShareBps) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        _resolveDispute(jobId, providerShareBps);
    }

    /// @notice F4: either party force-resolves a dispute the arbiter never
    /// touches. Available only when disputeTimeout > 0 and
    /// disputedAt + disputeTimeout has passed. Splits 50/50 with identical
    /// accounting and reputation events to resolveDispute(5000): the stake
    /// goes to the provider, the bond (on the exact tie) to the feeRecipient.
    function resolveDisputeTimeout(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.payer && msg.sender != job.provider) revert NotParty();
        if (job.state != JobState.Disputed) revert BadState();
        if (disputeTimeout == 0) revert TimeoutDisabled();
        if (block.timestamp < uint256(job.disputedAt) + disputeTimeout) revert TooEarly();
        _resolveDispute(jobId, BPS_DENOMINATOR / 2);
    }

    function _resolveDispute(uint256 jobId, uint256 providerShareBps) internal {
        Job storage job = _getJob(jobId);
        if (job.state != JobState.Disputed) revert BadState();
        if (providerShareBps > BPS_DENOMINATOR) revert ShareTooHigh();

        job.state = JobState.Resolved;

        // mulDiv for the same overflow reason as release(): a naive
        // (amount * providerShareBps) bricks the dispute exit for absurd
        // amounts; the remainder still goes to the payer.
        uint256 providerAmount = Math.mulDiv(job.amount, providerShareBps, BPS_DENOMINATOR);
        uint256 payerAmount = job.amount - providerAmount;

        // += so overlapping payee slots accumulate (see release()); each job
        // records exactly once, so this is the only write to these slots.
        if (providerAmount > 0) {
            claims[jobId][job.provider] += providerAmount;
        }
        if (payerAmount > 0) {
            claims[jobId][job.payer] += payerAmount;
        }
        // F3: the claim stake follows the arbitration winner.
        if (claimStake > 0) {
            if (providerShareBps >= BPS_DENOMINATOR / 2) {
                claims[jobId][job.provider] += claimStake;
            } else {
                claims[jobId][job.payer] += claimStake;
            }
        }
        // F4: the dispute bond rewards the larger-share side; an exact tie
        // pays the protocol (it backstopped the timeout machinery).
        if (disputeBond > 0) {
            if (providerShareBps > BPS_DENOMINATOR / 2) {
                claims[jobId][job.provider] += disputeBond;
            } else if (providerShareBps < BPS_DENOMINATOR / 2) {
                claims[jobId][job.payer] += disputeBond;
            } else {
                claims[jobId][feeRecipient] += disputeBond;
            }
        }

        _recordRep(job.agentId, Four02ReputationRegistryV2.EventType.DisputeResolved, 0, jobId, job.payer);
        if (providerShareBps >= BPS_DENOMINATOR / 2) {
            _recordRep(
                job.agentId, Four02ReputationRegistryV2.EventType.ArbitrationWon, providerAmount, jobId, job.payer
            );
        } else {
            _recordRep(
                job.agentId, Four02ReputationRegistryV2.EventType.ArbitrationLost, payerAmount, jobId, job.payer
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
    /// Ghost path: a claimed-but-never-delivered bounty records a single
    /// WorkerGhosted event (value 0) against the worker's agentId — a
    /// no-show is a dispute signal: it counts in disputeRate and dings
    /// reliability via the registry's ghost penalty. An unclaimed bounty
    /// reclaims silently: no worker was ever bound, so there is no
    /// reputation to record.
    function refund(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.state != JobState.Open && job.state != JobState.Funded) revert BadState();
        if (block.timestamp < uint256(job.deadline) + refundDelay) revert TooEarly();

        bool wasClaimed = job.state == JobState.Funded;
        uint256 agentId = job.agentId;

        job.state = JobState.Refunded;
        if (wasClaimed) {
            // F3: the ghost SLASH — the worker's stake goes to the payer on
            // top of their refund. Claim-griefing now costs real money.
            claims[jobId][job.payer] += job.amount + claimStake; // += for the uniform recording rule
            _recordRep(
                agentId, Four02ReputationRegistryV2.EventType.WorkerGhosted, 0, jobId, job.payer
            );
        } else {
            claims[jobId][job.payer] += job.amount; // += for the uniform recording rule
        }
        emit JobRefunded(jobId);
    }

    /// @notice F6: the payer cancels an UNCLAIMED bounty (fat-finger rescue).
    /// Open -> Cancelled; the payer's full funding is claimable via claim().
    /// Callable any time before a claim — no deadline wait, no reputation
    /// event (no worker was ever bound, so there is nothing to judge).
    function cancelBounty(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.payer) revert NotPayer();
        if (job.state != JobState.Open) revert BadState();
        job.state = JobState.Cancelled;
        claims[jobId][job.payer] += job.amount;
        emit BountyCancelled(jobId);
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
        totalReserved -= amount; // funds leave the contract here
        token.safeTransfer(msg.sender, amount);
        emit Claimed(jobId, msg.sender, amount);
    }

    /// @notice Recover USDC sent to this contract OUTSIDE createBounty
    /// (a direct transfer has no job, no claim entry, and no other exit —
    /// without this it locks forever). Permissionless to call; the payout
    /// goes to the immutable feeRecipient. Can only move the stray excess:
    /// balanceOf(this) - totalReserved, so recorded job funds are provably
    /// untouched (totalReserved exactly tracks funded-but-unclaimed USDC).
    function sweep() external nonReentrant {
        uint256 reserved = totalReserved;
        uint256 bal = token.balanceOf(address(this));
        if (bal <= reserved) revert NoExcess();
        uint256 excess = bal - reserved;
        token.safeTransfer(feeRecipient, excess);
        emit ExcessSwept(feeRecipient, excess);
    }

    // ------------------------------------------------------------------------
    // Arbiter rotation (H4)
    // ------------------------------------------------------------------------

    /// @notice Propose a new arbiter. Callable by the current arbiter OR the
    /// guardian (founder EOA). Starts the ROTATION_DELAY timelock; anyone may
    /// then call confirmRotation() once it elapses.
    /// @dev Overwriting rules (H4-fix): the guardian may always propose
    /// (overriding anything pending); the arbiter may propose when nothing
    /// is pending or replace their OWN pending proposal — but can NEVER
    /// overwrite a guardian-proposed rotation. Without this, a compromised
    /// incumbent could re-propose every 13 days, restarting the clock
    /// forever and making their own removal impossible.
    /// @dev The guardian can never touch funds — only rotate the arbiter,
    /// and only after 14 days of public visibility.
    function proposeRotation(address newArbiter) external {
        if (msg.sender != arbiter && msg.sender != guardian) revert NotProposer();
        if (newArbiter == address(0)) revert ZeroAddress();
        if (pendingArbiter != address(0) && pendingProposer == guardian && msg.sender != guardian) {
            revert RotationLocked();
        }
        pendingArbiter = newArbiter;
        pendingProposer = msg.sender;
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
        pendingProposer = address(0);
        rotationReadyAt = 0;
        emit RotationConfirmed(oldArbiter, newArbiter);
    }

    /// @notice Cancel a pending rotation. The guardian may always cancel; the
    /// arbiter may cancel only a rotation THEY proposed. In particular the
    /// incumbent arbiter cannot cancel a guardian-proposed removal (that
    /// would defeat the recovery path exactly when it is needed).
    function cancelRotation() external {
        if (msg.sender != guardian && msg.sender != pendingProposer) revert NotProposer();
        address cancelled = pendingArbiter;
        if (cancelled == address(0)) revert NoRotationPending();
        pendingArbiter = address(0);
        pendingProposer = address(0);
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

    /// @notice Best-effort reputation write to the Four02ReputationRegistryV2.
    /// @dev try/catch is load-bearing: if this escrow was never allowlisted
    /// via addWriter (NotWriter revert), or the registry is otherwise
    /// unhappy, the revert is swallowed and the payout path continues
    /// untouched. Reputation must never be able to brick a payout. The
    /// skip is emitted (ReputationSkipped) so a missing allowlist is
    /// observable instead of silent.
    ///
    /// Two further hardening notes:
    /// - Gas stipend (REP_WRITE_GAS): try/catch does NOT catch out-of-gas.
    ///   A registry that burns gas instead of reverting would OOG the whole
    ///   transaction and brick the payout. The stipend bounds the call; its
    ///   exhaustion is caught like any other failure.
    /// - refId namespacing: the registry's dispute neutralization is keyed
    ///   by (agentId, refId) GLOBALLY across writers, and every 402 contract
    ///   starts its id counter at 1. A raw bytes32(jobId) would let one
    ///   writer's DisputeResolved neutralize a DIFFERENT writer's
    ///   DisputeOpened for the same agent (e.g. two deployments of this
    ///   escrow, or a future invoice contract), corrupting disputeRate.
    ///   Hashing in address(this) keeps each writer's refId space disjoint.
    function _recordRep(
        uint256 agentId,
        Four02ReputationRegistryV2.EventType eventType,
        uint256 value,
        uint256 jobId,
        address counterparty
    ) internal {
        bytes32 refId = keccak256(abi.encode(address(this), jobId));
        try reputationRegistry.recordCommerceEvent{gas: REP_WRITE_GAS}(
            agentId, eventType, value, refId, counterparty
        ) {} catch {
            emit ReputationSkipped(jobId, agentId, eventType);
        }
    }
}
