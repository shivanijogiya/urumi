// Login throttling end to end, against a real Postgres. verifyPassword is wrapped in a spy (the
// real function still runs) to prove that throttled attempts never reach scrypt.
import { ErrorEnvelopeSchema } from '@urumi/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IP_MAX_FAILURES, MAX_FAILURES } from '../src/auth/login-limiter.js';
import { verifyPassword } from '../src/auth/password.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';

vi.mock('../src/auth/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/password.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

let t: TestApp;
afterEach(async () => {
  await t.close();
});

function login(body: object, opts: { ip?: string; headers?: Record<string, string> } = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: body,
    headers: opts.headers,
    remoteAddress: opts.ip ?? '127.0.0.1',
  });
}

describe('login throttle', () => {
  it('20 parallel wrong-password logins reach scrypt at most 10 times, all 401', async () => {
    t = await setupApp();
    vi.mocked(verifyPassword).mockClear();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        login({ email: ADMIN.email, password: `wrong-${i}` }, { ip: `10.1.0.${i}` }),
      ),
    );
    for (const res of results) {
      expect(res.statusCode).toBe(401);
      expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe('UNAUTHENTICATED');
    }
    expect(vi.mocked(verifyPassword).mock.calls.length).toBeLessThanOrEqual(MAX_FAILURES);
    // Still locked afterwards, even with the right password.
    expect((await login(ADMIN, { ip: '10.1.1.1' })).statusCode).toBe(401);
  });

  it('20 parallel wrong current-password changes reach scrypt at most 10 times, all 400', async () => {
    t = await setupApp();
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    vi.mocked(verifyPassword).mockClear();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.request('POST', '/api/auth/password', {
          cookie,
          body: { currentPassword: `wrong-${i}`, newPassword: 'a-long-new-password' },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(400));
    expect(vi.mocked(verifyPassword).mock.calls.length).toBeLessThanOrEqual(MAX_FAILURES);
  });

  it('limits failures per client IP, so one client cannot spray many emails', async () => {
    t = await setupApp();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      const res = await login(
        { email: `spray-${i}@example.com`, password: 'x' },
        { ip: '10.0.0.1' },
      );
      expect(res.statusCode).toBe(401);
    }
    vi.mocked(verifyPassword).mockClear();
    expect((await login(ADMIN, { ip: '10.0.0.1' })).statusCode).toBe(401);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect((await login(ADMIN, { ip: '10.0.0.2' })).statusCode).toBe(200);
  });

  it('successful logins do not use up the per-IP allowance', async () => {
    t = await setupApp();
    for (let i = 0; i < IP_MAX_FAILURES + 5; i++) {
      expect((await login(ADMIN, { ip: '10.0.0.3' })).statusCode).toBe(200);
    }
  });

  it('uses X-Forwarded-For as the client IP when trustProxy is on', async () => {
    t = await setupApp({ trustProxy: true });
    const via = (ip: string) => ({ ip: '10.42.0.5', headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      await login({ email: `spray-${i}@example.com`, password: 'x' }, via('203.0.113.1'));
    }
    expect((await login(ADMIN, via('203.0.113.1'))).statusCode).toBe(401);
    expect((await login(ADMIN, via('203.0.113.2'))).statusCode).toBe(200);
  });
});
