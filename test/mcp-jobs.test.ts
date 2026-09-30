/**
 * 402 MCP jobs_* tools tests.
 *
 *   npx tsx test/mcp-jobs.test.ts
 *
 * Spins createJobsApp with a mocked chain layer on an ephemeral port, then
 * drives the MCP server in-process via InMemoryTransport. Throwaway keys
 * generated in-process; nothing is broadcast, no real funds.
 *
 * Walks the full worker journey through the tools: board -> enroll ->
 * claim (plan + mirror) -> submit -> withdraw, plus status/history.
 */
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseUnits,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { USDC_ADDRESS } from '../src/constants.js';
import { loadJobsConfig } from '../src/jobs/config.js';
import { JobsDb } from '../src/jobs/db.js';
import {
  BOUNTY_CLAIMED_TOPIC,
  BOUNTY_CREATED_TOPIC,
  type GetOnchainJob,
  type OnchainJob,
} from '../src/jobs/escrow.js';
import { createJobsApp } from '../src/jobs/server.js';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import type { GetReceipt, ReceiptLike } from '../src/lounge/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { decodeWorkerCalldata } from '../src/jobs/worker.js';

// ---- throwaway test keys (in-process only, never funded, never broadcast) ----
const requester = privateKeyToAccount(generatePrivateKey());
const worker = privateKeyToAccount(generatePrivateKey());
const escrowAddr = getAddress('0x00000000000000000000000000000000000000e5');
const AGENT_ID = 7n;
const ESCROW_JOB_ID = 11n;
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- mocked chain layer ----
const receipts = new Map<string, ReceiptLike>();
const owners = new Map<string, Address>(); // agentId -> owner
const onchainJobs = new Map<string, OnchainJob>();
const getReceipt: GetReceipt = async (h: Hex) => receipts.get(h.toLowerCase()) ?? null;
const getOnchainJob: GetOnchainJob = async (_escrow, id) =>
  onchainJobs.get(id.toString()) ?? null;
owners.set(AGENT_ID.toString(), worker.address);

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const addrTopic = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')).toLowerCase();
const uintTopic = (v: bigint) => ('0x' + v.toString(16).padStart(64, '0')).toLowerCase();

function bountyCreatedLog(jobId: bigint, payer: string, amount: bigint, deadline: bigint, termsHash: string) {
  return {
    address: escrowAddr,
    topics: [BOUNTY_CREATED_TOPIC, uintTopic(jobId), addrTopic(payer)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }],
      [amount, deadline, termsHash as Hex],
    ),
  };
}

function bountyClaimedLog(jobId: bigint, provider: string, agentId: bigint) {
  return {
    address: escrowAddr,
    topics: [BOUNTY_CLAIMED_TOPIC, uintTopic(jobId), addrTopic(provider), uintTopic(agentId)],
    data: '0x',
  };
}

const cfg = loadJobsConfig({
  FOUR02_BOUNTY_ESCROW: escrowAddr,
  FOUR02_JOBS_DB_PATH: ':memory:',
  // Deployed V2 (avoids the superseded-V1 warning; reputationSummary is mocked anyway).
  FOUR02_REPUTATION_REGISTRY: '0x4fa146388ce351b2af71aa6841146c91a2f27494',
  INK_RPC_URL: 'http://localhost:1', // dead localhost: never called, mocks injected
  JOBS_DAILY_POST_CAP: '10000',
});
assert.ok(cfg);

const parent = new Hono();
parent.route(
  '/jobs',
  createJobsApp(cfg, {
    db: new JobsDb(':memory:'),
    getReceipt,
    getOnchainJob,
    identityOwner: async (agentId) => owners.get(agentId.toString()) ?? null,
    reputationSummary: async () => ({
      reliability: '100',
      disputeRateBps: '0',
      arbitrationWins: '0',
      arbitrationLosses: '0',
      totalEvents: '1',
      lastEventTimestamp: nowSec(),
    }),
    rateLimitBucket: { windowMs: 60_000, max: 10_000 },
  }),
);

