/*
 * A per-remote limiter for FAILED requests on the LAN print API.
 *
 * Why failures only. A till behind NAT shares one remote address with every other device in the
 * venue, so counting requests would punish the venue for being busy. Counting failures punishes
 * someone for being wrong. A request that authenticates never adds to the count.
 *
 * What it does: after `limit` failures from one address inside a window, that address gets
 * `429 rate_limited` with `Retry-After` for the next block period, without the Bridge reading the
 * body or checking a signature. What it does NOT do: lock out an address that is succeeding. An
 * address that had a request authenticate within `graceMs` keeps being served (and verified) even
 * while over the limit, because the likeliest reason for failures there is a stale device next to
 * a working till. The price: an attacker who shares an address with a till that is printing is not
 * throttled by this. That is deliberate. This limiter is noise and CPU control, not authentication;
 * every request is still individually verified.
 *
 * Memory is bounded: at most `cap` addresses are tracked, least recently seen evicted first.
 */

export const FAILURE_LIMIT_PER_MINUTE = 30;
export const FAILURE_WINDOW_MS = 60_000;
export const FAILURE_BLOCK_MS = 60_000;
/** How long a successful request keeps its address exempt from blocking. */
export const SUCCESS_GRACE_MS = 5 * 60_000;
export const TRACKED_REMOTES_CAP = 4_096;

interface Entry {
  windowStart: number;
  failures: number;
  blockedUntil: number;
  lastSuccess: number;
}

export interface FailureLimiterOptions {
  limit?: number;
  windowMs?: number;
  blockMs?: number;
  graceMs?: number;
  cap?: number;
  now?: () => number;
}

/** IPv4-mapped IPv6 (`::ffff:192.168.1.5`) and plain IPv4 are the same device. */
export function normalizeRemote(address: string | undefined): string {
  if (!address) return 'unknown';
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return (m ? (m[1] as string) : address).toLowerCase();
}

export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly graceMs: number;
  private readonly cap: number;
  private readonly now: () => number;

  constructor(o: FailureLimiterOptions = {}) {
    this.limit = o.limit ?? FAILURE_LIMIT_PER_MINUTE;
    this.windowMs = o.windowMs ?? FAILURE_WINDOW_MS;
    this.blockMs = o.blockMs ?? FAILURE_BLOCK_MS;
    this.graceMs = o.graceMs ?? SUCCESS_GRACE_MS;
    this.cap = o.cap ?? TRACKED_REMOTES_CAP;
    this.now = o.now ?? Date.now;
  }

  /** Seconds this address must wait, or 0 when it may proceed. Read-only apart from forgetting the expired. */
  retryAfter(remote: string): number {
    const e = this.entries.get(remote);
    if (!e) return 0;
    const t = this.now();
    if (e.blockedUntil <= t) return 0;
    // A recently authenticated address is never refused here; see the file comment.
    if (t - e.lastSuccess <= this.graceMs) return 0;
    return Math.max(1, Math.ceil((e.blockedUntil - t) / 1000));
  }

  /** A request from `remote` failed authentication (or a pairing attempt failed). Returns true if this one tripped the block. */
  failure(remote: string): boolean {
    const t = this.now();
    const e = this.touch(remote, t);
    if (t - e.windowStart >= this.windowMs) {
      e.windowStart = t;
      e.failures = 0;
    }
    e.failures += 1;
    if (e.failures >= this.limit && e.blockedUntil <= t) {
      e.blockedUntil = t + this.blockMs;
      return true;
    }
    return false;
  }

  /**
   * A request from `remote` authenticated. It adds nothing to the failure count; it earns the grace.
   * Recorded for every address, not only ones that have failed: the till that was printing a minute
   * ago must still be recognised as succeeding when a neighbour starts failing.
   */
  success(remote: string): void {
    this.touch(remote, this.now()).lastSuccess = this.now();
  }

  get size(): number {
    return this.entries.size;
  }

  private touch(remote: string, t: number): Entry {
    let e = this.entries.get(remote);
    if (e) {
      // Most recently used goes last, so the first key is always the one to evict.
      this.entries.delete(remote);
    } else {
      e = { windowStart: t, failures: 0, blockedUntil: 0, lastSuccess: Number.NEGATIVE_INFINITY };
    }
    this.entries.set(remote, e);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return e;
  }
}
