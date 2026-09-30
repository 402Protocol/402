/**
 * 402 Deliverable Publisher — tests.
 *
 *   npx tsx test/jobs-publisher.test.ts
 *
 * The keeper loop runs against a throwaway JobsDb with injected fakes for
 * fetch / Pinata / GitHub: nothing leaves the process, no network, no keys.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  type Address,
  type Hex,
  keccak256,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { JobsDb } from '../src/jobs/db.js';
import {
  buildJobReadme,
  buildReviewsJson,
  buildRootReadme,
  runPublisherTick,
  sanitizeFilename,
  verifySubmissionHash,
  type GitHubClient,
  type GitHubFile,
  type PinClient,
  type PublicationManifest,
  MAX_GITHUB_ARTIFACT_BYTES,
  PUBLISH_MAX_ATTEMPTS,
} from '../src/jobs/publisher.js';

// ---- throwaway keys (in-process only) ----
const requester = privateKeyToAccount(generatePrivateKey());
const worker = privateKeyToAccount(generatePrivateKey());
const reviewer = privateKeyToAccount(generatePrivateKey());

const ESCROW = '0xdf319a060eaa361aa906855c64ccbc941159c01c' as Address;

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    })
    .catch((e) => {
      console.error(`FAIL - ${name}: ${(e as Error).stack ?? e}`);
      process.exitCode = 1;
    });
}

function freshDb(): JobsDb {
  return new JobsDb(join(mkdtempSync(join(tmpdir(), 'pub-')), 'jobs.db'));
}

const ARTIFACT = new TextEncoder().encode('# report\n\nhello world\n');
const ARTIFACT_KECCAK: Hex = keccak256(toHex(ARTIFACT));
const ARTIFACT_SHA256 = `0x${createHash('sha256').update(ARTIFACT).digest('hex')}`;

/** Drive a listing open -> claimed -> submitted -> complete through the DB. */
function settleJob(
  db: JobsDb,
  o: { uri?: string; hash?: Hex; category?: string } = {},
): number {
  const now = 1_800_000_000;
  const created = db.createListing({
    escrowJobId: '7',
    escrow: ESCROW,
    requester: requester.address,
    title: 'Write the launch post',
    spec: 'spec text',
    specHash: keccak256(toHex('spec text')),
    category: o.category ?? 'writing',
    bountyUsdc: '25.00',
    deadline: now + 86400,
    txHash: `0x${'aa'.repeat(32)}`,
    now,
  });
  assert.equal(created.ok, true);
  const id = (created as { ok: true; id: number }).id;
  assert.equal(
    db.claimJob(id, worker.address, '4076', `0x${'bb'.repeat(32)}`, now + 1),
    'ok',
  );
  assert.equal(
    db.submitJob(
      id,
      o.hash ?? ARTIFACT_KECCAK,
      o.uri ?? 'https://example.com/report.md',
      now + 2,
    ),
    'ok',
  );
  assert.equal(db.acceptJob(id, `0x${'cc'.repeat(32)}`, now + 3), 'ok');
  return id;
}

interface FakeFetch {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
  serve: Map<string, Uint8Array | { status: number }>;
}

function makeFetch(): FakeFetch {
  const f: FakeFetch = {
    calls: [],
    serve: new Map(),
    impl: async (url: string) => {
      f.calls.push(url);
      const v = f.serve.get(url);
      if (!v) return new Response('not found', { status: 404 });
      if (!(v instanceof Uint8Array)) return new Response('boom', { status: v.status });
      return new Response(v as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': String(v.length) },
      });
    },
  };
  return f;
}

function makePin(): PinClient & { calls: { name: string; bytes: number }[] } {
  const calls: { name: string; bytes: number }[] = [];
  let n = 0;
  return {
    calls,
    pinFile: async (name: string, bytes: Uint8Array) => {
      calls.push({ name, bytes: bytes.length });
      n++;
      return `bafyfake${n}`;
    },
  };
}

function makeGitHub(): GitHubClient & {
  commits: { repo: string; files: GitHubFile[]; message: string }[];
  readmes: string[];
  manifestToReturn: { manifest: PublicationManifest; commitSha: string } | null;
} {
  const g = {
    commits: [] as { repo: string; files: GitHubFile[]; message: string }[],
    readmes: [] as string[],
    manifestToReturn: null as {
      manifest: PublicationManifest;
      commitSha: string;
    } | null,
    commitFiles: async (opts: {
      repo: string;
      files: GitHubFile[];
      message: string;
    }) => {
      g.commits.push(opts);
      return `0xcommit${g.commits.length}`;
    },
    ensureRootReadme: async (opts: { repo: string; category: string }) => {
      g.readmes.push(opts.repo);
    },
    readJobManifest: async () => g.manifestToReturn,
  };
  return g;
}