const listener = serve({ fetch: parent.fetch, port: 0 });
await new Promise<void>((resolve) => listener.addListener('listening', resolve));
const addr = listener.address();
if (!addr || typeof addr === 'string') throw new Error('no listener address');
const jobsBase = `http://127.0.0.1:${addr.port}/jobs`;

const mcpServer = createMcpServer({
  facilitatorUrl: jobsBase,
  loungeUrl: jobsBase,
  jobsUrl: jobsBase,
  inkRpcUrl: 'http://localhost:1',
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test-client', version: '0.0.0' });
await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function toolText(res: unknown): Record<string, unknown> {
  const r = res as { content: { type: string; text: string }[] };
  assert.equal(r.content[0].type, 'text');
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>) {
  return toolText(await client.callTool({ name, arguments: args }));
}

function txHash(seed: string): Hex {
  return keccak256(toHex(`mcp-jobs-test-${seed}`));
}

async function sign(
  account: ReturnType<typeof privateKeyToAccount>,
  primaryType: 'JobEnroll' | 'JobPost' | 'JobClaim' | 'JobSubmit',
  message: Record<string, unknown>,
): Promise<Hex> {
  return account.signTypedData({
    domain: LOUNGE_DOMAIN,
    types: LOUNGE_TYPES,
    primaryType,
    message: message as never,
  });
}

// ---- fixtures ----

const spec = 'Write a 500-word explainer on x402 micropayments.';
const termsHash = keccak256(toHex(spec)).toLowerCase() as Hex;
const deadline = 1893456000;

async function postFixtureJob(): Promise<number> {
  const timestamp = nowSec();
  const signature = await sign(requester, 'JobPost', {
    requester: requester.address,
    title: 'Explainer post',
    spec,
    specPrivate: false,
    category: 'writing',
    bountyUsdc: '25.00',
    deadline: BigInt(deadline),
    termsHash,
    timestamp: BigInt(timestamp),
  });
  const h = txHash('post');
  receipts.set(h.toLowerCase(), {
    status: 'success',
    logs: [
      {
        address: USDC_ADDRESS,
        topics: [TRANSFER_TOPIC, addrTopic(requester.address), addrTopic(escrowAddr)],
        data: `0x${parseUnits('25.00', 6).toString(16).padStart(64, '0')}`,
      },
      bountyCreatedLog(ESCROW_JOB_ID, requester.address, parseUnits('25.00', 6), BigInt(deadline), termsHash),
    ],
  });
  const res = await parent.request('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requester: requester.address,
      title: 'Explainer post',
      spec,
      category: 'writing',
      bountyUsdc: '25.00',
      deadline: deadline.toString(),
      termsHash,
      timestamp,
      signature,
      txHash: h,
    }),
  });
  if (res.status !== 201) assert.fail(`POST /jobs failed: ${await res.text()}`);
  const body = (await res.json()) as { jobId: number };
  return body.jobId;
}

const jobId = await postFixtureJob();

// ---- the tests ----

await check('lists all 18 tools including the eight jobs_* tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'facilitator_supported',
    'facilitator_verify',
    'invoice_create',
    'invoice_status',
    'jobs_board',
    'jobs_claim',
    'jobs_enroll',
    'jobs_post',
    'jobs_review',
    'jobs_status',
    'jobs_submit',
    'jobs_withdraw',
    'lounge_feed',
    'lounge_post',
    'oracle_gas',
    'oracle_price',
    'wallet_create',
    'wallet_verify_backup',
  ]);
});

await check('jobs_board lists the open job', async () => {
  const out = await callTool('jobs_board', { status: 'open', limit: 20 });
  assert.ok(Array.isArray(out.jobs));
  const found = (out.jobs as Record<string, unknown>[]).find((j) => j.id === jobId);
  assert.ok(found, 'fixture job missing from board');
  assert.equal(found.state, 'open');
  assert.equal(found.escrowJobId, ESCROW_JOB_ID.toString());
});

await check('jobs_board category filter', async () => {
  const out = await callTool('jobs_board', { status: 'open', category: 'code', limit: 20 });
  assert.deepEqual(out.jobs, []);
});

