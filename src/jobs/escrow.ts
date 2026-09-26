/**
 * 402 Job Marketplace v0 — onchain verification (read-only).
 *
 * The API never broadcasts and never signs for users. Every money-moving
 * transition mirrors an onchain escrow transition that the caller already
 * made (site UI or their own agent); we verify it from the tx receipt (or
 * the transaction calldata for void-arg-less calls) before touching the
 * DB. All fetchers are injectable: viem public clients in prod, mocks in
 * tests (dead-localhost — nothing touches mainnet, no real funds).
 *
 * Event/function names are EXACTLY the contract team's interface (spec
 * 2026-09-26):
 *   functions: createBounty(uint256,uint64,bytes32), claimBounty(uint256,uint256),
 *              release(uint256), raiseDispute(uint256)
 *   events:    BountyCreated(uint256 indexed jobId, address indexed payer,
 *                           uint256 amount, uint64 deadline, bytes32 termsHash)
 *              BountyClaimed(uint256 indexed jobId, address indexed provider,
 *                           uint256 indexed agentId)
 *
 * Reputation note (spec §Reputation wiring): the API NEVER writes
 * reputation. The BountyEscrow contract itself calls
 * Four02ReputationRegistryV2.recordCommerceEvent inside release /
 * resolveDispute / refund (the ghost path records WorkerGhosted) — the
 * API only mirrors outcomes after verifying the txHash. That keeps the
 * sunlight property: every reputation event is backed by an onchain
 * transition, and a compromised API server cannot invent worker resumes.
 */
import {
  type Address,
  type Hex,
  createPublicClient,
  decodeAbiParameters,
  http,
  keccak256,
  toHex,
} from 'viem';
import { ink } from '../constants.js';
import { verifyTransferPayment } from '../lounge/payments.js';
import type { GetReceipt } from '../lounge/types.js';

/** ERC-8004 identity registry on Ink (verified 2026-09-25). */
export const IDENTITY_REGISTRY =
  '0x7274e874CA62410a93Bd8bf61c69d8045E399c02' as const;

/**
 * Four02ReputationRegistry V1 on Ink (deployed 2026-09-25) — SUPERSEDED.
 * Default for FOUR02_REPUTATION_REGISTRY until the V2 address is set.
 */
export const REPUTATION_REGISTRY =
  '0x33E2c56035C059553a37a3A56199B5b5b3DA3365' as const;

/** keccak256("BountyCreated(uint256,address,uint256,uint64,bytes32)") */
export const BOUNTY_CREATED_TOPIC = keccak256(
  toHex('BountyCreated(uint256,address,uint256,uint64,bytes32)'),
);

/** keccak256("BountyClaimed(uint256,address,uint256)") */
export const BOUNTY_CLAIMED_TOPIC = keccak256(
  toHex('BountyClaimed(uint256,address,uint256)'),
);

/** keccak256("JobRefunded(uint256)") */
export const JOB_REFUNDED_TOPIC = keccak256(toHex('JobRefunded(uint256)'));

/** keccak256("DisputeResolved(uint256,uint256,uint256)") */
export const DISPUTE_RESOLVED_TOPIC = keccak256(
  toHex('DisputeResolved(uint256,uint256,uint256)'),
);

/** 4-byte selectors for the escrow calls we verify via tx calldata. */
export const RELEASE_SELECTOR = keccak256(toHex('release(uint256)')).slice(0, 10);
export const RAISE_DISPUTE_SELECTOR = keccak256(
  toHex('raiseDispute(uint256)'),
).slice(0, 10);

function addressTopic(addr: string): string {
  return ('0x' + addr.slice(2).toLowerCase().padStart(64, '0')).toLowerCase();
}

function uintTopic(v: bigint): string {
  return ('0x' + v.toString(16).padStart(64, '0')).toLowerCase();
}

/** Address recovered from a 32-byte left-padded topic (last 20 bytes). */
function topicToAddress(topic: string): string {
  return ('0x' + topic.slice(2).slice(-40)).toLowerCase();
}

// ---- identity (ERC-8004) ---------------------------------------------------

const OWNER_OF_ABI = [
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
] as const;

/**
 * ownerOf(agentId) on the ERC-8004 registry. The onchain source of truth:
 * a stale job_workers row can never claim, because every claim re-checks
 * this. Returns null on RPC failure (fail closed upstream).
 */
export type IdentityOwner = (
  agentId: bigint,
) => Promise<Address | null>;

export function defaultIdentityOwner(rpcUrl: string): IdentityOwner {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (agentId: bigint) => {
    try {
      return await client.readContract({
        address: IDENTITY_REGISTRY,
        abi: OWNER_OF_ABI,
        functionName: 'ownerOf',
        args: [agentId],
      });
    } catch {
      return null;
    }
  };
}

// ---- transactions (calldata verification) -----------------------------------

export interface TxLike {
  from: string;
  to: string | null;
  input: string;
}

export type GetTransaction = (txHash: Hex) => Promise<TxLike | null>;

