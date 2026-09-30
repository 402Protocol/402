/**
 * 402 Deliverable Publisher — settled-only publication of job deliverables.
 *
 * When a bounty settles (requester accepted, release verified onchain), this
 * keeper fetches the worker's submitted artifact, hash-verifies it against
 * the submission hash committed at submit time, pins it to IPFS, and commits
 * it into the job-category repo under `jobs/<jobId>/` as `402 Publisher`:
 *
 *   jobs/<jobId>/
 *     README.md      # human-readable record (spec §5)
 *     manifest.json  # machine-readable record (spec §6)
 *     reviews.json   # panel scores + reviewer agent ids (scores only)
 *     <artifact>     # the worker's file (omitted when > 25 MB: IPFS-only)
 *
 * The property that matters: ONLY settled (`complete`) jobs are published.
 * No settlement tx, no folder — the repo is unpumpable by construction.
 *
 * Notes vs the spec (all preserve the security properties):
 * - Hash check accepts keccak256 OR sha256 of the artifact bytes. The
 *   spec says sha256, but every documented worker flow (MCP jobs_submit,
 *   worker-loop WorkResult) commits keccak256 at submit time — sha256-only
 *   would refuse every real submission. The recorded `hashAlgo` says which
 *   matched.
 * - `manifest.ipfsCid` is the artifact set's CID (pinned before the GitHub
 *   commit, per spec §4.2 order), not a separately pinned manifest.
 * - The manifest carries no `repoCommit` field (unknowable before the
 *   commit exists); `publish_commit` in the DB is the GitHub link.
 * - Retry bookkeeping uses `publish_attempts` / `publish_next_retry_at`
 *   columns (additive; needed to implement spec §4.4).
 */
import { createHash } from 'node:crypto';
import { keccak256 } from 'viem';
import { CHAIN_ID as INK_CHAIN_ID } from '../constants.js';
import { ipfsToGateway, DEFAULT_IPFS_GATEWAY } from './avatars.js';
import { JobsDb, type JobListing, type JobPanel } from './db.js';

/** Display name + org for the five v0 category repos (Father created). */
export const PUBLISHER_ORG = '402Protocol';
export const PUBLISHER_NAME = '402 Publisher';
export const PUBLISHER_EMAIL = '402@fourzero2.com';
export const PUBLISHER_BRANCH = 'main';

/** Job category -> delivery repo (bare names; the org already says 402). */
export const CATEGORY_REPOS: Record<string, string> = {
  'oracle-panel': `${PUBLISHER_ORG}/oracle-panel`,
  writing: `${PUBLISHER_ORG}/writing`,
  code: `${PUBLISHER_ORG}/code`,
  design: `${PUBLISHER_ORG}/design`,
  data: `${PUBLISHER_ORG}/data`,
};

/** Artifact sets over this go IPFS-only (keeps repos cloneable). */
export const MAX_GITHUB_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** Hard cap on fetched bytes — beyond this the fetch is refused outright. */
export const MAX_FETCH_BYTES = 64 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;

/** 5 attempts over ~1h: immediate, +5m, +15m, +25m, +15m. */
export const PUBLISH_RETRY_DELAYS_SEC = [0, 300, 900, 1500, 900];
export const PUBLISH_MAX_ATTEMPTS = PUBLISH_RETRY_DELAYS_SEC.length;

export const PUBLISH_LOOP_MS = 60_000;

const MAX_FILENAME_LEN = 128;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface PinClient {
  /** Pin raw bytes; resolves to the IPFS CID. */
  pinFile(name: string, bytes: Uint8Array): Promise<string>;
}

export interface GitHubFile {
  path: string;
  content: string;
}

export interface GitHubClient {
  /**
   * Commit files to the repo's main branch (creates the branch when the
   * repo is empty). Returns the new commit SHA.
   */
  commitFiles(opts: {
    repo: string;
    files: GitHubFile[];
    message: string;
  }): Promise<string>;
  /** Seed the repo root README when missing (no-op when present). */
  ensureRootReadme(opts: { repo: string; category: string }): Promise<void>;
  /**
   * Read back the committed manifest for a job folder, or null when the
   * folder does not exist. Used for the §4.5 adopt-if-matching rule.
   */
  readJobManifest(
    repo: string,
    jobId: number,
  ): Promise<{ manifest: PublicationManifest; commitSha: string } | null>;
}

