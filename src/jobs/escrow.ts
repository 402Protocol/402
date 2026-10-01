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
 *              JobReleased(uint256 indexed jobId, uint256 providerAmount,
 *                          uint256 feeAmount)
 *              DisputeRaised(uint256 indexed jobId, address indexed raiser)
 *              JobRefunded(uint256 indexed jobId)
 *              DisputeResolved(uint256 indexed jobId, uint256 providerAmount,
 *                              uint256 payerAmount)
 *
 * Money-moving mirrors verify the ESCROW-EMITTED EVENT on a successful
 * receipt — never tx calldata + tx.from. The event can only exist if the
 * contract's own checks passed (release: msg.sender == payer, state ==
 * Delivered; raiseDispute: caller is a party, state Funded/Delivered).
 * Event-based verification also keeps the mirrors working for
 * smart-wallet / multisig parties, where the outer tx.from is an EOA
 * submitter rather than the contract's msg.sender.
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

/** keccak256("JobReleased(uint256,uint256,uint256)") */
export const JOB_RELEASED_TOPIC = keccak256(
  toHex('JobReleased(uint256,uint256,uint256)'),
);

/** keccak256("DisputeRaised(uint256,address)") */
export const DISPUTE_RAISED_TOPIC = keccak256(
  toHex('DisputeRaised(uint256,address)'),
);

/** keccak256("JobRefunded(uint256)") */
export const JOB_REFUNDED_TOPIC = keccak256(toHex('JobRefunded(uint256)'));

/** keccak256("DisputeResolved(uint256,uint256,uint256)") */
export const DISPUTE_RESOLVED_TOPIC = keccak256(
  toHex('DisputeResolved(uint256,uint256,uint256)'),
);

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

// ---- TRACES seat pairing (ERC-8004 license) --------------------------------
// The TRACES seat contract pairs each seat NFT 1:1 with an ERC-8004 agent
// identity (seatToAgent / agentToSeat), auto-clearing the pairing on seat
// transfer. The marketplace's seat gate verifies, at assignment AND at
// payout, that:
//   1. agentToSeat(agentId) returns a nonzero seat,
//   2. seatToAgent(seatId) points back to the same agent,
//   3. the same wallet owns BOTH the seat (ownerOf) and the agent
//      (registry ownerOf),
//   4. either ownerOf reverting (nonexistent token) is ineligible.
// Never rely solely on agentToSeat(agentId) != 0 — the reverse mapping must
// agree and the wallet must own both sides.

const SEAT_PAIRING_ABI = [
  {
    name: 'seatToAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'agentToSeat',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: 'seatId', type: 'uint256' }],
  },
  ...OWNER_OF_ABI,
] as const;

export type SeatPairingCheck =
  | { ok: true }
  | { ok: false; reason: 'agent_not_paired' | 'pairing_mismatch' | 'seat_wallet_mismatch' | 'seat_check_unavailable' };

/**
 * Live TRACES seat-pairing verification. All four reads run in one
 * Promise.all; the two mapping reads never revert (mappings return 0 for
 * unknown keys), so a nonexistent seat/agent surfaces as a pairing
 * mismatch, not an exception. Any throw (RPC down, unexpected revert)
 * returns seat_check_unavailable — fail closed upstream (503).
 */
export type VerifySeatPairing = (
  seatId: bigint,
  agentId: bigint,
  wallet: Address,
) => Promise<SeatPairingCheck>;

