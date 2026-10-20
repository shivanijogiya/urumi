import { describe, expect, it } from 'vitest';
import { LoginLimiter, MAX_FAILURES, WINDOW_MS } from '../src/auth/login-limiter.js';

describe('LoginLimiter', () => {
  it('blocks an email after 10 failures in 15 minutes and unblocks when the window ends', () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < MAX_FAILURES - 1; i++) limiter.recordFailure('a@example.com');
    expect(limiter.isBlocked('a@example.com')).toBe(false);
    limiter.recordFailure('a@example.com');
    expect(limiter.isBlocked('a@example.com')).toBe(true);
    expect(limiter.isBlocked('b@example.com')).toBe(false);

    now += WINDOW_MS - 1;
    expect(limiter.isBlocked('a@example.com')).toBe(true);
    now += 1;
    expect(limiter.isBlocked('a@example.com')).toBe(false);
  });

  it('a success clears the count', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_FAILURES - 1; i++) limiter.recordFailure('a@example.com');
    limiter.recordSuccess('a@example.com');
    limiter.recordFailure('a@example.com');
    expect(limiter.isBlocked('a@example.com')).toBe(false);
  });
});
