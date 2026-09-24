/**
 * 402 Lounge — in-memory fixed-window rate limiter, keyed per author (and
 * per IP where noted). Same single-process caveat as the facilitator's
 * limiter: fine behind one instance; put a real limiter at the edge for
 * multi-instance deploys.
 */
export interface AuthorBucket {
  windowMs: number;
  max: number;
}

/** Spec'd per-author write buckets. */
export const POST_BUCKET: AuthorBucket = { windowMs: 60_000, max: 1 };
export const COMMENT_BUCKET: AuthorBucket = { windowMs: 60_000, max: 5 };
export const VOTE_BUCKET: AuthorBucket = { windowMs: 60_000, max: 20 };
/** Town chat: snappy but spam-proof — 1 per 5s burst, 60 per hour. */
export const CHAT_BURST_BUCKET: AuthorBucket = { windowMs: 5_000, max: 1 };
export const CHAT_HOURLY_BUCKET: AuthorBucket = { windowMs: 3_600_000, max: 60 };
/** Name claims: 1 per hour per wallet — renames are allowed, not spammable. */
export const NAME_CLAIM_BUCKET: AuthorBucket = { windowMs: 3_600_000, max: 1 };

export class AuthorRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  /**
   * Check-and-increment. Returns true when the action is allowed (and
   * counted), false when the caller must back off. Call only AFTER the
   * request is otherwise valid, so failed attempts don't burn quota.
   */
  take(key: string, bucket: AuthorBucket, nowMs: number = Date.now()): boolean {
    let entry = this.hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      entry = { count: 0, resetAt: nowMs + bucket.windowMs };
      this.hits.set(key, entry);
    }
    if (entry.count >= bucket.max) return false;
    entry.count += 1;
    // Opportunistic cleanup so the map can't grow unbounded.
    if (this.hits.size > 10_000 && Math.random() < 0.01) {
      for (const [k, v] of this.hits) if (v.resetAt <= nowMs) this.hits.delete(k);
    }
    return true;
  }

  /** For tests: how many hits are currently counted for key. */
  count(key: string): number {
    const entry = this.hits.get(key);
    return entry && Date.now() < entry.resetAt ? entry.count : 0;
  }
}