export function defaultVerifySeatPairing(
  rpcUrl: string,
  seatContract: Address,
): VerifySeatPairing {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (seatId, agentId, wallet) => {
    try {
      const [pairedAgent, pairedSeat, seatOwner, agentOwner] =
        await Promise.all([
          client.readContract({
            address: seatContract,
            abi: SEAT_PAIRING_ABI,
            functionName: 'seatToAgent',
            args: [seatId],
          }),
          client.readContract({
            address: seatContract,
            abi: SEAT_PAIRING_ABI,
            functionName: 'agentToSeat',
            args: [agentId],
          }),
          client.readContract({
            address: seatContract,
            abi: SEAT_PAIRING_ABI,
            functionName: 'ownerOf',
            args: [seatId],
          }),
          client.readContract({
            address: IDENTITY_REGISTRY,
            abi: OWNER_OF_ABI,
            functionName: 'ownerOf',
            args: [agentId],
          }),
        ]);
      // 1. The agent must be paired to a nonzero seat.
      if (pairedSeat === 0n) return { ok: false, reason: 'agent_not_paired' };
      // 2. The reverse mapping must agree (catches stale one-sided rows).
      if (pairedAgent !== agentId || pairedSeat !== seatId) {
        return { ok: false, reason: 'pairing_mismatch' };
      }
      // 3. The same wallet must own both the seat and the agent.
      // (ownerOf reverts on nonexistent tokens — but a pairing can only
      // exist for live tokens, so reaching the ownerOf calls with a
      // consistent pairing means both tokens exist.)
      if (
        seatOwner.toLowerCase() !== wallet.toLowerCase() ||
        agentOwner.toLowerCase() !== wallet.toLowerCase()
      ) {
        return { ok: false, reason: 'seat_wallet_mismatch' };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'seat_check_unavailable' };
    }
  };
}

/**
 * Resolve an agent's TRACES seat token id from the onchain registry's
 * agentToSeat mapping. Used by the public Agents directory to show each
 * worker's seat NFT (the seat lives in the owner's wallet, not the worker
 * wallet — the link is the registry pairing, same read the seat gate
 * uses). Fail-soft by design: any failure (RPC down, bad agent id, no
 * pairing) returns null instead of throwing — a public directory must
 * never 503 because a thumbnail lookup failed. Read live, never from DB.
 */
export type ResolveAgentSeat = (agentId: string) => Promise<string | null>;

export function defaultResolveAgentSeat(
  rpcUrl: string,
  seatContract: Address,
): ResolveAgentSeat {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (agentId: string) => {
    try {
      const seat: bigint = await client.readContract({
        address: seatContract,
        abi: SEAT_PAIRING_ABI,
        functionName: 'agentToSeat',
        args: [BigInt(agentId)],
      });
      return seat === 0n ? null : seat.toString();
    } catch {
      return null;
    }
  };
}

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

// ---- onchain job reads (reconciliation) -------------------------------------

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
 * Verify a release(uint256) receipt: JobReleased(jobId, providerAmount,
 * feeAmount) emitted by the escrow contract. The event is the binding —
 * only release() emits it, and release() reverts unless msg.sender is the
 * payer and the job is Delivered. No tx.from check: a multisig payer's
 * outer tx.from is an EOA submitter, not the contract's msg.sender, and
 * the event already proves the contract's own checks passed.
 */
export async function verifyRelease(opts: {
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
    if (log.topics[0]?.toLowerCase() !== JOB_RELEASED_TOPIC.toLowerCase()) {
      continue;
    }
    if (log.topics[1]?.toLowerCase() !== jobTopic) continue;
    return { ok: true };
  }
  return { ok: false, reason: 'no_job_released_event' };
}

/**
 * Verify a raiseDispute(uint256) receipt: DisputeRaised(jobId, raiser)
 * emitted by the escrow contract, with the raiser matching the disputing
 * party. Like release, the event is the binding — only raiseDispute()
 * emits it, and it reverts unless the caller is payer or provider and the
 * job is Funded/Delivered. The raiser topic (not tx.from) is checked so
 * multisig parties verify the same way EOAs do.
 */