function depsFor(
  db: JobsDb,
  f: FakeFetch,
  pin: PinClient,
  github: GitHubClient,
  nowRef: { now: number },
) {
  return {
    db,
    githubToken: 'test-token',
    pinataJwt: 'test-jwt',
    fetchImpl: f.impl,
    pin,
    github,
    now: () => nowRef.now,
    log: () => {},
  };
}

await check('sanitizeFilename strips traversal and junk', () => {
  assert.equal(sanitizeFilename('../../evil.md'), 'evil.md');
  assert.equal(sanitizeFilename('..\\..\\evil.md'), 'evil.md');
  assert.equal(sanitizeFilename('report.md'), 'report.md');
  assert.equal(sanitizeFilename('a b/c?.md'), 'c_.md');
  assert.equal(sanitizeFilename('...'), null);
  assert.equal(sanitizeFilename(''), null);
});

await check('verifySubmissionHash accepts keccak256 (ecosystem standard)', () => {
  assert.equal(verifySubmissionHash(ARTIFACT, ARTIFACT_KECCAK), 'keccak256');
});

await check('verifySubmissionHash accepts sha256 fallback', () => {
  assert.equal(verifySubmissionHash(ARTIFACT, ARTIFACT_SHA256 as Hex), 'sha256');
});

await check('verifySubmissionHash rejects wrong hash', () => {
  assert.equal(
    verifySubmissionHash(ARTIFACT, `0x${'00'.repeat(32)}`),
    null,
  );
});

/** Drive a listing to `complete` with one recorded panel vote first. */
function settleJobWithReview(db: JobsDb): number {
  const now = 1_800_000_000;
  const created = db.createListing({
    escrowJobId: '7',
    escrow: ESCROW,
    requester: requester.address,
    title: 'Write the launch post',
    spec: 'spec text',
    specHash: keccak256(toHex('spec text')),
    category: 'writing',
    bountyUsdc: '25.00',
    deadline: now + 86400,
    txHash: `0x${'aa'.repeat(32)}`,
    now,
  });
  assert.equal(created.ok, true);
  const id = (created as { ok: true; id: number }).id;
  assert.equal(
    db.claimJob(id, worker.address, '4076', `0x${'bb'.repeat(32)}`, now + 1),
    'ok',
  );
  assert.equal(db.submitJob(id, ARTIFACT_KECCAK, 'https://example.com/report.md', now + 2), 'ok');
  assert.equal(
    db.openPanel(
      id,
      [{ wallet: reviewer.address, agentId: '1420' }],
      now + 3,
      now + 3 + 172800,
    ),
    'ok',
  );
  assert.equal(
    db.recordReview({
      jobId: id,
      reviewerWallet: reviewer.address,
      reviewerAgentId: '1420',
      verdict: true,
      score: 8,
      signature: '0x',
      now: now + 4,
    }),
    'ok',
  );
  assert.equal(db.acceptJob(id, `0x${'cc'.repeat(32)}`, now + 5), 'ok');
  return id;
}

