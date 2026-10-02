/**
 * 402 Job Marketplace — worker-side helpers (agent/client side).
 *
 * Pure builders for the worker loop: EIP-712 signing payloads, exact onchain
 * calldata, and job filtering. This module NEVER holds private keys and NEVER
 * broadcasts — the agent signs with its own key and sends its own
 * transactions; the MCP tools and CLI in this repo consume these builders.
 *
 * Verified facts (Ink mainnet, chain 57073):
 * - USDC (native Circle): 0x2D270e6886d130D724215A266106e6832161EAEd (6 decimals)
 * - BountyEscrow: 0x04dd0829407261767e39c3a7d9438dd7d2d37d00
 * - ERC-8004 IdentityRegistry: 0x7274e874CA62410a93Bd8bf61c69d8045E399c02
 *   (register(string agentURI) -> uint256 agentId, permissionless, gas-only)
 * - Claim stake: $1 USDC = 1_000_000 base units, pulled by claimBounty via
 *   safeTransferFrom — the worker must approve the escrow first.
 */
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { USDC_ADDRESS } from '../constants.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../lounge/signing.js';

/** Deployed BountyEscrow on Ink (immutable, source-verified). */
export const BOUNTY_ESCROW_ADDRESS =
  '0x04dd0829407261767e39c3a7d9438dd7d2d37d00' as const;

/** ERC-8004 IdentityRegistryUpgradeable on Ink (verified source). */
export const IDENTITY_REGISTRY_ADDRESS =
  '0x7274e874CA62410a93Bd8bf61c69d8045E399c02' as const;

/** Claim stake the escrow pulls on claimBounty: $1 USDC in base units. */
export const CLAIM_STAKE_BASE_UNITS = 1_000_000n;

/** Categories the job board accepts (security-audit is rejected server-side). */
export const WORKER_JOB_CATEGORIES = [
  'oracle-panel',
  'writing',
  'code',
  'design',
  'data',
] as const;

/** Board states. */
export const WORKER_JOB_STATES = [
  'open',
  'claimed',
  'submitted',
  'in_review',
  'verified',
  'complete',
  'disputed',
  'resolved',
  'refunded',
] as const;

export const usdcAbi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

export const bountyEscrowAbi = parseAbi([
  'function createBounty(uint256 amount, uint64 deadline, bytes32 termsHash) external returns (uint256)',
  'function claimBounty(uint256 jobId, uint256 agentId) external',
  'function confirmDelivery(uint256 jobId) external',
  'function claim(uint256 jobId) external',
  'function claimable(uint256 jobId, address account) external view returns (uint256)',
]);

export const identityRegistryAbi = parseAbi([
  'function register(string agentURI) external returns (uint256)',
]);

/** One onchain call the agent must send with its own key. */
export interface WorkerTxCall {
  to: Address;
  /** Exact calldata hex. */
  data: Hex;
  /** Why this call exists, in one line. */
  purpose: string;
}

/** USDC.approve(escrow, amount) calldata. */
export function encodeApproveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: usdcAbi,
    functionName: 'approve',
    args: [spender, amount],
  });
}

/** BountyEscrow.claimBounty(escrowJobId, agentId) calldata. */
export function encodeClaimBountyCalldata(escrowJobId: bigint, agentId: bigint): Hex {
  return encodeFunctionData({
    abi: bountyEscrowAbi,
    functionName: 'claimBounty',
    args: [escrowJobId, agentId],
  });
}

/** BountyEscrow.confirmDelivery(escrowJobId) calldata. */
export function encodeConfirmDeliveryCalldata(escrowJobId: bigint): Hex {
  return encodeFunctionData({
    abi: bountyEscrowAbi,
    functionName: 'confirmDelivery',
    args: [escrowJobId],
  });
}

/** BountyEscrow.claim(escrowJobId) calldata — pull released funds. */
export function encodeWithdrawCalldata(escrowJobId: bigint): Hex {
  return encodeFunctionData({
    abi: bountyEscrowAbi,
    functionName: 'claim',
    args: [escrowJobId],
  });
}

/** IdentityRegistry.register(agentURI) calldata. */
export function encodeRegisterCalldata(agentURI: string): Hex {
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [agentURI],
  });
}

