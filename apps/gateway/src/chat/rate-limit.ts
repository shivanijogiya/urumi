// Per-user chat rate limit (#19): at most `max` requests in any sliding `windowMs`, in memory. One
// gateway replica locally and on the VPS, so a shared store is not needed; a restart resets it.
export interface ChatRateLimiterOptions {
  max?: number;
  windowMs?: number;
  now?: () => number;
}

export const CHAT_REQUESTS_PER_MINUTE = 20;

export class ChatRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** userId → start times of the requests still inside the window, oldest first. */
  private readonly hits = new Map<string, number[]>();

  constructor(opts: ChatRateLimiterOptions = {}) {
    this.max = opts.max ?? CHAT_REQUESTS_PER_MINUTE;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Counts a request for `userId`; false (and not counted) if the user is over the limit. */
  tryAcquire(userId: string): boolean {
    const now = this.now();
    this.prune(now);
    const times = this.hits.get(userId) ?? [];
    if (times.length >= this.max) return false;
    times.push(now);
    this.hits.set(userId, times);
    return true;
  }

  /** Drops expired entries, so the map holds only users active in the last window. */
  private prune(now: number): void {
    for (const [userId, times] of this.hits) {
      while (times.length && times[0]! <= now - this.windowMs) times.shift();
      if (!times.length) this.hits.delete(userId);
    }
  }
}
