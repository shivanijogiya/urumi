// In-memory login throttle: after MAX_FAILURES failed attempts for one email within WINDOW_MS,
// further attempts for that email are refused until the window ends.
//
// Refusals are answered with the usual 401 UNAUTHENTICATED and the same message as a wrong
// password. The contracts have no 429 code, and an identical answer also hides whether an email is
// throttled (which an attacker could otherwise use to probe for accounts). Unknown emails are
// counted the same way as real ones.
//
// Per process: with several gateway replicas each keeps its own counts, which only loosens the
// limit by the replica count. Good enough for a single-replica deployment.
export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
/** Bound on tracked emails, so a flood of random emails cannot grow memory without limit. */
const MAX_ENTRIES = 10_000;

export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(email: string): boolean {
    const entry = this.failures.get(email);
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.failures.delete(email);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  recordFailure(email: string): void {
    const now = this.now();
    const entry = this.failures.get(email);
    if (entry && entry.resetAt > now) {
      entry.count++;
      return;
    }
    this.failures.delete(email);
    if (this.failures.size >= MAX_ENTRIES) this.prune(now);
    this.failures.set(email, { count: 1, resetAt: now + WINDOW_MS });
  }

  recordSuccess(email: string): void {
    this.failures.delete(email);
  }

  /** Drops expired entries; if still full, the oldest (Map keeps insertion order). */
  private prune(now: number): void {
    for (const [email, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(email);
    }
    while (this.failures.size >= MAX_ENTRIES) {
      this.failures.delete(this.failures.keys().next().value!);
    }
  }
}