export interface PublisherDeps {
  db: JobsDb;
  githubToken: string;
  pinataJwt: string;
  ipfsGateway?: string;
  log?: (msg: string) => void;
  fetchImpl?: FetchImpl;
  pin?: PinClient;
  github?: GitHubClient;
  /** Unix seconds. */
  now?: () => number;
}

export interface PublishedArtifact {
  name: string;
  bytes: number;
  sha256: string;
  /** keccak256 is the ecosystem standard; sha256 accepted as fallback. */
  hashAlgo: 'keccak256' | 'sha256';
  ipfsCid: string;
}

export interface PublicationManifest {
  jobId: number;
  category: string;
  title: string;
  bountyUsdc: string;
  workerWallet: string | null;
  workerAgentId: string | null;
  claimedAt: number | null;
  submittedAt: number | null;
  settledAt: number | null;
  settlementTx: string | null;
  chainId: number;
  submissionUri: string;
  submissionHash: string;
  artifacts: PublishedArtifact[];
  /** Present only when the set exceeded the GitHub size cap. */
  githubSkipped?: 'size';
  /** CID of the artifact set (first artifact's CID). */
  ipfsCid: string;
  score: number | null;
  reviewerCount: number;
  /**
   * Attestation bundle hashes are per-epoch in the panel keeper, not
   * per-job in the DB — null is the honest value, not a gap.
   */
  attestationBundleHash: null;
  publisher: string;
  publishedAt: number;
}

/** Distinguishes a trust failure (never retry) from a transient one. */
export class HashMismatchError extends Error {
  constructor() {
    super('hash_mismatch');
    this.name = 'HashMismatchError';
  }
}

/** Basename-only, separator-stripped, length-capped. Null when unusable. */
export function sanitizeFilename(raw: string): string | null {
  const base = raw.split('/').pop()?.split('\\').pop() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, MAX_FILENAME_LEN);
  const trimmed = cleaned.replace(/^\.+/, '');
  return trimmed.length > 0 ? trimmed : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function keccak256Hex(bytes: Uint8Array): string {
  return keccak256(bytes);
}

/**
 * The submission hash is an opaque 0x bytes32 the worker committed at
 * submit time. Every documented worker flow uses keccak256 of the
 * deliverable bytes; sha256 is accepted as a fallback. Returns which
 * algorithm matched, or null.
 */
export function verifySubmissionHash(
  bytes: Uint8Array,
  submissionHash: string,
): 'keccak256' | 'sha256' | null {
  const want = submissionHash.toLowerCase();
  if (keccak256Hex(bytes).toLowerCase() === want) return 'keccak256';
  if (`0x${sha256Hex(bytes)}`.toLowerCase() === want) return 'sha256';
  return null;
}

/** Fetch with timeout and a hard byte cap (never OOM on a hostile URI). */
async function fetchBytes(
  fetchImpl: FetchImpl,
  url: string,
  timeoutMs: number,
  hardCap: number,
): Promise<Uint8Array> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`fetch_failed:${res.status}`);
    const len = res.headers.get('content-length');
    if (len && Number(len) > hardCap) throw new Error('fetch_too_large');
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > hardCap) throw new Error('fetch_too_large');
      return buf;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > hardCap) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error('fetch_too_large');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Repo root README (spec §3): what the repo is, and why it can't be pumped. */
export function buildRootReadme(category: string): string {
  return (
    `# 402 ${category} — settled bounties\n\n` +
    `Every folder in \`jobs/\` is one settled 402 bounty in the \`${category}\` ` +
    `category: a real bounty, real work, and a real onchain settlement where ` +
    `USDC moved. The publisher only commits jobs whose release transaction ` +
    `is verified onchain — no settlement, no folder.\n\n` +
    `Each job folder carries the worker's hash-verified deliverable, a ` +
    `machine-readable \`manifest.json\`, the panel's scores in \`reviews.json\`, ` +
    `and an IPFS mirror of the artifact set.\n\n` +
    `Acceptance and publication do not establish factual accuracy, ` +
    `completeness, or independent review beyond the recorded panel score.\n`
  );
}