await check('jobs_enroll enrolls the worker wallet', async () => {
  const timestamp = nowSec();
  const signature = await sign(worker, 'JobEnroll', {
    wallet: worker.address,
    agentId: AGENT_ID,
    timestamp: BigInt(timestamp),
  });
  const out = await callTool('jobs_enroll', {
    worker: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp,
    signature,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.enrolled, true);
});

await check('jobs_enroll rejects a bad signature', async () => {
  const out = await callTool('jobs_enroll', {
    worker: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp: nowSec(),
    signature: `0x${'11'.repeat(65)}`,
  });
  assert.equal(out.ok, false);
});

await check('jobs_claim plan mode returns exact onchain calls', async () => {
  const out = await callTool('jobs_claim', { jobId, agentId: AGENT_ID.toString() });
  assert.equal(out.ok, true);
  assert.equal(out.phase, 'onchain');
  const calls = out.calls as { to: string; data: Hex; purpose: string }[];
  assert.equal(calls.length, 2);
  const approve = decodeWorkerCalldata(calls[0].data);
  assert.equal(approve.functionName, 'approve');
  assert.deepEqual(approve.args, [getAddress('0xdf319a060eaa361aa906855c64ccbc941159c01c'), 1_000_000n]);
  const claim = decodeWorkerCalldata(calls[1].data);
  assert.equal(claim.functionName, 'claimBounty');
  assert.deepEqual(claim.args, [ESCROW_JOB_ID, AGENT_ID]);
});

await check('jobs_claim plan mode rejects without agentId', async () => {
  const out = await callTool('jobs_claim', { jobId });
  assert.equal(out.ok, false);
});

await check('jobs_claim submit mode mirrors the onchain claim', async () => {
  const h = txHash('claim');
  receipts.set(
    h.toLowerCase(),
    { status: 'success', logs: [bountyClaimedLog(ESCROW_JOB_ID, worker.address, AGENT_ID)] },
  );
  const timestamp = nowSec();
  const signature = await sign(worker, 'JobClaim', {
    jobId: BigInt(jobId),
    worker: worker.address,
    agentId: AGENT_ID,
    timestamp: BigInt(timestamp),
  });
  const out = await callTool('jobs_claim', {
    jobId,
    worker: worker.address,
    agentId: AGENT_ID.toString(),
    timestamp,
    signature,
    txHash: h,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.state, 'claimed');
});

await check('jobs_submit mirrors the submission + returns confirmDelivery calldata', async () => {
  const contentHash = keccak256(toHex('deliverable bytes'));
  const timestamp = nowSec();
  const signature = await sign(worker, 'JobSubmit', {
    jobId: BigInt(jobId),
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafywork',
    timestamp: BigInt(timestamp),
  });
  const out = await callTool('jobs_submit', {
    jobId,
    author: worker.address,
    contentHash,
    uri: 'ipfs://bafywork',
    timestamp,
    signature,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const next = out.next as { to: string; data: Hex };
  assert.ok(next);
  const decoded = decodeWorkerCalldata(next.data);
  assert.equal(decoded.functionName, 'confirmDelivery');
  assert.deepEqual(decoded.args, [ESCROW_JOB_ID]);
});

await check('jobs_withdraw reports not-ready before release', async () => {
  const out = await callTool('jobs_withdraw', { jobId });
  assert.equal(out.ok, true);
  assert.equal(out.ready, false);
  assert.equal(out.state, 'submitted');
});

await check('jobs_withdraw returns claim() calldata after release', async () => {
  onchainJobs.set(ESCROW_JOB_ID.toString(), {
    payer: requester.address,
    provider: worker.address,
    agentId: AGENT_ID,
    amount: parseUnits('25.00', 6),
    deadline: BigInt(deadline),
    termsHash,
    state: 4, // Released
  });
  const syncRes = await parent.request(`/jobs/${jobId}/sync`, { method: 'POST' });
  assert.equal(syncRes.status, 200);
  const out = await callTool('jobs_withdraw', { jobId });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.ready, true);
  assert.equal(out.state, 'complete');
  const call = out.call as { to: string; data: Hex };
  const decoded = decodeWorkerCalldata(call.data);
  assert.equal(decoded.functionName, 'claim');
  assert.deepEqual(decoded.args, [ESCROW_JOB_ID]);
  assert.equal(call.to.toLowerCase(), '0xdf319a060eaa361aa906855c64ccbc941159c01c');
});

await check('jobs_status returns the job and worker history', async () => {
  const out = await callTool('jobs_status', {
    jobId,
    agentId: AGENT_ID.toString(),
  });
  assert.equal(out.ok, true);
  const job = (out.job as { job: Record<string, unknown> }).job;
  assert.equal(job.id, jobId);
  assert.equal(job.state, 'complete');
  assert.ok(out.history);
});

await check('jobs_post plan mode returns exact onchain calls', async () => {
  const spec2 = 'Agent-posted: build a small Ink CLI helper.';
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Agent CLI helper',
    spec: spec2,
    category: 'code',
    bountyUsdc: '3.50',
    durationHours: 48,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.phase, 'onchain');
  assert.equal(out.bountyUnits, '3500000');
  const expectedTerms = keccak256(toHex(spec2));
  assert.equal(out.termsHash, expectedTerms);
  const dl = out.deadline as number;
  const drift = Math.abs(dl - (nowSec() + 48 * 3600));
  assert.ok(drift < 120, `deadline drift too large: ${drift}`);
  const calls = out.calls as { to: string; data: Hex; purpose: string }[];
  assert.equal(calls.length, 2);
  const approve = decodeWorkerCalldata(calls[0].data);
  assert.equal(approve.functionName, 'approve');
  assert.deepEqual(approve.args, [
    getAddress('0xdf319a060eaa361aa906855c64ccbc941159c01c'),
    3_500_000n,
  ]);
  assert.equal(calls[0].to.toLowerCase(), USDC_ADDRESS.toLowerCase());
  const create = decodeWorkerCalldata(calls[1].data);
  assert.equal(create.functionName, 'createBounty');
  assert.deepEqual(create.args, [3_500_000n, BigInt(dl), expectedTerms]);
  assert.equal(calls[1].to.toLowerCase(), '0xdf319a060eaa361aa906855c64ccbc941159c01c');
  const typed = out.typedData as {
    domain: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  assert.equal(typed.primaryType, 'JobPost');
  assert.equal(typed.domain.name, '402 Lounge');
  assert.equal(typed.message.title, 'Agent CLI helper');
  assert.equal(typed.message.spec, spec2);
  assert.equal(typed.message.specPrivate, false);
  assert.equal(typed.message.bountyUsdc, '3.50');
  assert.equal(typed.message.termsHash, expectedTerms);
});

await check('jobs_post plan rejects security-audit', async () => {
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Audit me',
    spec: 'audit this contract',
    category: 'security-audit',
    bountyUsdc: '10',
    durationHours: 24,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'category_rejected');
});

await check('jobs_post plan rejects unknown category', async () => {
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Nope',
    spec: 'spec',
    category: 'consulting',
    bountyUsdc: '10',
    durationHours: 24,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_category');
});

await check('jobs_post plan rejects bad bounties', async () => {
  for (const bountyUsdc of ['0', '0.00', '5.1234567', 'abc']) {
    const out = await callTool('jobs_post', {
      requester: requester.address,
      title: 'Bad bounty',
      spec: 'spec',
      category: 'code',
      bountyUsdc,
      durationHours: 24,
    });
    assert.equal(out.ok, false, `bounty ${bountyUsdc} should fail`);
    assert.equal(out.error, 'invalid_bounty');
  }
});

await check('jobs_post plan rejects past deadline and missing deadline', async () => {
  const past = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Past',
    spec: 'spec',
    category: 'code',
    bountyUsdc: '5',
    deadline: nowSec() - 10,
  });
  assert.equal(past.ok, false);
  assert.equal(past.error, 'invalid_deadline');
  const missing = await callTool('jobs_post', {
    requester: requester.address,
    title: 'No deadline',
    spec: 'spec',
    category: 'code',
    bountyUsdc: '5',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing_deadline');
});

await check('jobs_post plan rejects empty title', async () => {
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: '',
    spec: 'spec',
    category: 'code',
    bountyUsdc: '5',
    durationHours: 24,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_title');
});

const AGENT_POST_SPEC = 'Agent-posted round trip: write a README section.';
const AGENT_POST_DEADLINE = nowSec() + 7200;
const AGENT_POST_TERMS = keccak256(toHex(AGENT_POST_SPEC));
const AGENT_POST_ESCROW_ID = 12n;

await check('jobs_post mirror mode posts the funded bounty', async () => {
  const timestamp = nowSec();
  const signature = await sign(requester, 'JobPost', {
    requester: requester.address,
    title: 'Agent README',
    spec: AGENT_POST_SPEC,
    specPrivate: false,
    category: 'writing',
    bountyUsdc: '3.50',
    deadline: BigInt(AGENT_POST_DEADLINE),
    termsHash: AGENT_POST_TERMS,
    timestamp: BigInt(timestamp),
  });
  const h = txHash('agent-post');
  receipts.set(h.toLowerCase(), {
    status: 'success',
    logs: [
      {
        address: USDC_ADDRESS,
        topics: [TRANSFER_TOPIC, addrTopic(requester.address), addrTopic(escrowAddr)],
        data: `0x${parseUnits('3.50', 6).toString(16).padStart(64, '0')}`,
      },
      bountyCreatedLog(
        AGENT_POST_ESCROW_ID,
        requester.address,
        parseUnits('3.50', 6),
        BigInt(AGENT_POST_DEADLINE),
        AGENT_POST_TERMS,
      ),
    ],
  });
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Agent README',
    spec: AGENT_POST_SPEC,
    category: 'writing',
    bountyUsdc: '3.50',
    deadline: AGENT_POST_DEADLINE,
    termsHash: AGENT_POST_TERMS,
    timestamp,
    signature,
    txHash: h,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(typeof out.jobId, 'number');
  const board = await callTool('jobs_board', { status: 'open', limit: 50 });
  const found = (board.jobs as Record<string, unknown>[]).find((j) => j.id === out.jobId);
  assert.ok(found, 'agent-posted job missing from board');
  assert.equal(found.title, 'Agent README');
  assert.equal(found.escrowJobId, AGENT_POST_ESCROW_ID.toString());
});

await check('jobs_post mirror rejects a bad signature', async () => {
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Agent README',
    spec: AGENT_POST_SPEC,
    category: 'writing',
    bountyUsdc: '3.50',
    deadline: AGENT_POST_DEADLINE,
    termsHash: AGENT_POST_TERMS,
    timestamp: nowSec(),
    signature: `0x${'22'.repeat(65)}`,
    txHash: txHash('agent-post-badsig'),
  });
  assert.equal(out.ok, false);
});

await check('jobs_post mirror rejects termsHash mismatch', async () => {
  const timestamp = nowSec();
  const signature = await sign(requester, 'JobPost', {
    requester: requester.address,
    title: 'Agent README',
    spec: AGENT_POST_SPEC,
    specPrivate: false,
    category: 'writing',
    bountyUsdc: '3.50',
    deadline: BigInt(AGENT_POST_DEADLINE),
    termsHash: AGENT_POST_TERMS,
    timestamp: BigInt(timestamp),
  });
  const out = await callTool('jobs_post', {
    requester: requester.address,
    title: 'Agent README',
    spec: AGENT_POST_SPEC,
    category: 'writing',
    bountyUsdc: '3.50',
    deadline: AGENT_POST_DEADLINE,
    termsHash: `0x${'33'.repeat(32)}`,
    timestamp,
    signature,
    txHash: txHash('agent-post-badhash'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'terms_hash_mismatch');
});

listener.close();

console.log(`\n${passed} MCP jobs tool checks passed.`);
