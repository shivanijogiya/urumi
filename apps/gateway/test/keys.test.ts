// API keys against a real Postgres: create (shown once), list, revoke, and bearer authentication.
import { createHash } from 'node:crypto';
import {
  ApiKeyListResponseSchema,
  CreateKeyResponseSchema,
  ErrorEnvelopeSchema,
  type ErrorCode,
} from '@urumi/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateApiKey, generateApiKey, hashApiKey } from '../src/auth/api-keys.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';

let t: TestApp;
let admin: string;
let member: { id: string; cookie: string };
beforeEach(async () => {
  t = await setupApp();
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'member@example.com' });
  member = { id: m.id, cookie: await t.login('member@example.com', m.tempPassword) };
});
afterEach(async () => {
  await t.close();
});

function expectError(res: LightMyRequestResponse, status: number, code: ErrorCode) {
  expect(res.statusCode).toBe(status);
  expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe(code);
}

async function createKey(cookie: string, name = 'laptop') {
  const res = await t.request('POST', '/api/keys', { cookie, body: { name } });
  expect(res.statusCode).toBe(201);
  return CreateKeyResponseSchema.parse(res.json());
}

describe('generateApiKey / hashApiKey', () => {
  it('makes urk_ + base64url(32 bytes), an 8-char prefix and its sha256', () => {
    const k = generateApiKey();
    expect(k.secret).toMatch(/^urk_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k.secret.slice(4), 'base64url')).toHaveLength(32);
    expect(k.prefix).toBe(k.secret.slice(0, 8));
    expect(k.hash).toEqual(createHash('sha256').update(k.secret).digest());
    expect(hashApiKey(k.secret)).toEqual(k.hash);
    expect(generateApiKey().secret).not.toBe(k.secret);
  });
});

describe('POST /api/keys', () => {
  it('returns the secret once and stores only its sha256', async () => {
    const { key, secret } = await createKey(member.cookie);
    expect(key).toMatchObject({ name: 'laptop', prefix: secret.slice(0, 8), revokedAt: null });

    const { rows } = await t.pool.query<{ key_hash: Buffer; user_id: string; row: string }>(
      'SELECT key_hash, user_id, row_to_json(k)::text AS row FROM api_keys k',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(member.id);
    expect(rows[0]!.key_hash).toEqual(createHash('sha256').update(secret).digest());
    expect(rows[0]!.row).not.toContain(secret);
    expect(rows[0]!.row).not.toContain(secret.slice(8));
    expect(rows[0]!.key_hash.toString('utf8')).not.toContain(secret.slice(8));
  });

  it('validates the name', async () => {
    for (const body of [
      {},
      { name: '' },
      { name: 'x'.repeat(101) },
      { name: 'ok', userId: member.id },
    ]) {
      expectError(
        await t.request('POST', '/api/keys', { cookie: member.cookie, body }),
        400,
        'VALIDATION_FAILED',
      );
    }
  });
});

describe('GET /api/keys', () => {
  it('lists only my keys and never a secret', async () => {
    const mine = await createKey(member.cookie, 'mine');
    const theirs = await createKey(admin, 'admin-key');
    const res = await t.request('GET', '/api/keys', { cookie: member.cookie });
    expect(res.statusCode).toBe(200);
    const { keys } = ApiKeyListResponseSchema.parse(res.json());
    expect(keys.map((k) => k.id)).toEqual([mine.key.id]);
    expect(res.body).not.toContain(mine.secret);
    expect(res.body).not.toContain(mine.secret.slice(8));
    expect(res.body).not.toContain(theirs.key.id);
    expect(Object.keys(keys[0]!).sort()).toEqual(
      ['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt'].sort(),
    );
  });
});

describe('DELETE /api/keys/:id', () => {
  it('revokes my key (204), idempotently, and the key stops working', async () => {
    const { key, secret } = await createKey(member.cookie);
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).not.toBeNull();

    const res = await t.request('DELETE', `/api/keys/${key.id}`, { cookie: member.cookie });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).toBeNull();

    const { rows } = await t.pool.query<{ revoked_at: Date }>('SELECT revoked_at FROM api_keys');
    const first = rows[0]!.revoked_at;
    expect(first).toBeInstanceOf(Date);
    const again = await t.request('DELETE', `/api/keys/${key.id}`, { cookie: member.cookie });
    expect(again.statusCode).toBe(204);
    const after = await t.pool.query<{ revoked_at: Date }>('SELECT revoked_at FROM api_keys');
    expect(after.rows[0]!.revoked_at).toEqual(first);

    const list = ApiKeyListResponseSchema.parse(
      (await t.request('GET', '/api/keys', { cookie: member.cookie })).json(),
    );
    expect(list.keys[0]!.revokedAt).not.toBeNull();
  });

  it("returns 404 for someone else's key (not 403) and leaves it alone", async () => {
    const { key, secret } = await createKey(admin);
    expectError(
      await t.request('DELETE', `/api/keys/${key.id}`, { cookie: member.cookie }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await t.request('DELETE', `/api/keys/${crypto.randomUUID()}`, { cookie: member.cookie }),
      404,
      'NOT_FOUND',
    );
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).not.toBeNull();
  });

  it('rejects a malformed id with 400', async () => {
    expectError(
      await t.request('DELETE', '/api/keys/123', { cookie: member.cookie }),
      400,
      'VALIDATION_FAILED',
    );
  });
});

