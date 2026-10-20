// In-memory login throttle. Two instances guard every password check:
//   - per email: MAX_FAILURES attempts per WINDOW_MS, cleared by a successful login;
//   - per client IP: IP_MAX_FAILURES failures per WINDOW_MS, so one client cannot spray many
//     emails (or churn the email table). A success gives its own attempt back but does not clear
//     the IP's earlier failures.
//
// tryAcquire() checks and counts in one synchronous step, before the slow scrypt runs, so a
// burst of parallel requests cannot all pass the check before any failure is recorded.
//
// Refusals are answered with the usual 401 UNAUTHENTICATED and the same message as a wrong
// password. The contracts have no 429 code, and an identical answer also hides whether an email is
// throttled (which an attacker could otherwise use to probe for accounts). Unknown emails are
// counted the same way as real ones.
//
// Per process: with several gateway replicas each keeps its own counts, which only loosens the
// limit by the replica count. Good enough for a single-replica deployment.
export const MAX_FAILURES = 10;
export const IP_MAX_FAILURES = 30;
export const WINDOW_MS = 15 * 60 * 1000;
/** Bound on tracked keys, so a flood of random keys cannot grow memory without limit. */
const MAX_ENTRIES = 10_000;

interface Options {
  maxFailures?: number;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class LoginLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: Options = {}) {
    this.maxFailures = opts.maxFailures ?? MAX_FAILURES;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  isBlocked(key: string): boolean {
    const entry = this.live(key);
    return entry !== undefined && entry.count >= this.maxFailures;
  }

  /**
   * Counts one attempt and returns true, or returns false (counting nothing) if the key is
   * blocked. Also false when the table is full of entries that may not be evicted: failing closed
   * keeps a flood of new keys from pushing out the counters of keys under attack.
   */
  tryAcquire(key: string): boolean {
    const entry = this.live(key);
    if (entry) {
      if (entry.count >= this.maxFailures) return false;
      entry.count++;
      return true;
    }
    if (this.entries.size >= this.maxEntries && !this.makeRoom()) return false;
    this.entries.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    return true;
  }

  /** Gives back one attempt (a success that should not count against the key). */
  release(key: string): void {
    const entry = this.live(key);
    if (!entry) return;
    if (--entry.count <= 0) this.entries.delete(key);
  }

  /** Forgets the key's failures. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** The key's entry if its window is still open; expired entries are dropped. */
  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Frees one slot: drops expired entries, else the oldest entry with a single attempt. Entries
   * with two or more attempts (including blocked ones) are never evicted.
   */
  private makeRoom(): boolean {
    const now = this.now();
    let freed = false;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
        freed = true;
      }
    }
    if (freed) return true;
    for (const [key, entry] of this.entries) {
      if (entry.count < 2) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}
