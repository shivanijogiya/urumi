// Dashboard auth against a real Postgres: login, sessions, logout, password change, CSRF, roles.
import { createHash } from 'node:crypto';
import { ErrorEnvelopeSchema, ROUTES, UserResponseSchema, type ErrorCode } from '@urumi/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  PUBLIC_ORIGIN,
  sessionCookie,
  setCookieHeader,
  setupApp,
  tokenOf,
  type TestApp,
} from './helpers/app.js';

let t: TestApp;
beforeEach(async () => {
  t = await setupApp();
});
afterEach(async () => {
  await t.close();
});

function expectError(res: LightMyRequestResponse, status: number, code: ErrorCode) {
  expect(res.statusCode).toBe(status);
  const body = ErrorEnvelopeSchema.parse(res.json());
  expect(body.error.code).toBe(code);
  return body;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
/** Fills `:params` with random uuids. */
const concrete = (path: string) => path.replace(/:\w+/g, () => crypto.randomUUID());

describe('POST /api/auth/login', () => {
  it('signs in with the right password and sets a hardened session cookie', async () => {
    const res = await t.request('POST', '/api/auth/login', {
      body: { email: 'ADMIN@example.com', password: ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
    const { user } = UserResponseSchema.parse(res.json());
    expect(user).toMatchObject({ email: ADMIN.email, role: 'admin', disabledAt: null });

    const cookie = setCookieHeader(res)!;
    expect(cookie).toMatch(/^urumi_session=[A-Za-z0-9_-]{43};/);
    const attrs = cookie.split(';').map((a) => a.trim().toLowerCase());
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('samesite=lax');
    expect(attrs).toContain('path=/');
    expect(attrs).toContain('max-age=43200');
    expect(attrs).not.toContain('secure');
  });

  it('adds Secure when COOKIE_SECURE is on', async () => {
    const secure = await setupApp({ cookieSecure: true });
    try {
      const res = await secure.request('POST', '/api/auth/login', { body: ADMIN });
      expect(
        setCookieHeader(res)!
          .split(';')
          .map((a) => a.trim()),
      ).toContain('Secure');
    } finally {
      await secure.close();
    }
  });

  it('stores only the sha256 of the token, expiring in 12 hours', async () => {
    const token = tokenOf(await t.login(ADMIN.email, ADMIN.password));
    const { rows } = await t.pool.query<{ id: string; row: string; ttl: number }>(
      `SELECT id, row_to_json(s)::text AS row,
              extract(epoch FROM expires_at - created_at)::int AS ttl FROM sessions s`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(sha256hex(token));
    expect(rows[0]!.row).not.toContain(token);
    expect(rows[0]!.ttl).toBe(12 * 3600);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const wrong = await t.request('POST', '/api/auth/login', {
      body: { email: ADMIN.email, password: 'not-the-password' },
    });
    const unknown = await t.request('POST', '/api/auth/login', {
      body: { email: 'nobody@example.com', password: 'not-the-password' },
    });
    expectError(wrong, 401, 'UNAUTHENTICATED');
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.body).toBe(wrong.body);
    expect(setCookieHeader(wrong)).toBeUndefined();
    expect(setCookieHeader(unknown)).toBeUndefined();
  });

  it('rejects a disabled user with the same 401, even with the right password', async () => {
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const { id, tempPassword } = await t.createUser(admin, { email: 'm@example.com' });
    await t.request('PATCH', `/api/users/${id}`, { cookie: admin, body: { disabled: true } });

    const res = await t.request('POST', '/api/auth/login', {
      body: { email: 'm@example.com', password: tempPassword },
    });
    const wrong = await t.request('POST', '/api/auth/login', {
      body: { email: ADMIN.email, password: 'not-the-password' },
    });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(res.body).toBe(wrong.body);
  });

  it('rejects invalid bodies with VALIDATION_FAILED', async () => {
    for (const body of [{}, { email: 'not-an-email', password: 'x' }, { ...ADMIN, extra: 1 }]) {
      expectError(await t.request('POST', '/api/auth/login', { body }), 400, 'VALIDATION_FAILED');
    }
  });

  it('throttles after 10 failed attempts per email (same 401, even with the right password)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await t.request('POST', '/api/auth/login', {
        body: { email: ADMIN.email, password: `wrong-${i}` },
      });
      expect(res.statusCode).toBe(401);
    }
    const locked = await t.request('POST', '/api/auth/login', { body: ADMIN });
    expectError(locked, 401, 'UNAUTHENTICATED');
    expect(setCookieHeader(locked)).toBeUndefined();
  });
});

describe('sessions', () => {
  it('GET /api/auth/me returns the signed-in user', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const res = await t.request('GET', '/api/auth/me', { cookie });
    expect(res.statusCode).toBe(200);
    expect(UserResponseSchema.parse(res.json()).user.email).toBe(ADMIN.email);
  });

  it('rejects missing, unknown and malformed cookies', async () => {
    for (const cookie of [
      undefined,
      `urumi_session=${'A'.repeat(43)}`,
      'urumi_session=',
      'other=1',
    ]) {
      expectError(await t.request('GET', '/api/auth/me', { cookie }), 401, 'UNAUTHENTICATED');
    }
  });

  it('logout deletes the session row and clears the cookie', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const res = await t.request('POST', '/api/auth/logout', { cookie });
    expect(res.statusCode).toBe(204);
    expect(setCookieHeader(res)).toMatch(/^urumi_session=;.*Max-Age=0/i);
    const { rowCount } = await t.pool.query('SELECT 1 FROM sessions');
    expect(rowCount).toBe(0);
    expectError(await t.request('GET', '/api/auth/me', { cookie }), 401, 'UNAUTHENTICATED');
  });

  it('rejects an expired session and deletes its row', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    await t.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expectError(await t.request('GET', '/api/auth/me', { cookie }), 401, 'UNAUTHENTICATED');
    const { rowCount } = await t.pool.query('SELECT 1 FROM sessions');
    expect(rowCount).toBe(0);
  });

  it('rejects the session of a user disabled directly in the database', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    await t.pool.query('UPDATE users SET disabled_at = now()');
    expectError(await t.request('GET', '/api/auth/me', { cookie }), 401, 'UNAUTHENTICATED');
  });
});

