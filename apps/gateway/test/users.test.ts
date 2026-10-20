// Admin user management against a real Postgres.
import {
  CreateUserResponseSchema,
  ErrorEnvelopeSchema,
  UserListResponseSchema,
  UserResponseSchema,
  type ErrorCode,
} from '@urumi/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';

let t: TestApp;
let admin: string;
beforeEach(async () => {
  t = await setupApp();
  admin = await t.login(ADMIN.email, ADMIN.password);
});
afterEach(async () => {
  await t.close();
});

function expectError(res: LightMyRequestResponse, status: number, code: ErrorCode) {
  expect(res.statusCode).toBe(status);
  expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe(code);
}

async function adminId(): Promise<string> {
  const res = await t.request('GET', '/api/auth/me', { cookie: admin });
  return UserResponseSchema.parse(res.json()).user.id;
}

describe('POST /api/users', () => {
  it('creates a member with a one-time temp password that signs in', async () => {
    const res = await t.request('POST', '/api/users', {
      cookie: admin,
      body: { email: 'New.Member@Example.com', name: '  Member B ', role: 'member' },
    });
    expect(res.statusCode).toBe(201);
    const { user, tempPassword } = CreateUserResponseSchema.parse(res.json());
    expect(user).toMatchObject({
      email: 'new.member@example.com',
      name: 'Member B',
      role: 'member',
      disabledAt: null,
    });
    // 16 random bytes, base64url.
    expect(tempPassword).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // Stored as scrypt, never in plain text.
    const { rows } = await t.pool.query<{ password_hash: string; row: string }>(
      'SELECT password_hash, row_to_json(u)::text AS row FROM users u WHERE id = $1',
      [user.id],
    );
    expect(rows[0]!.row).not.toContain(tempPassword);
    expect(await verifyPassword(tempPassword, rows[0]!.password_hash)).toBe(true);

    // It signs in; once the member changes it, the temp password stops working.
    const member = await t.login('new.member@example.com', tempPassword);
    const change = await t.request('POST', '/api/auth/password', {
      cookie: member,
      body: { currentPassword: tempPassword, newPassword: 'member-chosen-password' },
    });
    expect(change.statusCode).toBe(204);
    const again = await t.request('POST', '/api/auth/login', {
      body: { email: 'new.member@example.com', password: tempPassword },
    });
    expectError(again, 401, 'UNAUTHENTICATED');
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await t.createUser(admin, { email: 'dup@example.com' });
    const res = await t.request('POST', '/api/users', {
      cookie: admin,
      body: { email: 'DUP@example.com', name: 'Again', role: 'member' },
    });
    expectError(res, 409, 'CONFLICT');
  });

  it('rejects invalid input with 400 VALIDATION_FAILED', async () => {
    for (const body of [
      { email: 'x@example.com', name: 'X', role: 'owner' },
      { email: 'nope', name: 'X', role: 'member' },
      { email: 'x@example.com', name: '   ', role: 'member' },
      { email: 'x@example.com', name: 'X', role: 'member', password: 'chosen' },
    ]) {
      expectError(
        await t.request('POST', '/api/users', { cookie: admin, body }),
        400,
        'VALIDATION_FAILED',
      );
    }
  });
});

describe('GET /api/users', () => {
  it('lists users without any password material', async () => {
    const { tempPassword } = await t.createUser(admin, { email: 'm@example.com' });
    const res = await t.request('GET', '/api/users', { cookie: admin });
    expect(res.statusCode).toBe(200);
    const { users } = UserListResponseSchema.parse(res.json());
    expect(users.map((u) => u.email)).toEqual([ADMIN.email, 'm@example.com']);
    expect(res.body).not.toMatch(/password|scrypt/i);
    expect(res.body).not.toContain(tempPassword);
  });
});

describe('PATCH /api/users/:id', () => {
  it('updates name and role', async () => {
    const { id } = await t.createUser(admin, { email: 'm@example.com' });
    const res = await t.request('PATCH', `/api/users/${id}`, {
      cookie: admin,
      body: { name: 'Renamed', role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(UserResponseSchema.parse(res.json()).user).toMatchObject({
      id,
      name: 'Renamed',
      role: 'admin',
    });
  });

  it('disabling sets disabledAt and ends their sessions; enabling clears it', async () => {
    const { id, tempPassword } = await t.createUser(admin, { email: 'm@example.com' });
    const member = await t.login('m@example.com', tempPassword);

    const res = await t.request('PATCH', `/api/users/${id}`, {
      cookie: admin,
      body: { disabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(UserResponseSchema.parse(res.json()).user.disabledAt).not.toBeNull();
    const { rowCount } = await t.pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [id]);
    expect(rowCount).toBe(0);
    expectError(await t.request('GET', '/api/auth/me', { cookie: member }), 401, 'UNAUTHENTICATED');

    const enabled = await t.request('PATCH', `/api/users/${id}`, {
      cookie: admin,
      body: { disabled: false },
    });
    expect(UserResponseSchema.parse(enabled.json()).user.disabledAt).toBeNull();
    await t.login('m@example.com', tempPassword);
  });

  it('an admin cannot demote or disable themselves (409)', async () => {
    const me = await adminId();
    for (const body of [{ role: 'member' }, { disabled: true }]) {
      const res = await t.request('PATCH', `/api/users/${me}`, { cookie: admin, body });
      expectError(res, 409, 'CONFLICT');
    }
    // Renaming yourself is fine.
    const res = await t.request('PATCH', `/api/users/${me}`, {
      cookie: admin,
      body: { name: 'Still admin' },
    });
    expect(UserResponseSchema.parse(res.json()).user).toMatchObject({ role: 'admin' });
  });

  it('never leaves zero active admins, even when two admins demote each other at once', async () => {
    const a = await adminId();
    const b = await t.createUser(admin, { email: 'b@example.com', role: 'admin' });
    const bCookie = await t.login('b@example.com', b.tempPassword);

    const [r1, r2] = await Promise.all([
      t.request('PATCH', `/api/users/${b.id}`, { cookie: admin, body: { role: 'member' } }),
      t.request('PATCH', `/api/users/${a}`, { cookie: bCookie, body: { disabled: true } }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses[0]).toBe(200);
    // The loser is no longer an active admin: signed out (401), not admin (403) or last admin (409).
    expect([401, 403, 409]).toContain(statuses[1]);
    const { rows } = await t.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL",
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('returns 404 for an unknown id and 400 for a malformed one or bad body', async () => {
    expectError(
      await t.request('PATCH', `/api/users/${crypto.randomUUID()}`, {
        cookie: admin,
        body: { name: 'X' },
      }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await t.request('PATCH', '/api/users/not-a-uuid', { cookie: admin, body: { name: 'X' } }),
      400,
      'VALIDATION_FAILED',
    );
    const { id } = await t.createUser(admin, { email: 'm@example.com' });
    for (const body of [{ email: 'x@example.com' }, { role: 'root' }, { disabled: 'yes' }]) {
      expectError(
        await t.request('PATCH', `/api/users/${id}`, { cookie: admin, body }),
        400,
        'VALIDATION_FAILED',
      );
    }
  });
});