export function defaultGetTransaction(rpcUrl: string): GetTransaction {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (txHash: Hex) => {
    try {
      const tx = await client.getTransaction({ hash: txHash });
      return { from: tx.from, to: tx.to, input: tx.input };
    } catch {
      return null;
    }
  };
}

export type Check = { ok: true } | { ok: false; reason: string };

function malformedTxHash(txHash: string): txHash is string {
  return !/^0x[0-9a-fA-F]{64}$/.test(txHash);
}

/**
 * Verify a createBounty funding: the receipt must show BOTH
 *   1. BountyCreated(jobId, payer=requester, amount >= bounty, deadline, termsHash)
 *      emitted by the escrow contract, AND
 *   2. Transfer(requester -> escrow, value >= bounty) on Ink USDC.
 * Returns the onchain jobId on success (it becomes escrow_job_id).
 */
export async function verifyBountyFunding(opts: {
  getReceipt: GetReceipt;
  txHash: string;
  escrow: Address;
  requester: Address;
  minUnits: bigint;
  expectedDeadline: bigint;
  expectedTermsHash: string;
}): Promise<Check & { jobId?: bigint }> {
  if (malformedTxHash(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const receipt = await opts.getReceipt(opts.txHash as Hex);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };

  const escrowLc = opts.escrow.toLowerCase();
  let jobId: bigint | null = null;
  // First mismatch reason, for a precise error when NOTHING fully matches.
  // Mismatched events are skipped (not fatal): one tx can carry several
  // BountyCreated events (e.g. a batched post), and a single underfunded
  // sibling must not veto the fully-matching one.
  let mismatchReason: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowLc) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== BOUNTY_CREATED_TOPIC.toLowerCase()) {
      continue;
    }
    const payer = topicToAddress(log.topics[2] as string);
    if (payer !== opts.requester.toLowerCase()) continue;
    let amount: bigint;
    let deadline: bigint;
    let termsHash: string;
    try {
      [amount, deadline, termsHash] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
        log.data as Hex,
      );
    } catch {
      continue;
    }
    if (amount < opts.minUnits) {
      mismatchReason ??= 'bounty_underfunded';
      continue;
    }
    if (deadline !== opts.expectedDeadline) {
      mismatchReason ??= 'deadline_mismatch';
      continue;
    }
    if (termsHash.toLowerCase() !== opts.expectedTermsHash.toLowerCase()) {
      mismatchReason ??= 'terms_hash_mismatch';
      continue;
    }
    jobId = BigInt(log.topics[1] as string);
    break;
  }
  if (jobId === null) {
    return { ok: false, reason: mismatchReason ?? 'no_bounty_created_event' };
  }

  // The event is emitted by the escrow; still require the USDC movement
  // itself (Transfer requester -> escrow >= bounty) — the blackjack buy-in
  // pattern. A funding tx without real funds must never list.
  const paid = await verifyTransferPayment({
    getReceipt: opts.getReceipt,
    txHash: opts.txHash,
    from: opts.requester,
    to: opts.escrow,
    minUnits: opts.minUnits,
  });
  if (!paid.ok) return { ok: false, reason: paid.reason };
  return { ok: true, jobId };
}

/**
 * Verify a claimBounty receipt: BountyClaimed(jobId, provider=worker,
 * agentId) emitted by the escrow contract, with all three indexed args
 * matching the claim.
 */
export async function verifyBountyClaimed(opts: {
  getReceipt: GetReceipt;
  txHash: string;
  escrow: Address;
  escrowJobId: bigint;
  worker: Address;
  agentId: bigint;
}): Promise<Check> {
  if (malformedTxHash(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const receipt = await opts.getReceipt(opts.txHash as Hex);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };

  const escrowLc = opts.escrow.toLowerCase();
  const jobTopic = uintTopic(opts.escrowJobId);
  const providerTopic = addressTopic(opts.worker);
  const agentTopic = uintTopic(opts.agentId);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowLc) continue;
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== BOUNTY_CLAIMED_TOPIC.toLowerCase()) {
      continue;
    }
    if (log.topics[1]?.toLowerCase() !== jobTopic) continue;
    if (log.topics[2]?.toLowerCase() !== providerTopic) continue;
    if (log.topics[3]?.toLowerCase() !== agentTopic) continue;
    return { ok: true };
  }
  return { ok: false, reason: 'no_bounty_claimed_event' };
}

/**
 * Verify a refund(uint256) receipt: JobRefunded(jobId) emitted by the
 * escrow contract. Unlike release/raiseDispute, refund DOES emit an event,
 * so logs — not calldata — are the binding.
 */
export async function verifyJobRefunded(opts: {
  getReceipt: GetReceipt;
  txHash: string;
  escrow: Address;
  escrowJobId: bigint;
}): Promise<Check> {
  if (malformedTxHash(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const receipt = await opts.getReceipt(opts.txHash as Hex);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };

  const escrowLc = opts.escrow.toLowerCase();
  const jobTopic = uintTopic(opts.escrowJobId);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowLc) continue;
    if (log.topics.length < 2) continue;
    if (log.topics[0]?.toLowerCase() !== JOB_REFUNDED_TOPIC.toLowerCase()) {
      continue;
    }
    if (log.topics[1]?.toLowerCase() !== jobTopic) continue;
    return { ok: true };
  }
  return { ok: false, reason: 'no_job_refunded_event' };
}