describe('POST /api/auth/password', () => {
  it('changes the password and signs out the other sessions only', async () => {
    const mine = await t.login(ADMIN.email, ADMIN.password);
    const other = await t.login(ADMIN.email, ADMIN.password);
    const newPassword = 'a-brand-new-password';
    const res = await t.request('POST', '/api/auth/password', {
      cookie: mine,
      body: { currentPassword: ADMIN.password, newPassword },
    });
    expect(res.statusCode).toBe(204);

    expect((await t.request('GET', '/api/auth/me', { cookie: mine })).statusCode).toBe(200);
    expectError(await t.request('GET', '/api/auth/me', { cookie: other }), 401, 'UNAUTHENTICATED');
    await t.login(ADMIN.email, newPassword);
    const old = await t.request('POST', '/api/auth/login', { body: ADMIN });
    expectError(old, 401, 'UNAUTHENTICATED');
  });

  it('rejects a wrong current password and a short new one', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const wrong = await t.request('POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: 'not-the-password', newPassword: 'long-enough-password' },
    });
    expectError(wrong, 400, 'VALIDATION_FAILED');
    const short = await t.request('POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: ADMIN.password, newPassword: 'short-11ch' },
    });
    expectError(short, 400, 'VALIDATION_FAILED');
    await t.login(ADMIN.email, ADMIN.password);
  });
});

describe('route protection', () => {
  const routes = Object.values(ROUTES);

  it('unauthenticated requests get 401 on every session and admin route', async () => {
    let covered = 0;
    for (const r of routes.filter((r) => r.auth !== 'public')) {
      if (!t.app.hasRoute({ method: r.method, url: r.path })) continue; // owned by a later issue
      const body = r.method === 'POST' || r.method === 'PATCH' ? {} : undefined;
      const res = await t.request(r.method, concrete(r.path), { body });
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(401);
      expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe('UNAUTHENTICATED');
      covered++;
    }
    expect(covered).toBeGreaterThanOrEqual(11);
  });

  it('members get 403 on every admin route', async () => {
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const { tempPassword } = await t.createUser(admin, { email: 'member@example.com' });
    const member = await t.login('member@example.com', tempPassword);
    let covered = 0;
    for (const r of routes.filter((r) => r.auth === 'admin')) {
      if (!t.app.hasRoute({ method: r.method, url: r.path })) continue; // owned by a later issue
      const body = r.method === 'POST' || r.method === 'PATCH' ? {} : undefined;
      const res = await t.request(r.method, concrete(r.path), { cookie: member, body });
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(403);
      expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
      covered++;
    }
    expect(covered).toBeGreaterThanOrEqual(5);
  });

  it('a demoted admin loses admin routes on the next request', async () => {
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const b = await t.createUser(admin, { email: 'b@example.com', role: 'admin' });
    const bCookie = await t.login('b@example.com', b.tempPassword);
    expect((await t.request('GET', '/api/users', { cookie: bCookie })).statusCode).toBe(200);
    await t.request('PATCH', `/api/users/${b.id}`, { cookie: admin, body: { role: 'member' } });
    expectError(await t.request('GET', '/api/users', { cookie: bCookie }), 403, 'FORBIDDEN');
  });
});

describe('CSRF', () => {
  it('rejects a cross-origin POST with 403', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const res = await t.request('POST', '/api/keys', {
      cookie,
      body: { name: 'evil' },
      headers: { origin: 'http://evil.example' },
    });
    expectError(res, 403, 'FORBIDDEN');
    const { rowCount } = await t.pool.query('SELECT 1 FROM api_keys');
    expect(rowCount).toBe(0);
  });

  it('rejects cross-origin PATCH and DELETE, and a cross-origin login', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const headers = { origin: 'null' };
    const id = crypto.randomUUID();
    for (const res of [
      await t.request('PATCH', `/api/users/${id}`, { cookie, body: {}, headers }),
      await t.request('DELETE', `/api/keys/${id}`, { cookie, headers }),
      await t.request('POST', '/api/auth/login', { body: ADMIN, headers }),
    ]) {
      expectError(res, 403, 'FORBIDDEN');
    }
  });

  it('allows the same origin and a request without Origin (curl)', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const same = await t.request('POST', '/api/keys', {
      cookie,
      body: { name: 'same-origin' },
      headers: { origin: PUBLIC_ORIGIN },
    });
    expect(same.statusCode).toBe(201);
    const none = await t.request('POST', '/api/keys', { cookie, body: { name: 'no-origin' } });
    expect(none.statusCode).toBe(201);
  });

  it('requires application/json for state-changing requests with a body', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/keys',
        headers: { cookie, 'content-type': type },
        payload: JSON.stringify({ name: 'form-post' }),
      });
      expectError(res, 403, 'FORBIDDEN');
    }
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { cookie, 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ name: 'json' }),
    });
    expect(ok.statusCode).toBe(201);
  });

  it('allows a cross-origin GET (read-only) but still requires a session', async () => {
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    const res = await t.request('GET', '/api/auth/me', {
      cookie,
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).toBeUndefined();
  });
});
