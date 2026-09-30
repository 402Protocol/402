/**
 * 402 Job Marketplace — worker loop orchestration tests.
 *
 *   npx tsx test/worker-loop.test.ts
 *
 * Drives src/jobs/worker-loop.ts with a mocked API (fetch), mocked signing
 * and broadcasting hooks, and a scripted work hook. No network, no keys
 * beyond throwaways generated in-process.
 */
import assert from 'node:assert/strict';
import { type Address, type Hex, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  BOUNTY_ESCROW_ADDRESS,
  decodeWorkerCalldata,
  type SignedJobMessage,
  type WorkerJobListing,
} from '../src/jobs/worker.js';
import {
  type WorkerEvent,
  type WorkerLoopConfig,
  awaitRelease,
  claimJob,
  fetchJob,
  fetchOpenJobs,
  runWorkerLoop,
  submitJob,
  withdrawJob,
} from '../src/jobs/worker-loop.js';

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

const workerAcct = privateKeyToAccount(generatePrivateKey());
const worker = workerAcct.address;
const agentId = 7n;
const ESCROW = getAddress(BOUNTY_ESCROW_ADDRESS);

const jobListing: WorkerJobListing = {
  id: 1,
  escrowJobId: '42',
  title: 'Explainer post',
  category: 'writing',
  bountyUsdc: '25.00',
  state: 'open',
  deadline: 1893456000,
};

/** Scriptable fake API: mutable job state + a log of POST bodies. */
function makeFakeApi(initialState = 'open') {
  let jobState = initialState;
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (method === 'GET' && u.includes('/jobs?')) {
      // The board only lists open jobs; keep offering the open listing even
      // while the in-flight job moves through its states.
      return Response.json({ jobs: [{ ...jobListing, state: 'open' }] });
    }
    if (method === 'GET' && u.endsWith('/jobs/1')) {
      return Response.json({ job: { ...jobListing, state: jobState } });
    }
    if (method === 'POST') {
      posts.push({ path: u, body });
      if (u.endsWith('/jobs/1/claim')) {
        jobState = 'claimed';
        return Response.json({ state: 'claimed', jobId: 1 });
      }
      if (u.endsWith('/jobs/1/submit')) {
        jobState = 'submitted';
        return Response.json({ state: 'submitted', jobId: 1 });
      }
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    posts,
    get state() {
      return jobState;
    },
    set state(s: string) {
      jobState = s;
    },
  };
}

function makeHooks(events: WorkerEvent[] = []) {
  const sent: { to: Address; data: Hex }[] = [];
  const cfg = (api: { fetchImpl: typeof fetch }): WorkerLoopConfig => ({
    apiBase: 'https://api.example',
    worker,
    agentId,
    pollIntervalMs: 5,
    releaseTimeoutMs: 500,
    fetchImpl: api.fetchImpl,
    sign: async (primaryType, _message): Promise<SignedJobMessage> => ({
      author: worker,
      timestamp: Math.floor(Date.now() / 1000),
      signature: `0x${primaryType}sig`.padEnd(132, '0') as Hex,
    }),
    sendTransaction: async (to, data) => {
      sent.push({ to, data });
      return `0x${String(sent.length).padStart(64, '0')}` as Hex;
    },
    doWork: async () => ({
      contentHash: ('0x' + 'ab'.repeat(32)) as Hex,
      uri: 'ipfs://bafywork',
    }),
    onEvent: (e) => events.push(e),
  });
  return { cfg, sent };
}

await check('fetchOpenJobs parses the board', async () => {
  const api = makeFakeApi();
  const jobs = await fetchOpenJobs({ apiBase: 'https://api.example', fetchImpl: api.fetchImpl });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].escrowJobId, '42');
});

await check('claimJob: approve-then-claimBounty in order, API mirrored, event emitted', async () => {
  const api = makeFakeApi();
  const events: WorkerEvent[] = [];
  const { cfg, sent } = makeHooks(events);
  const { approveTxHash, claimTxHash } = await claimJob(cfg(api), jobListing);
  assert.ok(approveTxHash);
  assert.ok(claimTxHash);
  // onchain order: approve first, claimBounty second
  assert.equal(sent.length, 2);
  assert.equal(decodeWorkerCalldata(sent[0].data).functionName, 'approve');
  assert.deepEqual(decodeWorkerCalldata(sent[0].data).args, [ESCROW, 1_000_000n]);
  assert.equal(decodeWorkerCalldata(sent[1].data).functionName, 'claimBounty');
  assert.deepEqual(decodeWorkerCalldata(sent[1].data).args, [42n, 7n]);
  // API mirror carried the claim tx hash + signature
  const claimPost = api.posts.find((p) => p.path.endsWith('/jobs/1/claim'));
  assert.ok(claimPost);
  assert.equal(claimPost.body.txHash, claimTxHash);
  assert.equal(claimPost.body.agentId, '7');
  assert.equal(events.at(-1)?.kind, 'claimed');
});

