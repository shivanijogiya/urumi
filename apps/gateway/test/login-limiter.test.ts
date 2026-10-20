import { describe, expect, it } from 'vitest';
import { LoginLimiter, MAX_FAILURES, WINDOW_MS } from '../src/auth/login-limiter.js';

describe('LoginLimiter', () => {
  it('tryAcquire admits 10 attempts per key, synchronously, then refuses', () => {
    const limiter = new LoginLimiter();
    const results = Array.from({ length: 20 }, () => limiter.tryAcquire('a@example.com'));
    expect(results.filter(Boolean)).toHaveLength(MAX_FAILURES);
    expect(results.slice(0, MAX_FAILURES).every(Boolean)).toBe(true);
    expect(limiter.isBlocked('a@example.com')).toBe(true);
    expect(limiter.tryAcquire('b@example.com')).toBe(true);
  });

  it('unblocks when the 15-minute window ends', () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < MAX_FAILURES; i++) limiter.tryAcquire('a@example.com');
    expect(limiter.tryAcquire('a@example.com')).toBe(false);
    now += WINDOW_MS - 1;
    expect(limiter.isBlocked('a@example.com')).toBe(true);
    now += 1;
    expect(limiter.isBlocked('a@example.com')).toBe(false);
    expect(limiter.tryAcquire('a@example.com')).toBe(true);
  });

  it('recordSuccess clears the count; release gives back one attempt', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_FAILURES; i++) limiter.tryAcquire('a@example.com');
    limiter.recordSuccess('a@example.com');
    expect(limiter.isBlocked('a@example.com')).toBe(false);

    for (let i = 0; i < MAX_FAILURES; i++) limiter.tryAcquire('b@example.com');
    limiter.release('b@example.com');
    expect(limiter.tryAcquire('b@example.com')).toBe(true);
    expect(limiter.tryAcquire('b@example.com')).toBe(false);
  });

  it('a flood of new keys cannot evict a blocked key or one with 2+ failures', () => {
    const limiter = new LoginLimiter({ maxEntries: 4 });
    for (let i = 0; i < MAX_FAILURES; i++) limiter.tryAcquire('target@example.com');
    limiter.tryAcquire('warm@example.com');
    limiter.tryAcquire('warm@example.com');
    for (let i = 0; i < 1000; i++) limiter.tryAcquire(`flood-${i}@example.com`);
    expect(limiter.isBlocked('target@example.com')).toBe(true);
    for (let i = 0; i < MAX_FAILURES - 2; i++) {
      expect(limiter.tryAcquire('warm@example.com')).toBe(true);
    }
    expect(limiter.tryAcquire('warm@example.com')).toBe(false);
  });

  it('when full of entries it may not evict, it refuses new keys (fails closed)', () => {
    const limiter = new LoginLimiter({ maxEntries: 2 });
    for (const key of ['a', 'b']) {
      limiter.tryAcquire(key);
      limiter.tryAcquire(key);
    }
    expect(limiter.tryAcquire('c')).toBe(false);
    expect(limiter.tryAcquire('a')).toBe(true);
  });

  it('honours a custom maxFailures (used for the per-IP limiter)', () => {
    const limiter = new LoginLimiter({ maxFailures: 3 });
    expect([1, 2, 3, 4].map(() => limiter.tryAcquire('10.0.0.1'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
