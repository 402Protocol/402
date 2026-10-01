/**
 * 402 Manager worker daemon — the around-the-clock bounty hunter.
 *
 * Holds the /jobs/stream SSE dispatch feed open around the clock. The moment
 * a `job_posted` event lands, the daemon fetches the listing, applies the
 * claim filters, and claims it onchain (exact $1 stake) — then appends the
 * claimed job to queue.jsonl so the agent (me) gets paged to do the work.
 *
 * Safety rails:
 * - min bounty $2 (never claim below stake+gas economics)
 * - max 1 active job at a time (claimed/submitted/in_review/verified)
 * - seen-ids so a job is only ever attempted once
 * - poll fallback every 60s in case the stream drops silently
 * - every decision logged to daemon.log; the key never hits the log
 *
 * Run: npx tsx worker/daemon.ts   (foreground; supervised by cron watchdog)
 *
 * Railway (persistent home — the VM's cron watchdog can't survive VM recycles):
 * - New service in the same Railway project, same repo/branch, start command:
 *     npx -y tsx worker/daemon.ts
 * - Env: FOUR02_MANAGER_KEY=<manager wallet private key>  (set in the Railway
 *   dashboard; never in code, never in chat)
 * - Optional env: FOUR02_WORKER_STATE_DIR (must match the Railway volume mount
 *   path, e.g. /app/worker/state), FOUR02_WORKER_PAUSED=1 (pause claiming)
 * - Give the service a public domain so the claim pager can poll GET /queue
 *   and GET /health from the outside.
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { ink } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { LOUNGE_DOMAIN, LOUNGE_TYPES } from '../src/lounge/signing.js';
import { claimJob, fetchJob, fetchOpenJobs } from '../src/jobs/worker-loop.js';
import { pickJob, type WorkerJobListing } from '../src/jobs/worker.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Railway: point FOUR02_WORKER_STATE_DIR at the volume mount path so
// seen.json / queue.jsonl / daemon.log survive redeploys.
const STATE_DIR = process.env.FOUR02_WORKER_STATE_DIR || join(HERE, 'state');
const SEEN_PATH = join(STATE_DIR, 'seen.json');
const QUEUE_PATH = join(STATE_DIR, 'queue.jsonl');
const LOG_PATH = join(STATE_DIR, 'daemon.log');

const API = 'https://402-production.up.railway.app';
const RPC = 'https://rpc-gel.inkonchain.com';
const MIN_BOUNTY_USDC = '2';
const POLL_FALLBACK_MS = 60_000;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    /* best effort */
  }
  console.log(line.trimEnd());
}

function loadManagerKey(): Hex {
  // Railway: FOUR02_MANAGER_KEY comes from the service's env vars (dashboard).
  const fromEnv = (process.env.FOUR02_MANAGER_KEY || '').trim();
  if (fromEnv) return fromEnv as Hex;
  // Local dev fallback: on-disk file, never committed.
  const envPath = join(HERE, '..', '.manager.env');
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*FOUR02_MANAGER_KEY\s*=\s*(\S+)\s*$/);
    if (m) return m[1] as Hex;
  }
  throw new Error('FOUR02_MANAGER_KEY not found in .manager.env');
}

function loadSeen(): Set<number> {
  try {
    const raw = JSON.parse(readFileSync(SEEN_PATH, 'utf8')) as number[];
    return new Set(raw);
  } catch {
    return new Set();
  }
}
function saveSeen(seen: Set<number>): void {
  writeFileSync(SEEN_PATH, JSON.stringify([...seen]));
}