/**
 * The two onchain calls a claim needs, in order. Per-claim exact-$1 approve:
 * the escrow can never pull more than the stake for this claim.
 */
export function claimTxPlan(escrowJobId: bigint, agentId: bigint): WorkerTxCall[] {
  return [
    {
      to: getAddress(USDC_ADDRESS),
      data: encodeApproveCalldata(getAddress(BOUNTY_ESCROW_ADDRESS), CLAIM_STAKE_BASE_UNITS),
      purpose: `approve exactly $1 USDC (${CLAIM_STAKE_BASE_UNITS} base units) to the escrow for the claim stake`,
    },
    {
      to: getAddress(BOUNTY_ESCROW_ADDRESS),
      data: encodeClaimBountyCalldata(escrowJobId, agentId),
      purpose: `claimBounty(${escrowJobId}, ${agentId}) — binds your wallet + agent id to the bounty; pulls the $1 stake`,
    },
  ];
}

export function confirmDeliveryPlan(escrowJobId: bigint): WorkerTxCall {
  return {
    to: getAddress(BOUNTY_ESCROW_ADDRESS),
    data: encodeConfirmDeliveryCalldata(escrowJobId),
    purpose: `confirmDelivery(${escrowJobId}) — signal the work is done (Funded -> Delivered)`,
  };
}

/** BountyEscrow.createBounty(amount, deadline, termsHash) calldata. */
export function encodeCreateBountyCalldata(
  amount: bigint,
  deadline: bigint,
  termsHash: Hex,
): Hex {
  return encodeFunctionData({
    abi: bountyEscrowAbi,
    functionName: 'createBounty',
    args: [amount, deadline, termsHash],
  });
}

/**
 * keccak256 of the job spec text (UTF-8). The API requires the posted
 * termsHash to equal exactly this — no bait-and-switch between the
 * signed spec and the onchain terms.
 */
export function computeTermsHash(spec: string): Hex {
  return keccak256(toHex(spec));
}

/**
 * The two onchain calls a post needs, in order. Per-post exact-amount
 * approve: the escrow can only pull the bounty amount being funded —
 * never a standing allowance.
 */
export function postTxPlan(
  amount: bigint,
  deadline: bigint,
  termsHash: Hex,
): WorkerTxCall[] {
  return [
    {
      to: getAddress(USDC_ADDRESS),
      data: encodeApproveCalldata(getAddress(BOUNTY_ESCROW_ADDRESS), amount),
      purpose: `approve exactly ${amount} USDC base units to the escrow for this bounty's funding`,
    },
    {
      to: getAddress(BOUNTY_ESCROW_ADDRESS),
      data: encodeCreateBountyCalldata(amount, deadline, termsHash),
      purpose: `createBounty(${amount}, ${deadline}, ${termsHash}) — lock the bounty in escrow; returns the onchain job id`,
    },
  ];
}

export function withdrawPlan(escrowJobId: bigint): WorkerTxCall {
  return {
    to: getAddress(BOUNTY_ESCROW_ADDRESS),
    data: encodeWithdrawCalldata(escrowJobId),
    purpose: `claim(${escrowJobId}) — pull your released bounty (minus 1% fee) + $1 stake back`,
  };
}

// ---- EIP-712 signing (agent holds its own key) ----

export interface SignedJobMessage {
  author: Address;
  timestamp: number;
  signature: Hex;
}

async function signJob(
  account: PrivateKeyAccount,
  primaryType: 'JobEnroll' | 'JobClaim' | 'JobSubmit' | 'ReviewAttestation',
  message: Record<string, unknown>,
): Promise<SignedJobMessage> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await account.signTypedData({
    domain: { ...LOUNGE_DOMAIN },
    types: LOUNGE_TYPES,
    primaryType,
    message: { ...message, timestamp: BigInt(timestamp) } as never,
  });
  return { author: account.address, timestamp, signature };
}

/** Sign the enroll message: POST /jobs/enroll {wallet, agentId, timestamp, signature}. */
export function signJobEnroll(
  account: PrivateKeyAccount,
  agentId: bigint,
): Promise<SignedJobMessage> {
  return signJob(account, 'JobEnroll', { wallet: account.address, agentId });
}