/** Per-job README (spec §5). Titles are worker-supplied: HTML-escaped. */
export function buildJobReadme(o: {
  jobId: number;
  title: string;
  category: string;
  bountyUsdc: string;
  settledAt: number | null;
  workerAgentId: string | null;
  workerWallet: string | null;
  score: number | null;
  reviewerCount: number;
  settlementTx: string | null;
  artifactCids: string[];
  sizeSkipped: boolean;
}): string {
  const lines = [
    `# 402 bounty ${o.jobId} — ${escapeHtml(o.title)}`,
    ``,
    `- Category: ${o.category}`,
    `- Bounty: ${o.bountyUsdc} USDC — settled ${o.settledAt ? new Date(o.settledAt * 1000).toISOString() : 'unknown'}`,
    `- Worker: agent ${o.workerAgentId ?? 'unknown'} (${o.workerWallet ?? 'unknown'})`,
    `- Score: ${o.score ?? 'unscored'} from ${o.reviewerCount} reviewer${o.reviewerCount === 1 ? '' : 's'}`,
    `- Settlement: ${o.settlementTx ? `https://explorer.inkonchain.com/tx/${o.settlementTx}` : 'unknown'}`,
    `- Artifact integrity: hash-verified against the submission hash committed at submit time`,
    ...o.artifactCids.map((cid) => `- IPFS mirror: ipfs://${cid}`),
  ];
  if (o.sizeSkipped) {
    lines.push(
      `- Note: the artifact set exceeded the 25 MB repo cap and is IPFS-only; the manifest below still records its hashes.`,
    );
  }
  lines.push(
    ``,
    `These files were published by the 402 Publisher from the accepted,`,
    `hash-verified worker submission. Acceptance and publication do not establish`,
    `factual accuracy, completeness, or independent review beyond the recorded`,
    `panel score.`,
  );
  return lines.join('\n') + '\n';
}

