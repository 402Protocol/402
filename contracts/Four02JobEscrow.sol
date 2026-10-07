// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Four Zero Two Labs, Inc.
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Four02JobEscrow
/// @notice Optional ERC-8183 job primitive; see docs/erc-8183.md for the pinned draft profile.
/// @dev Single immutable exact-transfer token, no admin, proxy, fees, hooks, or reputation dependency.
///      Evaluators are trusted. At expiry, submission/completion stop and anyone can refund the client.
///      Direct token transfers are NOT job funding and cannot be recovered through this contract.
contract Four02JobEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant PROFILE = "erc8183-a078cab5-no-hooks-v1";
    IERC20 public immutable paymentToken;

    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
    }

    mapping(uint256 => Job) private jobs;
    uint256 public jobCounter;
    /// @notice Sum of budgets in Funded or Submitted; unsolicited transfers never increase this.
    uint256 public totalEscrowed;

    error InvalidToken();
    error InvalidJob();
    error InvalidParty();
    error InvalidExpiry();
    error WrongStatus();
    error Unauthorized();
    error ProviderAlreadySet();
    error ProviderNotSet();
    error ZeroBudget();
    error BudgetMismatch();
    error DeadlinePassed();
    error NotExpired();
    error InexactTransfer();

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor(address paymentToken_) {
        if (paymentToken_.code.length == 0) revert InvalidToken();
        paymentToken = IERC20(paymentToken_);
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        // The escrow and token cannot act as participants. Overlapping real participant roles are allowed.
        _checkParty(msg.sender);
        _checkParty(evaluator);
        if (provider != address(0)) _checkParty(provider);
        if (expiredAt <= block.timestamp) revert InvalidExpiry();
        jobId = ++jobCounter;
        jobs[jobId] = Job(jobId, msg.sender, provider, evaluator, description, 0, expiredAt, JobStatus.Open);
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    function setProvider(uint256 jobId, address provider) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert ProviderAlreadySet();
        _checkParty(provider);
        job.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    function setBudget(uint256 jobId, uint256 amount) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        job.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    /// @notice Client approves exactly the budget on paymentToken, then calls fund with that same quote.
    function fund(uint256 jobId, uint256 expectedBudget) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        _beforeDeadline(job);
        job.status = JobStatus.Funded;
        totalEscrowed += job.budget;
        uint256 clientBefore = paymentToken.balanceOf(job.client);
        uint256 escrowBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(job.client, address(this), job.budget);
        if (
            clientBefore < job.budget || paymentToken.balanceOf(job.client) != clientBefore - job.budget
                || paymentToken.balanceOf(address(this)) != escrowBefore + job.budget
        ) revert InexactTransfer();
        emit JobFunded(jobId, job.client, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        _beforeDeadline(job);
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        _beforeDeadline(job);
        job.status = JobStatus.Completed;
        _release(job.provider, job.budget);
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    /// @notice Client cancels Open jobs; evaluator rejects Funded/Submitted jobs, including after expiry.
    function reject(uint256 jobId, bytes32 reason) external nonReentrant {
        Job storage job = _job(jobId);
        JobStatus previous = job.status;
        if (previous == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (previous == JobStatus.Funded || previous == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }
        job.status = JobStatus.Rejected;
        if (previous != JobStatus.Open) {
            _release(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
    }

    /// @notice Permissionless at timestamp >= expiredAt, without a grace period or automatic keeper.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert NotExpired();
        job.status = JobStatus.Expired;
        _release(job.client, job.budget);
        emit Refunded(jobId, job.client, job.budget);
        emit JobExpired(jobId);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function _job(uint256 jobId) private view returns (Job storage job) {
        job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
    }

    function _checkParty(address party) private view {
        if (party == address(0) || party == address(this) || party == address(paymentToken)) revert InvalidParty();
    }

    function _beforeDeadline(Job storage job) private view {
        if (block.timestamp >= job.expiredAt) revert DeadlinePassed();
    }

    function _release(address recipient, uint256 amount) private {
        totalEscrowed -= amount;
        uint256 escrowBefore = paymentToken.balanceOf(address(this));
        uint256 recipientBefore = paymentToken.balanceOf(recipient);
        paymentToken.safeTransfer(recipient, amount);
        if (
            escrowBefore < amount || paymentToken.balanceOf(address(this)) != escrowBefore - amount
                || paymentToken.balanceOf(recipient) != recipientBefore + amount
        ) revert InexactTransfer();
    }
}