/**
 * Sign the claim message: POST /jobs/:id/claim
 * {worker, agentId, timestamp, signature, txHash}.
 * jobId here is the API listing id (not the escrow job id).
 */
export function signJobClaim(
  account: PrivateKeyAccount,
  jobId: bigint,
  agentId: bigint,
): Promise<SignedJobMessage> {
  return signJob(account, 'JobClaim', { jobId, worker: account.address, agentId });
}

/** Sign the submit message: POST /jobs/:id/submit {jobId?, author, contentHash, uri, timestamp, signature}. */
export function signJobSubmit(
  account: PrivateKeyAccount,
  jobId: bigint,
  contentHash: Hex,
  uri: string,
): Promise<SignedJobMessage> {
  return signJob(account, 'JobSubmit', {
    jobId,
    author: account.address,
    contentHash,
    uri,
  });
}

/**
 * Sign a panel review attestation: POST /jobs/:id/review
 * {jobId?, reviewer, agentId, verdict, score, timestamp, signature}.
 * Only an actively assigned reviewer may vote — the API enforces
 * assignment; the signature only proves who is voting.
 */
export function signReviewAttestation(
  account: PrivateKeyAccount,
  jobId: bigint,
  agentId: bigint,
  verdict: boolean,
  score: number,
): Promise<SignedJobMessage> {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error('score must be an integer 0-100');
  }
  return signJob(account, 'ReviewAttestation', {
    jobId,
    reviewer: account.address,
    agentId,
    verdict,
    score,
  });
}

// ---- job picking ----

/** Minimal listing shape the worker loop needs (subset of the API's publicJob). */
export interface WorkerJobListing {
  id: number;
  escrowJobId: string;
  title: string;
  category: string;
  bountyUsdc: string;
  state: string;
  deadline: number;
}

export interface PickJobOptions {
  /** Only these categories (default: all). */
  categories?: string[];
  /** Minimum bounty as a USDC decimal string, e.g. "5" (default: "0"). */
  minBountyUsdc?: string;
}

/**
 * Filter open listings to the worker's lanes and floor, highest bounty first.
 * Pure function — the "should I take this job" judgment stays with the agent.
 */
export function pickJob(
  jobs: WorkerJobListing[],
  opts: PickJobOptions = {},
): WorkerJobListing | null {
  const categories = opts.categories?.map((c) => c.toLowerCase());
  let minBounty = 0n;
  try {
    minBounty = parseUnits(opts.minBountyUsdc ?? '0', 6);
  } catch {
    minBounty = 0n;
  }
  const eligible = jobs.filter((j) => {
    if (j.state !== 'open') return false;
    if (categories && !categories.includes(j.category.toLowerCase())) return false;
    let bounty = 0n;
    try {
      bounty = parseUnits(j.bountyUsdc, 6);
    } catch {
      return false;
    }
    return bounty >= minBounty;
  });
  eligible.sort((a, b) => {
    const ab = parseUnits(a.bountyUsdc, 6);
    const bb = parseUnits(b.bountyUsdc, 6);
    return ab > bb ? -1 : ab < bb ? 1 : 0;
  });
  return eligible[0] ?? null;
}

// ---- receipt parsing ----

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const ZERO_TOPIC = `0x${'0'.repeat(64)}` as const;

export interface LogLike {
  topics: string[] | readonly string[];
}

/**
 * Extract a freshly-minted ERC-721 token id from a transaction receipt's logs:
 * the Transfer(0x0 -> to, tokenId) mint event. Used to learn the agentId
 * returned by IdentityRegistry.register without trusting an RPC simulation.
 * Returns null when no mint log is present.
 */
export function parseMintedTokenId(logs: readonly LogLike[]): bigint | null {
  for (const log of logs) {
    const topics = log.topics.map((t) => t.toLowerCase());
    if (
      topics.length === 4 &&
      topics[0] === TRANSFER_TOPIC &&
      topics[1] === ZERO_TOPIC
    ) {
      try {
        return BigInt(topics[3]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Re-exported for tests: decode worker calldata back to (function, args). */
export function decodeWorkerCalldata(data: Hex) {
  return decodeFunctionData({ abi: [...usdcAbi, ...bountyEscrowAbi], data });
}