export async function verifyDisputeRaised(opts: {
  getReceipt: GetReceipt;
  txHash: string;
  escrow: Address;
  escrowJobId: bigint;
  raiser: Address;
}): Promise<Check> {
  if (malformedTxHash(opts.txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  const receipt = await opts.getReceipt(opts.txHash as Hex);
  if (!receipt) return { ok: false, reason: 'receipt_not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_failed' };

  const escrowLc = opts.escrow.toLowerCase();
  const jobTopic = uintTopic(opts.escrowJobId);
  const raiserTopic = addressTopic(opts.raiser);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowLc) continue;
    if (log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== DISPUTE_RAISED_TOPIC.toLowerCase()) {
      continue;
    }
    if (log.topics[1]?.toLowerCase() !== jobTopic) continue;
    if (log.topics[2]?.toLowerCase() !== raiserTopic) continue;
    return { ok: true };
  }
  return { ok: false, reason: 'no_dispute_raised_event' };
}

// ---- onchain job reads (reconciliation) -------------------------------------

/** BountyEscrow.JobState as returned by getJob: 0=None..7=Refunded. */
export const ONCHAIN_JOB_STATES = [
  'none',
  'open',
  'funded',
  'delivered',
  'released',
  'disputed',
  'resolved',
  'refunded',
] as const;

const GET_JOB_ABI = [
  {
    name: 'getJob',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'payer', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'agentId', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'deadline', type: 'uint64' },
          { name: 'termsHash', type: 'bytes32' },
          { name: 'state', type: 'uint8' },
        ],
      },
    ],
  },
] as const;

export interface OnchainJob {
  payer: Address;
  provider: Address;
  agentId: bigint;
  amount: bigint;
  deadline: bigint;
  termsHash: Hex;
  /** 0=None, 1=Open, 2=Funded, 3=Delivered, 4=Released, 5=Disputed, 6=Resolved, 7=Refunded. */
  state: number;
}

/**
 * getJob(escrowJobId) on the BountyEscrow contract — the reconciliation
 * source of truth for POST /jobs/:id/sync. Returns null when the job does
 * not exist (UnknownJob revert) or the RPC is unreachable: fail closed
 * upstream, never guess.
 */
export type GetOnchainJob = (
  escrow: Address,
  escrowJobId: bigint,
) => Promise<OnchainJob | null>;

export function defaultGetOnchainJob(rpcUrl: string): GetOnchainJob {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (escrow, escrowJobId) => {
    try {
      const job = await client.readContract({
        address: escrow,
        abi: GET_JOB_ABI,
        functionName: 'getJob',
        args: [escrowJobId],
      });
      return {
        payer: job.payer,
        provider: job.provider,
        agentId: job.agentId,
        amount: job.amount,
        deadline: job.deadline,
        termsHash: job.termsHash,
        state: Number(job.state),
      };
    } catch {
      return null;
    }
  };
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

const PANEL_COUNT_ABI = [
  {
    name: 'getLastIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
] as const;

/**
 * Per-writer panel-event count for an agent: registry.getLastIndex on the
 * PanelBatchWriter address. Read-only; returns null on RPC failure.
 *
 * Why this exists: panel scores are recorded as EscrowCompleted, so
 * summary().totalEvents mixes advisory panel snapshots with real commerce.
 * The worker-history endpoint reports this count separately so consumers
 * can tell the two apart instead of reading totalEvents as "jobs done".
 * Only meaningful once the writer is deployed and FOUR02_PANEL_WRITER is
 * set; the caller omits the field when this returns null.
 */
export function defaultPanelEventCount(
  rpcUrl: string,
  registry: Address,
  panelWriter: Address,
): (agentId: bigint) => Promise<string | null> {
  const client = createPublicClient({ chain: ink, transport: http(rpcUrl) });
  return async (agentId: bigint) => {
    try {
      const n = await client.readContract({
        address: registry,
        abi: PANEL_COUNT_ABI,
        functionName: 'getLastIndex',
        args: [agentId, panelWriter],
      });
      return n.toString();
    } catch {
      return null;
    }
  };
}