await check('happy path: keccak submission publishes to the category repo', async () => {
  const db = freshDb();
  const f = makeFetch();
  f.serve.set('https://example.com/report.md', ARTIFACT);
  const pin = makePin();
  const github = makeGitHub();
  const nowRef = { now: 1_800_000_010 };
  const id = settleJobWithReview(db);

  const r = await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  assert.equal(r.processed, 1);
  assert.equal(r.published, 1);
  assert.equal(r.failed, 0);

  const job = db.getJob(id)!;
  assert.equal(job.publishState, 'published');
  assert.ok(job.publishCommit);
  assert.ok(job.publishCid);
  assert.equal(pin.calls.length, 1);

  assert.equal(github.commits.length, 1);
  const c = github.commits[0];
  assert.equal(c.repo, '402Protocol/writing');
  assert.equal(c.message, `402publisher: publish writing job ${id}`);
  const paths = c.files.map((x) => x.path).sort();
  assert.deepEqual(paths, [
    `jobs/${id}/README.md`,
    `jobs/${id}/manifest.json`,
    `jobs/${id}/report.md`,
    `jobs/${id}/reviews.json`,
  ]);
  // No path traversal in the committed tree.
  for (const p of paths) {
    assert.ok(p.startsWith(`jobs/${id}/`), p);
    assert.ok(!p.includes('..'), p);
  }
  const manifest = JSON.parse(
    c.files.find((x) => x.path.endsWith('manifest.json'))!.content,
  ) as PublicationManifest;
  for (const k of [
    'jobId',
    'category',
    'title',
    'bountyUsdc',
    'workerWallet',
    'workerAgentId',
    'settlementTx',
    'chainId',
    'submissionUri',
    'submissionHash',
    'artifacts',
    'ipfsCid',
    'score',
    'reviewerCount',
    'publisher',
    'publishedAt',
  ]) {
    assert.ok(k in manifest, `manifest missing ${k}`);
  }
  assert.equal(manifest.jobId, id);
  assert.equal(manifest.category, 'writing');
  assert.equal(manifest.artifacts[0].hashAlgo, 'keccak256');
  assert.equal(manifest.artifacts[0].ipfsCid, manifest.ipfsCid);
  assert.equal(manifest.chainId, 57073);
  assert.ok(manifest.settlementTx);
  const readme = c.files.find((x) => x.path.endsWith('README.md'))!.content;
  assert.ok(readme.includes(`402 bounty ${id}`));
  assert.ok(readme.includes(`ipfs://${manifest.ipfsCid}`));
  const reviews = JSON.parse(
    c.files.find((x) => x.path.endsWith('reviews.json'))!.content,
  );
  assert.ok(Array.isArray(reviews.votes));
  assert.equal(reviews.votes.length, 1);
  assert.equal(reviews.votes[0].reviewerAgentId, '1420');
  assert.equal(reviews.votes[0].verdict, true);
  assert.equal(reviews.votes[0].score, 8);
  assert.equal(manifest.score, 8);
  assert.equal(manifest.reviewerCount, 1);
  db.close();
});

await check('hash mismatch refuses to publish, no retry', async () => {
  const db = freshDb();
  const f = makeFetch();
  f.serve.set('https://example.com/report.md', new TextEncoder().encode('tampered'));
  const pin = makePin();
  const github = makeGitHub();
  const nowRef = { now: 1_800_000_010 };
  const id = settleJob(db, {});
  const r = await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  assert.equal(r.failed, 1);
  const job = db.getJob(id)!;
  assert.equal(job.publishState, 'failed');
  assert.equal(job.publishError, 'hash_mismatch');
  assert.equal(job.publishAttempts, 0); // trust event: never retried
  assert.equal(github.commits.length, 0);
  assert.equal(pin.calls.length, 0);
  // Second tick: terminal state is never re-attempted.
  const r2 = await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  assert.equal(r2.processed, 0);
  db.close();
});

await check('idempotent: second tick publishes nothing new', async () => {
  const db = freshDb();
  const f = makeFetch();
  f.serve.set('https://example.com/report.md', ARTIFACT);
  const pin = makePin();
  const github = makeGitHub();
  const nowRef = { now: 1_800_000_010 };
  settleJob(db, {});
  await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  const r2 = await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  assert.equal(r2.processed, 0);
  assert.equal(github.commits.length, 1);
  db.close();
});

await check('oversized sets go IPFS-only with githubSkipped', async () => {
  const db = freshDb();
  const big = new Uint8Array(MAX_GITHUB_ARTIFACT_BYTES + 1024);
  big.fill(7);
  const bigHash = keccak256(toHex(big));
  const f = makeFetch();
  f.serve.set('https://example.com/big.bin', big);
  const pin = makePin();
  const github = makeGitHub();
  const nowRef = { now: 1_800_000_010 };
  const id = settleJob(db, {
    uri: 'https://example.com/big.bin',
    hash: bigHash,
  });
  const r = await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  assert.equal(r.published, 1);
  const job = db.getJob(id)!;
  assert.equal(job.publishState, 'published');
  const c = github.commits[0];
  const paths = c.files.map((x) => x.path);
  assert.ok(!paths.some((p) => p.endsWith('big.bin')), 'artifact blob omitted');
  const manifest = JSON.parse(
    c.files.find((x) => x.path.endsWith('manifest.json'))!.content,
  ) as PublicationManifest;
  assert.equal(manifest.githubSkipped, 'size');
  assert.ok(manifest.artifacts[0].ipfsCid);
  db.close();
});

