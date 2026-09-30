/**
 * 402 Phase 2 — in-memory replay protection for EIP-3009 nonces.
 *
 * Each authorization nonce may be used at most once. The store is keyed by
 * chain + nonce and entries expire with the authorization (validBefore), so
 * memory stays bounded.
 *
 * v0 limitation: this is per-process memory. A restart, or a second
 * facilitator instance behind a load balancer, forgets used nonces — the
 * onchain `authorizationState` check at settle time is the backstop, but
 * /verify alone cannot catch a replay across restarts. Production should use
 * a shared store (Redis/D1/DynamoDB).
 */
export class NonceStore {
  private used = new Map<string, number>(); // key -> expiry unix seconds

  private key(chainId: number, nonce: string): string {
    return `${chainId}:${nonce.toLowerCase()}`;
  }

  /** True if this nonce was already consumed and has not yet expired. */
  has(chainId: number, nonce: string, nowSec: number): boolean {
    const expiry = this.used.get(this.key(chainId, nonce));
    if (expiry === undefined) return false;
    if (expiry <= nowSec) {
      this.used.delete(this.key(chainId, nonce));
      return false;
    }
    return true;
  }

  /** Record a nonce as consumed until expiresAtSec. */
  mark(chainId: number, nonce: string, expiresAtSec: number): void {
    this.used.set(this.key(chainId, nonce), Number(expiresAtSec));
    // H2 fix: sweep against the ACTUAL current time. Passing the entry's
    // expiry here used to wipe the whole store the moment it hit 10k entries.
    this.sweep(Math.floor(Date.now() / 1000));
  }

  get size(): number {
    return this.used.size;
  }

  private sweep(nowSec: number): void {
    if (this.used.size < 10_000) return;
    for (const [k, expiry] of this.used) {
      if (expiry <= nowSec) this.used.delete(k);
    }
  }
}