// Everything the daemon has claimed and queued for the agent, newest last.
// Served over HTTP (GET /queue) so the off-box claim pager can poll it.
function readQueue(): Array<Record<string, unknown>> {
  try {
    return readFileSync(QUEUE_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

const ACTIVE_STATES = new Set(['claimed', 'submitted', 'in_review', 'verified']);

async function hasActiveClaim(worker: Address): Promise<boolean> {
  const body = (await apiGet(`/jobs/mine?wallet=${worker}`)) as {
    jobs?: Array<{ role: string; state: string }>;
  };
  return (body.jobs ?? []).some(
    (j) => j.role !== 'requester' && ACTIVE_STATES.has(j.state),
  );
}

const PAUSED = process.env.FOUR02_WORKER_PAUSED === '1';

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  const key = loadManagerKey();
  const account = privateKeyToAccount(key);
  const worker = account.address;
  const agentId = 4076n;

  // Tiny read-only status server so external monitors (claim pager) can reach
  // the daemon without sharing a disk. Railway injects PORT.
  const statusServer = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: '402-worker-daemon',
          worker,
          agentId: agentId.toString(),
          paused: PAUSED,
          queuedClaims: readQueue().length,
          now: new Date().toISOString(),
        }),
      );
      return;
    }
    if (url.pathname === '/queue') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ queue: readQueue() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const statusPort = Number(process.env.PORT || 4021);
  statusServer.listen(statusPort, () =>
    log(`status server listening on :${statusPort}`),
  );

  const publicClient = createPublicClient({ chain: ink, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: ink, transport: http(RPC) });

  const seen = loadSeen();
  log(`daemon starting: worker=${worker} agentId=${agentId} minBounty=$${MIN_BOUNTY_USDC}`);

  const loopCfg = {
    apiBase: API,
    worker,
    agentId,
    minBountyUsdc: MIN_BOUNTY_USDC,
    sign: async (
      primaryType: 'JobEnroll' | 'JobClaim' | 'JobSubmit',
      message: Record<string, unknown>,
    ) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await account.signTypedData({
        domain: LOUNGE_DOMAIN,
        types: LOUNGE_TYPES,
        primaryType,
        message: { ...message, timestamp: BigInt(timestamp) } as never,
      });
      return { author: worker, timestamp, signature };
    },
    sendTransaction: async (to: Address, data: Hex): Promise<Hex> => {
      const hash = await walletClient.sendTransaction({ to, data });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    doWork: async () => {
      throw new Error('daemon never does the work itself — it pages the agent');
    },
    onEvent: (e: { kind: string; jobId?: number; detail?: string }) =>
      log(`event kind=${e.kind} jobId=${e.jobId ?? '-'} ${e.detail ?? ''}`),
  };

  async function maybeClaim(jobId: number, source: string): Promise<void> {
    if (PAUSED) {
      log(`skip job ${jobId} (${source}): worker paused via FOUR02_WORKER_PAUSED`);
      return;
    }
    if (seen.has(jobId)) return;
    seen.add(jobId);
    saveSeen(seen);
    try {
      if (await hasActiveClaim(worker)) {
        log(`skip job ${jobId} (${source}): already have an active job`);
        return;
      }
      const job: WorkerJobListing = await fetchJob(loopCfg, jobId);
      const picked = pickJob([job], { minBountyUsdc: MIN_BOUNTY_USDC });
      if (!picked) {
        log(`skip job ${jobId} (${source}): below floor / ineligible (${job.bountyUsdc} USDC)`);
        return;
      }
      log(`claiming job ${jobId} (${source}): "${job.title}" $${job.bountyUsdc}`);
      const { approveTxHash, claimTxHash } = await claimJob(loopCfg, job);
      appendFileSync(
        QUEUE_PATH,
        JSON.stringify({
          jobId,
          escrowJobId: job.escrowJobId,
          title: job.title,
          bountyUsdc: job.bountyUsdc,
          category: job.category,
          claimedAt: new Date().toISOString(),
          approveTxHash,
          claimTxHash,
          status: 'claimed',
        }) + '\n',
      );
      log(`claimed job ${jobId}: claim tx ${claimTxHash} — queued for the agent`);
    } catch (e) {
      log(`ERROR job ${jobId} (${source}): ${(e as Error).message}`);
    }
  }

  async function pollFallback(): Promise<void> {
    try {
      const jobs = await fetchOpenJobs(loopCfg);
      for (const job of jobs) {
        if (!seen.has(job.id)) await maybeClaim(job.id, 'poll');
      }
    } catch (e) {
      log(`poll fallback error: ${(e as Error).message}`);
    }
  }

  // Initial reconcile: catch anything posted while we were down.
  await pollFallback();
  const pollTimer = setInterval(pollFallback, POLL_FALLBACK_MS);

  // SSE dispatch feed (primary): reconnect with backoff forever.
  let backoffMs = 2_000;
  for (;;) {
    try {
      log('connecting to /jobs/stream …');
      await subscribeToStream(async (jobId) => {
        await maybeClaim(jobId, 'stream');
      });
      log('stream ended; reconnecting');
    } catch (e) {
      log(`stream error: ${(e as Error).message}; retry in ${backoffMs}ms`);
    }
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }

  async function subscribeToStream(onPosted: (jobId: number) => Promise<void>): Promise<void> {
    const res = await fetch(`${API}/jobs/stream`, {
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
    backoffMs = 2_000;
    log('stream connected');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = '';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
          // ': …' comment lines (heartbeats) are ignored
        }
        if (event === 'job_posted' && data) {
          try {
            const payload = JSON.parse(data) as { id?: unknown };
            if (typeof payload.id === 'number') await onPosted(payload.id);
          } catch {
            /* malformed frame — ignore */
          }
        }
      }
    }
  }

  void pollTimer;
}

main().catch((e) => {
  log(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