await check('claimJob throws when the API rejects the mirror', async () => {
  const fetchImpl = (async () => new Response('conflict', { status: 409 })) as typeof fetch;
  const { cfg } = makeHooks();
  await assert.rejects(() => claimJob(cfg({ fetchImpl }), jobListing), /claim rejected/);
});

await check('submitJob: API mirror then confirmDelivery onchain', async () => {
  const api = makeFakeApi('claimed');
  const events: WorkerEvent[] = [];
  const { cfg, sent } = makeHooks(events);
  const { deliveryTxHash } = await submitJob(cfg(api), jobListing, {
    contentHash: ('0x' + 'cd'.repeat(32)) as Hex,
    uri: 'ipfs://bafywork',
  });
  assert.ok(deliveryTxHash);
  const submitPost = api.posts.find((p) => p.path.endsWith('/jobs/1/submit'));
  assert.ok(submitPost);
  assert.equal(submitPost.body.uri, 'ipfs://bafywork');
  assert.equal(sent.length, 1);
  assert.equal(decodeWorkerCalldata(sent[0].data).functionName, 'confirmDelivery');
  assert.deepEqual(decodeWorkerCalldata(sent[0].data).args, [42n]);
  assert.equal(events.at(-1)?.kind, 'submitted');
});

await check('awaitRelease: waits for complete, throws on disputed/refunded', async () => {
  const api = makeFakeApi('submitted');
  const { cfg } = makeHooks();
  setTimeout(() => {
    api.state = 'complete';
  }, 20);
  const state = await awaitRelease(cfg(api), jobListing);
  assert.equal(state, 'complete');

  api.state = 'disputed';
  await assert.rejects(() => awaitRelease(cfg(api), jobListing), /disputed/);
  api.state = 'refunded';
  await assert.rejects(() => awaitRelease(cfg(api), jobListing), /refunded/);
});

await check('awaitRelease: in_review and verified are in-flight states that emit events', async () => {
  const api = makeFakeApi('submitted');
  const events: WorkerEvent[] = [];
  const { cfg } = makeHooks(events);
  setTimeout(() => {
    api.state = 'in_review';
  }, 10);
  setTimeout(() => {
    api.state = 'verified';
  }, 25);
  setTimeout(() => {
    api.state = 'complete';
  }, 40);
  const state = await awaitRelease(cfg(api), jobListing);
  assert.equal(state, 'complete');
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('in_review'), `expected in_review event, got ${kinds}`);
  assert.ok(kinds.includes('verified'), `expected verified event, got ${kinds}`);
  assert.equal(kinds.at(-1), 'released');
});

await check('withdrawJob: no-op before release, claim() after', async () => {
  const api = makeFakeApi('submitted');
  const { cfg, sent } = makeHooks();
  const early = await withdrawJob(cfg(api), jobListing);
  assert.equal(early.withdrawn, false);
  assert.equal(sent.length, 0);

  api.state = 'complete';
  const late = await withdrawJob(cfg(api), jobListing);
  assert.equal(late.withdrawn, true);
  assert.ok(late.txHash);
  assert.equal(sent.length, 1);
  assert.equal(decodeWorkerCalldata(sent[0].data).functionName, 'claim');
  assert.deepEqual(decodeWorkerCalldata(sent[0].data).args, [42n]);
});

await check('fetchJob throws for unknown listings', async () => {
  const fetchImpl = (async () => Response.json({})) as typeof fetch;
  await assert.rejects(() => fetchJob({ apiBase: 'x', fetchImpl }, 99), /not found/);
});

await check('runWorkerLoop: full cycle then abort; one bad job never kills the loop', async () => {
  const api = makeFakeApi('open');
  const events: WorkerEvent[] = [];
  const { cfg, sent } = makeHooks(events);
  const controller = new AbortController();
  const base = cfg(api);
  let workCalls = 0;
  const loopCfg: WorkerLoopConfig = {
    ...base,
    onEvent: (e) => {
      events.push(e);
      if (e.kind === 'submitted') api.state = 'complete'; // requester releases
      if (e.kind === 'withdrawn') controller.abort(); // stop after one full cycle
    },
    doWork: async () => {
      workCalls++;
      if (workCalls === 1) throw new Error('work failed (simulated)');
      return { contentHash: ('0x' + 'ab'.repeat(32)) as Hex, uri: 'ipfs://bafywork' };
    },
  };
  await runWorkerLoop(loopCfg, controller.signal);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('error'), 'expected an error event from the failed job');
  assert.ok(kinds.includes('claimed'), kinds.join(','));
  assert.ok(kinds.includes('submitted'), kinds.join(','));
  assert.ok(kinds.includes('released'), kinds.join(','));
  assert.ok(kinds.includes('withdrawn'), kinds.join(','));
  // 2 iterations x (approve + claimBounty) + confirmDelivery + claim
  assert.equal(sent.filter((s) => decodeWorkerCalldata(s.data).functionName === 'claimBounty').length, 2);
  assert.equal(sent.filter((s) => decodeWorkerCalldata(s.data).functionName === 'claim').length, 1);
});

console.log(`\n${passed} worker loop checks passed.`);