/**
 * Verify a resolveDispute(uint256,uint256) receipt:
 * DisputeResolved(jobId, providerAmount, payerAmount) emitted by the escrow
 * contract. Like refund, this one DOES emit an event.
 */
export async function verifyDisputeResolved(opts: {
  getReceipt: GetReceipt;
  txHash: string;
  escrow: Address;
  escrowJobId: bigint;
}): Promise<Check> {
  if (malformedTxHash(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const receipt = await opts.getReceipt(opts.txHash as Hex);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };

  const escrowLc = opts.escrow.toLowerCase();
  const jobTopic = uintTopic(opts.escrowJobId);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowLc) continue;
    if (log.topics.length < 2) continue;
    if (log.topics[0]?.toLowerCase() !== DISPUTE_RESOLVED_TOPIC.toLowerCase()) {
      continue;
    }
    if (log.topics[1]?.toLowerCase() !== jobTopic) continue;
    return { ok: true };
  }
  return { ok: false, reason: 'no_dispute_resolved_event' };
}

/**
 * Verify a release(uint256) / raiseDispute(uint256) call via tx calldata:
 * the tx must be FROM the expected signer, TO the escrow contract, carry
 * the right 4-byte selector, and pass the expected jobId as its only arg.
 * The receipt must also show success. (The v0 contract interface defines
 * no events for these calls, so calldata — not logs — is the binding.)
 */
export async function verifyEscrowCall(opts: {
  getReceipt: GetReceipt;
  getTransaction: GetTransaction;
  txHash: string;
  escrow: Address;
  from: Address;
  fn: 'release' | 'raiseDispute';
  escrowJobId: bigint;
}): Promise<Check> {
  if (malformedTxHash(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const [receipt, tx] = await Promise.all([
    opts.getReceipt(opts.txHash as Hex),
    opts.getTransaction(opts.txHash as Hex),
  ]);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };
  if (!tx) return { ok: false, reason: 'transaction_not_found' };
  if (tx.to?.toLowerCase() !== opts.escrow.toLowerCase()) {
    return { ok: false, reason: 'tx_not_to_escrow' };
  }
  if (tx.from.toLowerCase() !== opts.from.toLowerCase()) {
    return { ok: false, reason: 'tx_wrong_sender' };
  }
  const selector = opts.fn === 'release' ? RELEASE_SELECTOR : RAISE_DISPUTE_SELECTOR;
  const input = tx.input.toLowerCase();
  if (!input.startsWith(selector.toLowerCase())) {
    return { ok: false, reason: 'tx_wrong_function' };
  }
  let jobId: bigint;
  try {
    [jobId] = decodeAbiParameters(
      [{ type: 'uint256' }],
      ('0x' + input.slice(10)) as Hex,
    );
  } catch {
    return { ok: false, reason: 'tx_bad_calldata' };
  }
  if (jobId !== opts.escrowJobId) {
    return { ok: false, reason: 'tx_wrong_job' };
  }
  return { ok: true };
}

// ---- reputation resume (read-only) ------------------------------------------

export interface ReputationSummary {
  reliability: string;
  disputeRateBps: string;
  arbitrationWins: string;
  arbitrationLosses: string;
  totalEvents: string;
  lastEventTimestamp: number;
}

const SUMMARY_ABI = [
  {
    name: 'summary',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'reliability', type: 'uint256' },
      { name: 'disputeRateBps', type: 'uint256' },
      { name: 'arbitrationWins', type: 'uint256' },
      { name: 'arbitrationLosses', type: 'uint256' },
      { name: 'totalEvents', type: 'uint256' },
      { name: 'lastEventTimestamp', type: 'uint256' },
    ],
  },
] as const;

/**
 * summary(agentId) on the Four02ReputationRegistry. Read-only;
 * returns null on RPC failure so the resume endpoint degrades to the DB
 * history instead of 500ing.
 *
 * The registry address comes from config (FOUR02_REPUTATION_REGISTRY):
 * V1 (0x33E2c56035C059553a37a3A56199B5b5b3DA3365) is SUPERSEDED — switch
 * the env var to the V2 address after Four02ReputationRegistryV2 deploys.
 * No code change needed.
 */
export function defaultReputationSummary(
  rpcUrl: string,
  registry: Address = REPUTATION_REGISTRY,
): (agentId: bigint) => Promise<ReputationSummary | null> {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (agentId: bigint) => {
    try {
      const r = await client.readContract({
        address: registry,
        abi: SUMMARY_ABI,
        functionName: 'summary',
        args: [agentId],
      });
      return {
        reliability: r[0].toString(),
        disputeRateBps: r[1].toString(),
        arbitrationWins: r[2].toString(),
        arbitrationLosses: r[3].toString(),
        totalEvents: r[4].toString(),
        lastEventTimestamp: Number(r[5]),
      };
    } catch {
      return null;
    }
  };
}