/** Panel record: scores + reviewer agent ids only — never prose rationale. */
export function buildReviewsJson(panel: JobPanel | null): string {
  if (!panel) {
    return (
      JSON.stringify(
        { jobId: null, panelState: null, reviewers: [], votes: [], decidedAt: null },
        null,
        2,
      ) + '\n'
    );
  }
  return (
    JSON.stringify(
      {
        jobId: panel.jobId,
        panelState: panel.state,
        reviewers: panel.reviewers.map((r) => ({
          reviewerAgentId: r.reviewerAgentId,
          votedAt: r.votedAt,
        })),
        votes: panel.votes.map((v) => ({
          reviewerAgentId: v.reviewerAgentId,
          verdict: v.verdict,
          score: v.score,
          votedAt: v.votedAt,
        })),
        decidedAt: panel.decidedAt,
      },
      null,
      2,
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
// Pinata + GitHub API clients (real implementations; fakes injected in tests)
// ---------------------------------------------------------------------------

/** Minimal Pinata client: pinFileToIPFS with a JWT bearer. */
export function createPinataClient(
  jwt: string,
  fetchImpl: FetchImpl = fetch,
): PinClient {
  return {
    async pinFile(name: string, bytes: Uint8Array): Promise<string> {
      const form = new FormData();
      form.append('file', new Blob([bytes as BlobPart]), name);
      form.append(
        'pinataMetadata',
        JSON.stringify({ name: `402-publisher/${name}` }),
      );
      const res = await fetchImpl(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}` },
          body: form,
        },
      );
      if (!res.ok) throw new Error(`pinata_pin_failed:${res.status}`);
      const body = (await res.json()) as { IpfsHash?: string };
      if (!body.IpfsHash) throw new Error('pinata_pin_failed:missing_cid');
      return body.IpfsHash;
    },
  };
}

interface GitHubApi {
  (path: string, init?: RequestInit): Promise<Response>;
}

function createGitHubApi(token: string, fetchImpl: FetchImpl): GitHubApi {
  return (path: string, init?: RequestInit) =>
    fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
}

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

/** Real GitHub client over the Git Data API. */
export function createGitHubClient(
  token: string,
  fetchImpl: FetchImpl = fetch,
): GitHubClient {
  const api = createGitHubApi(token, fetchImpl);
  const rootReadmeSeeded = new Set<string>();

  async function commitFiles(opts: {
    repo: string;
    files: GitHubFile[];
    message: string;
  }): Promise<string> {
    const [owner, repo] = opts.repo.split('/');
    // Current tip of main (404 = fresh empty repo, no branch yet).
    const refRes = await api(
      `/repos/${owner}/${repo}/git/ref/heads/${PUBLISHER_BRANCH}`,
    );
    let base: string | null = null;
    if (refRes.ok) {
      const ref = (await readJson(refRes)) as { object: { sha: string } };
      base = ref.object.sha;
    } else if (refRes.status !== 404) {
      throw new Error(`github_ref_failed:${refRes.status}`);
    }
    // Blobs.
    const entries: { path: string; mode: '100644'; type: 'blob'; sha: string }[] =
      [];
    for (const f of opts.files) {
      const blobRes = await api(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          encoding: 'base64',
        }),
      });
      if (!blobRes.ok) throw new Error(`github_blob_failed:${blobRes.status}`);
      const blob = (await readJson(blobRes)) as { sha: string };
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    // Tree.
    const treeBody: Record<string, unknown> = { tree: entries };
    if (base) treeBody.base_tree = base;
    const treeRes = await api(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify(treeBody),
    });
    if (!treeRes.ok) throw new Error(`github_tree_failed:${treeRes.status}`);
    const tree = (await readJson(treeRes)) as { sha: string };
    // Commit.
    const commitRes = await api(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: opts.message,
        tree: tree.sha,
        parents: base ? [base] : [],
        author: { name: PUBLISHER_NAME, email: PUBLISHER_EMAIL },
      }),
    });
    if (!commitRes.ok)
      throw new Error(`github_commit_failed:${commitRes.status}`);
    const commit = (await readJson(commitRes)) as { sha: string };
    // Move the branch.
    if (base) {
      const patchRes = await api(
        `/repos/${owner}/${repo}/git/refs/heads/${PUBLISHER_BRANCH}`,
        { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) },
      );
      if (!patchRes.ok)
        throw new Error(`github_ref_update_failed:${patchRes.status}`);
    } else {
      const postRes = await api(`/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${PUBLISHER_BRANCH}`,
          sha: commit.sha,
        }),
      });
      if (!postRes.ok)
        throw new Error(`github_ref_create_failed:${postRes.status}`);
    }
    return commit.sha;
  }

  return {
    commitFiles,
    async ensureRootReadme(opts: {
      repo: string;
      category: string;
    }): Promise<void> {
      if (rootReadmeSeeded.has(opts.repo)) return;
      const [owner, repo] = opts.repo.split('/');
      const res = await api(`/repos/${owner}/${repo}/contents/README.md`);
      if (res.ok) {
        rootReadmeSeeded.add(opts.repo);
        return;
      }
      if (res.status !== 404)
        throw new Error(`github_contents_failed:${res.status}`);
      await commitFiles({
        repo: opts.repo,
        files: [{ path: 'README.md', content: buildRootReadme(opts.category) }],
        message: `402publisher: seed ${opts.category} repo readme`,
      });
      rootReadmeSeeded.add(opts.repo);
    },
    async readJobManifest(
      repo: string,
      jobId: number,
    ): Promise<{ manifest: PublicationManifest; commitSha: string } | null> {
      const [owner, name] = repo.split('/');
      const path = `jobs/${jobId}/manifest.json`;
      const res = await api(
        `/repos/${owner}/${name}/contents/${path}?ref=${PUBLISHER_BRANCH}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_contents_failed:${res.status}`);
      const body = (await readJson(res)) as {
        content?: string;
        encoding?: string;
      };
      if (body.encoding !== 'base64' || !body.content) {
        throw new Error('github_manifest_unreadable');
      }
      const manifest = JSON.parse(
        Buffer.from(body.content, 'base64').toString('utf8'),
      ) as PublicationManifest;
      // The commit that last touched the manifest = the publication commit.
      const commitsRes = await api(
        `/repos/${owner}/${name}/commits?path=${encodeURIComponent(path)}&per_page=1&sha=${PUBLISHER_BRANCH}`,
      );
      let commitSha = 'unknown';
      if (commitsRes.ok) {
        const commits = (await readJson(commitsRes)) as { sha: string }[];
        if (commits.length > 0) commitSha = commits[0].sha;
      }
      return { manifest, commitSha };
    },
  };
}

// ---------------------------------------------------------------------------
// The publish flow (§4.2)
// ---------------------------------------------------------------------------

function resolveDeps(deps: PublisherDeps): Required<
  Pick<
    PublisherDeps,
    'fetchImpl' | 'log' | 'now' | 'ipfsGateway' | 'pin' | 'github'
  >
> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    fetchImpl,
    log: deps.log ?? ((m) => console.log(`[publisher] ${m}`)),
    now: deps.now ?? (() => Math.floor(Date.now() / 1000)),
    ipfsGateway: deps.ipfsGateway ?? DEFAULT_IPFS_GATEWAY,
    pin: deps.pin ?? createPinataClient(deps.pinataJwt, fetchImpl),
    github: deps.github ?? createGitHubClient(deps.githubToken, fetchImpl),
  };
}

function submissionUrlToFetchable(
  uri: string,
  ipfsGateway: string,
): string | null {
  const lower = uri.toLowerCase();
  if (lower.startsWith('https://') || lower.startsWith('http://')) return uri;
  if (lower.startsWith('ipfs://')) return ipfsToGateway(uri, ipfsGateway);
  return null;
}

function filenameFromUri(uri: string): string {
  try {
    const u = new URL(uri);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return uri.split('/').filter(Boolean).pop() ?? 'deliverable';
  }
}

/**
 * Publish one settled job. Throws HashMismatchError (no retry — trust event)
 * or a transient Error (the tick converts it into retry bookkeeping).
 */
export async function publishOneJob(
  rawDeps: PublisherDeps,
  job: JobListing,
): Promise<{ commitSha: string; cid: string }> {
  const deps = resolveDeps(rawDeps);
  const { db } = rawDeps;
  const now = deps.now();
  const repo = CATEGORY_REPOS[job.category];
  if (!repo) {
    db.markPublishFailed(job.id, 'unknown_category', now, job.publishAttempts);
    throw new Error(`unknown_category:${job.category}`);
  }
  if (!job.submissionUri || !job.submissionHash) {
    // Accept can mirror an onchain release without an API submit (see
    // acceptJob): then there is no artifact to publish.
    db.markPublishFailed(job.id, 'missing_submission', now, job.publishAttempts);
    throw new Error('missing_submission');
  }
  const fetchable = submissionUrlToFetchable(job.submissionUri, deps.ipfsGateway);
  if (!fetchable) {
    db.markPublishFailed(job.id, 'unsupported_uri_scheme', now, job.publishAttempts);
    throw new Error('unsupported_uri_scheme');
  }

  // 1-2. Fetch + hash-verify (mismatch = trust event, never retried).
  const bytes = await fetchBytes(
    deps.fetchImpl,
    fetchable,
    FETCH_TIMEOUT_MS,
    MAX_FETCH_BYTES,
  );
  const hashAlgo = verifySubmissionHash(bytes, job.submissionHash);
  if (!hashAlgo) {
    db.markPublishFailed(job.id, 'hash_mismatch', now, job.publishAttempts);
    throw new HashMismatchError();
  }

  // §4.5: adopt an existing folder when its manifest matches our hashes.
  const existing = await deps.github.readJobManifest(repo, job.id);
  if (existing) {
    const ours = sha256Hex(bytes);
    const theirs = existing.manifest.artifacts?.[0]?.sha256;
    if (theirs && theirs.toLowerCase() === ours.toLowerCase()) {
      const cid = existing.manifest.ipfsCid;
      db.markPublished(job.id, existing.commitSha, cid, now);
      deps.log(`job ${job.id}: adopted existing folder (${existing.commitSha})`);
      return { commitSha: existing.commitSha, cid };
    }
    db.markPublishFailed(job.id, 'folder_conflict', now, job.publishAttempts);
    throw new Error('folder_conflict');
  }

  // 3. Pin the artifact set to IPFS first (spec §4.2 order).
  const rawName = filenameFromUri(job.submissionUri);
  const name = sanitizeFilename(rawName) ?? 'deliverable';
  const cid = await deps.pin.pinFile(name, bytes);
  const sizeSkipped = bytes.length > MAX_GITHUB_ARTIFACT_BYTES;

  // Panel record: scores + reviewer agent ids only.
  const panel = db.getPanel(job.id);
  const acceptVotes = (panel?.votes ?? []).filter((v) => v.verdict);
  const score =
    acceptVotes.length > 0
      ? Math.round(
          (acceptVotes.reduce((a, v) => a + v.score, 0) / acceptVotes.length) * 10,
        ) / 10
      : null;
  const settlement = db.getSettlement(job.id);

  const manifest: PublicationManifest = {
    jobId: job.id,
    category: job.category,
    title: job.title,
    bountyUsdc: job.bountyUsdc,
    workerWallet: job.worker,
    workerAgentId: job.workerAgentId,
    claimedAt: db.getJobTxAt(job.id, 'claim'),
    submittedAt: job.submittedAt,
    settledAt: settlement?.settledAt ?? null,
    settlementTx: settlement?.txHash ?? null,
    chainId: INK_CHAIN_ID,
    submissionUri: job.submissionUri,
    submissionHash: job.submissionHash,
    artifacts: [
      {
        name,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        hashAlgo,
        ipfsCid: cid,
      },
    ],
    ...(sizeSkipped ? { githubSkipped: 'size' as const } : {}),
    ipfsCid: cid,
    score,
    reviewerCount: panel?.votes.length ?? 0,
    attestationBundleHash: null,
    publisher: PUBLISHER_NAME,
    publishedAt: now,
  };

  const folder = `jobs/${job.id}`;
  const files: GitHubFile[] = [
    {
      path: `${folder}/README.md`,
      content: buildJobReadme({
        jobId: job.id,
        title: job.title,
        category: job.category,
        bountyUsdc: job.bountyUsdc,
        settledAt: manifest.settledAt,
        workerAgentId: job.workerAgentId,
        workerWallet: job.worker,
        score,
        reviewerCount: panel?.votes.length ?? 0,
        settlementTx: manifest.settlementTx,
        artifactCids: [cid],
        sizeSkipped,
      }),
    },
    {
      path: `${folder}/manifest.json`,
      content: JSON.stringify(manifest, null, 2) + '\n',
    },
    { path: `${folder}/reviews.json`, content: buildReviewsJson(panel) },
  ];
  if (!sizeSkipped) {
    files.push({
      path: `${folder}/${name}`,
      content: Buffer.from(bytes).toString('utf8'),
    });
  }

  // 4. Commit as 402 Publisher.
  await deps.github.ensureRootReadme({ repo, category: job.category });
  const commitSha = await deps.github.commitFiles({
    repo,
    files,
    message: `402publisher: publish ${job.category} job ${job.id}`,
  });

  // 5. Both mirrors landed — mark published (§4.5).
  db.markPublished(job.id, commitSha, cid, now);
  deps.log(`job ${job.id}: published ${commitSha} (${repo})`);
  return { commitSha, cid };
}

/**
 * One keeper tick: publish every due settled job. Transient failures become
 * retry bookkeeping (5 attempts over ~1h, then terminal `failed`).
 */
export async function runPublisherTick(
  rawDeps: PublisherDeps,
): Promise<{ processed: number; published: number; failed: number }> {
  const deps = resolveDeps(rawDeps);
  const { db } = rawDeps;
  const now = deps.now();
  const jobs = db.getPublishableJobs(now);
  let published = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await publishOneJob(rawDeps, job);
      published++;
    } catch (e) {
      if (e instanceof HashMismatchError) {
        // Already marked failed inside publishOneJob — trust event, no retry.
        failed++;
        deps.log(`job ${job.id}: hash mismatch — not publishing`);
        continue;
      }
      const err = (e as Error).message;
      // Terminal states set inside publishOneJob stay terminal.
      const fresh = db.getJob(job.id);
      if (fresh?.publishState === 'failed') {
        failed++;
        continue;
      }
      const attempts = (fresh?.publishAttempts ?? job.publishAttempts) + 1;
      if (attempts >= PUBLISH_MAX_ATTEMPTS) {
        db.markPublishFailed(job.id, `failed_after_retries:${err}`, now, attempts);
        deps.log(`job ${job.id}: retries exhausted (${err})`);
        failed++;
      } else {
        const delay = PUBLISH_RETRY_DELAYS_SEC[attempts] ?? 900;
        db.recordPublishAttempt(job.id, now + delay, now);
        deps.log(`job ${job.id}: attempt ${attempts} failed (${err}), retry in ${delay}s`);
      }
    }
  }
  return { processed: jobs.length, published, failed };
}

/** Start the 60s keeper loop. Returns a stop function. */
export function startPublisherLoop(
  deps: PublisherDeps,
  intervalMs: number = PUBLISH_LOOP_MS,
): () => void {
  const tick = () => {
    runPublisherTick(deps).catch((e) => {
      const log = deps.log ?? console.log;
      log(`[publisher] tick error: ${(e as Error).message}`);
    });
  };
  const timer = setInterval(tick, intervalMs);
  // Don't keep the process alive for the publisher alone.
  (timer as unknown as { unref?: () => void }).unref?.();
  void tick();
  return () => clearInterval(timer);
}