await check('transient failures retry, then go terminal after 5 attempts', async () => {
  const db = freshDb();
  const f = makeFetch();
  f.serve.set('https://example.com/report.md', { status: 500 });
  const pin = makePin();
  const github = makeGitHub();
  const nowRef = { now: 1_800_000_010 };
  const id = settleJob(db, {});
  const d = () => depsFor(db, f, pin, github, nowRef);
  // Attempt 1: immediate.
  await runPublisherTick(d());
  let job = db.getJob(id)!;
  assert.equal(job.publishState, null);
  assert.equal(job.publishAttempts, 1);
  assert.ok((job.publishNextRetryAt ?? 0) > nowRef.now);
  // Walk the backoff ladder: 300, 900, 1500, 900.
  for (const step of [301, 901, 1501, 901]) {
    nowRef.now = (job.publishNextRetryAt ?? nowRef.now) + 1;
    await runPublisherTick(d());
    job = db.getJob(id)!;
    void step;
  }
  assert.equal(job.publishAttempts, PUBLISH_MAX_ATTEMPTS);
  assert.equal(job.publishState, 'failed');
  assert.ok(job.publishError!.startsWith('failed_after_retries:'));
  assert.equal(github.commits.length, 0);
  // Terminal: never picked up again.
  nowRef.now += 100_000;
  const r = await runPublisherTick(d());
  assert.equal(r.processed, 0);
  db.close();
});

await check('existing folder with matching hashes is adopted, not recommitted', async () => {
  const db = freshDb();
  const f = makeFetch();
  f.serve.set('https://example.com/report.md', ARTIFACT);
  const pin = makePin();
  const github = makeGitHub();
  github.manifestToReturn = {
    commitSha: '0xexisting',
    manifest: {
      jobId: 1,
      category: 'writing',
      title: 't',
      bountyUsdc: '25.00',
      workerWallet: worker.address,
      workerAgentId: '4076',
      claimedAt: null,
      submittedAt: null,
      settledAt: null,
      settlementTx: null,
      chainId: 57073,
      submissionUri: 'https://example.com/report.md',
      submissionHash: ARTIFACT_KECCAK,
      artifacts: [
        {
          name: 'report.md',
          bytes: ARTIFACT.length,
          sha256: createHash('sha256').update(ARTIFACT).digest('hex'),
          hashAlgo: 'keccak256',
          ipfsCid: 'bafyfake0',
        },
      ],
      ipfsCid: 'bafyfake0',
      score: null,
      reviewerCount: 0,
      attestationBundleHash: null,
      publisher: '402 Publisher',
      publishedAt: 1_800_000_000,
    },
  };
  const nowRef = { now: 1_800_000_010 };
  const id = settleJob(db, {});
  const r = await runPublisherTick(depsFor(db, f, pin, github, nowRef));
  assert.equal(r.published, 1);
  assert.equal(github.commits.length, 0); // adopted, not recommitted
  const job = db.getJob(id)!;
  assert.equal(job.publishState, 'published');
  assert.equal(job.publishCommit, '0xexisting');
  db.close();
});

await check('complete without a submission cannot publish', async () => {
  const db = freshDb();
  const now = 1_800_000_000;
  const created = db.createListing({
    escrowJobId: '8',
    escrow: ESCROW,
    requester: requester.address,
    title: 'Direct onchain delivery',
    spec: 'spec',
    specHash: keccak256(toHex('spec')),
    category: 'code',
    bountyUsdc: '10.00',
    deadline: now + 86400,
    txHash: `0x${'dd'.repeat(32)}`,
    now,
  });
  const id = (created as { ok: true; id: number }).id;
  // Onchain confirmDelivery without an API submit: no URI/hash to publish.
  db.claimJob(id, worker.address, '4076', `0x${'ee'.repeat(32)}`, now + 1);
  assert.equal(db.acceptJob(id, `0x${'ff'.repeat(32)}`, now + 2), 'ok');
  const f = makeFetch();
  const pin = makePin();
  const github = makeGitHub();
  const r = await runPublisherTick(
    depsFor(db, f, pin, github, { now: now + 10 }),
  );
  assert.equal(r.failed, 1);
  const job = db.getJob(id)!;
  assert.equal(job.publishState, 'failed');
  assert.equal(job.publishError, 'missing_submission');
  db.close();
});

await check('root readme + job readme builders', () => {
  const root = buildRootReadme('design');
  assert.ok(root.includes('402 design'));
  assert.ok(root.includes('no settlement, no folder'));
  const job = buildJobReadme({
    jobId: 3,
    title: '<script>alert(1)</script>',
    category: 'design',
    bountyUsdc: '5.00',
    settledAt: 1_800_000_003,
    workerAgentId: '4076',
    workerWallet: worker.address,
    score: 8.5,
    reviewerCount: 3,
    settlementTx: '0xabc',
    artifactCids: ['bafyfake1'],
    sizeSkipped: false,
  });
  assert.ok(!job.includes('<script>'), 'title is escaped');
  assert.ok(job.includes('&lt;script&gt;'));
  const reviews = JSON.parse(buildReviewsJson(null));
  assert.deepEqual(reviews.votes, []);
});

console.log(`\n${passed} publisher checks passed`);