describe('admin: /api/users/:id/keys', () => {
  it("lists a user's keys and revokes one (204)", async () => {
    const { key, secret } = await createKey(member.cookie);
    const list = await t.request('GET', `/api/users/${member.id}/keys`, { cookie: admin });
    expect(list.statusCode).toBe(200);
    const { keys } = ApiKeyListResponseSchema.parse(list.json());
    expect(keys.map((k) => k.id)).toEqual([key.id]);
    expect(list.body).not.toContain(secret);

    const res = await t.request('DELETE', `/api/users/${member.id}/keys/${key.id}`, {
      cookie: admin,
    });
    expect(res.statusCode).toBe(204);
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).toBeNull();
  });

  it('returns 404 for an unknown user, or a key that belongs to another user', async () => {
    const { key } = await createKey(admin);
    expectError(
      await t.request('GET', `/api/users/${crypto.randomUUID()}/keys`, { cookie: admin }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await t.request('DELETE', `/api/users/${member.id}/keys/${key.id}`, { cookie: admin }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('authenticateApiKey', () => {
  it('returns the user and key id for a valid key and records last use', async () => {
    const { key, secret } = await createKey(member.cookie);
    const auth = await authenticateApiKey(t.pool, `Bearer ${secret}`);
    expect(auth).toMatchObject({ keyId: key.id, user: { id: member.id, role: 'member' } });
    await vi.waitFor(async () => {
      const { rows } = await t.pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [
        key.id,
      ]);
      expect(rows[0].last_used_at).not.toBeNull();
    });
  });

  it('rejects a revoked key, a disabled user, and an unknown key', async () => {
    const { key, secret } = await createKey(member.cookie);
    await t.request('PATCH', `/api/users/${member.id}`, {
      cookie: admin,
      body: { disabled: true },
    });
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).toBeNull();
    await t.request('PATCH', `/api/users/${member.id}`, {
      cookie: admin,
      body: { disabled: false },
    });
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).not.toBeNull();

    await t.pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key.id]);
    expect(await authenticateApiKey(t.pool, `Bearer ${secret}`)).toBeNull();
    expect(await authenticateApiKey(t.pool, `Bearer ${generateApiKey().secret}`)).toBeNull();
  });

  it('rejects malformed headers and wrong prefixes without querying', async () => {
    const { secret } = await createKey(member.cookie);
    const body = secret.slice(4);
    for (const header of [
      undefined,
      '',
      secret,
      `Basic ${secret}`,
      `Bearer  ${secret}`,
      `Bearer ${secret} `,
      `Bearer ${secret}x`,
      `Bearer ${secret.slice(0, -1)}`,
      `Bearer urk-${body}`,
      `Bearer URK_${body}`,
      `Bearer sk_${body}`,
      `Bearer ${body}`,
      `Bearer urk_${body.slice(0, -1)}=`,
      `Bearer ${secret},Bearer ${secret}`,
    ]) {
      expect(await authenticateApiKey(t.pool, header), String(header)).toBeNull();
    }
  });
});
