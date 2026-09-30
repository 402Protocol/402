/**
 * 402 Job Marketplace — live dispatch feed (v2: directed dispatch).
 *
 * Server-push dispatch, built for the 5000-agent launch: instead of workers
 * polling the board, the API pushes lifecycle events to subscribed workers
 * over Server-Sent Events (`GET /jobs/stream?wallet=0x...`). A worker opens
 * one long-lived connection and gets woken the moment work is assigned to
 * it — no polling, no claim races.
 *
 * Events:
 * - `job_posted`   (public)   — a listing went live. Carries the dispatch
 *   mode: 'directed' (one worker was assigned; everyone else stands down)
 *   or 'open' (no eligible worker; any enrolled worker may claim).
 * - `job_assigned` (directed) — routed ONLY to the assigned worker's
 *   connection(s). This is the wake-up: claim within the accept window.
 * - `job_claimed`  (public)   — the job was taken (worker + agent id).
 * - `job_opened`   (public)   — directed dispatch exhausted its rounds;
 *   the job is now racable on the open board.
 *
 * Presence: a connected socket with a wallet IS the online roster — the
 * assignment engine only wakes workers it can reach. Anonymous subscribers
 * (no ?wallet=) get public events only.
 *
 * Transport notes:
 * - In-memory subscriber set. Correct on a single instance (the current
 *   Railway deployment). The JobFeed interface is the seam: inject a
 *   Redis-backed implementation via deps.jobFeed for multi-replica
 *   deployments and every call site keeps working.
 * - Events are fire-and-forget: a slow or dead subscriber never blocks the
 *   request path. A sender that throws is unsubscribed immediately.
 * - Payloads reuse the public job shape — nothing private ever flows here.
 *   (The assignee's wallet is public board information, not a secret.)
 */

import type { Address } from 'viem';

export type JobFeedEvent =
  | 'job_posted'
  | 'job_assigned'
  | 'job_claimed'
  | 'job_opened';

/** Push one serialized event to a single subscriber. */
export type FeedSender = (event: JobFeedEvent, data: string) => void;

export interface JobFeed {
  /**
   * Register a sender; returns an unsubscribe function. `wallet` binds the
   * connection to a worker for directed events (null = public events only).
   */
  subscribe(sender: FeedSender, wallet?: Address | null): () => void;
  /** Fan out one event to every subscriber. Never throws. */
  broadcast(event: JobFeedEvent, payload: unknown): void;
  /**
   * Send one event only to the connections bound to `wallet`. Workers
   * ignore events not addressed to them; unknown wallets are a no-op.
   * Never throws.
   */
  sendTo(wallet: Address, event: JobFeedEvent, payload: unknown): void;
  readonly subscriberCount: number;
}

/**
 * Backstop against connection exhaustion; new subscribers get 503 past it.
 * Sized for the 5000-agent launch with headroom (one socket per worker).
 */
export const JOB_FEED_MAX_SUBSCRIBERS = 10_000;

export function createJobFeed(): JobFeed {
  // sender -> bound wallet (checksummed) or null for public-only.
  const senders = new Map<FeedSender, string | null>();

  const serialize = (payload: unknown): string | null => {
    try {
      return JSON.stringify(payload);
    } catch {
      return null;
    }
  };

  const deliver = (sender: FeedSender, event: JobFeedEvent, data: string) => {
    try {
      sender(event, data);
    } catch {
      senders.delete(sender);
    }
  };

  return {
    subscribe(sender: FeedSender, wallet?: Address | null): () => void {
      senders.set(sender, wallet ?? null);
      return () => {
        senders.delete(sender);
      };
    },
    broadcast(event: JobFeedEvent, payload: unknown): void {
      const data = serialize(payload);
      if (data === null) return;
      for (const sender of senders.keys()) {
        deliver(sender, event, data);
      }
    },
    sendTo(wallet: Address, event: JobFeedEvent, payload: unknown): void {
      const data = serialize(payload);
      if (data === null) return;
      const target = wallet.toLowerCase();
      for (const [sender, bound] of senders) {
        if (bound !== null && bound.toLowerCase() === target) {
          deliver(sender, event, data);
        }
      }
    },
    get subscriberCount(): number {
      return senders.size;
    },
  };
}
