// Upstream registry against a real Postgres: admin CRUD, member access, encrypted credentials,
// the credential never leaving the server, and the SSRF guard on create and edit.
import { Writable } from 'node:stream';
import {
  ErrorEnvelopeSchema,
  UpstreamListResponseSchema,
  UpstreamResponseSchema,
  type ErrorCode,
  type Upstream,
} from '@urumi/contracts';
import type { UpstreamRow } from '@urumi/contracts/db';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS } from '../src/server.js';
import { credentialHeaders } from '../src/upstreams/decrypt-for-call.js';
import { findUpstreamRow } from '../src/upstreams/repo.js';
import type { LookupFn } from '../src/upstreams/ssrf.js';
import { ADMIN, ENC_KEY, setupApp, type TestApp } from './helpers/app.js';

const SECRET = 'woo-mcp-shared-secret-3f9a1c7e5b';
const OTHER_SECRET = 'replacement-secret-8d2e4f6a0c';
const ALLOWED_HOSTS = ['*.urumi.svc.cluster.local'];
const WOO_URL = 'http://woo-mcp.urumi.svc.cluster.local:8080/mcp';

const DNS: Record<string, string> = {
  'woo-mcp.urumi.svc.cluster.local': '10.43.0.20',
  'api.example.com': '93.184.216.34',
  'internal.example.com': '10.0.0.5',
};
const lookup: LookupFn = async (host) => {
  const address = DNS[host];
  if (!address) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
};

let t: TestApp;
let admin: string;
let member: string;
let logs: string;

beforeEach(async () => {
  logs = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += String(chunk);
      cb();
    },
  });
  t = await setupApp({
    upstreamAllowedHosts: ALLOWED_HOSTS,
    lookup,
    logger: { ...LOGGER_OPTIONS, level: 'trace', stream },
  });
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'member@example.com' });
  member = await t.login('member@example.com', m.tempPassword);
});
afterEach(async () => {
  // Nothing on any route may ever write a credential to the log.
  expect(logs).not.toContain(SECRET);
  expect(logs).not.toContain(OTHER_SECRET);
  await t.close();
});

function expectError(res: LightMyRequestResponse, status: number, code: ErrorCode) {
  expect(res.statusCode, res.body).toBe(status);
  expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe(code);
}

function expectNoSecret(res: LightMyRequestResponse) {
  expect(res.body).not.toContain(SECRET);
  expect(res.body).not.toContain(OTHER_SECRET);
}

async function create(body: Record<string, unknown> = {}): Promise<Upstream> {
  const res = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug: 'woo', name: 'WooCommerce', url: WOO_URL, ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  expectNoSecret(res);
  return UpstreamResponseSchema.parse(res.json()).upstream;
}

async function row(id: string): Promise<UpstreamRow> {
  const r = await findUpstreamRow(t.pool, id);
  expect(r).not.toBeNull();
  return r!;
}

async function upstreamCount(): Promise<number> {
  const { rows } = await t.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM upstreams');
  return rows[0]!.n;
}

describe('admin CRUD', () => {
  it('creates, lists, edits, disables and removes an upstream', async () => {
    const created = await create({ credential: { type: 'bearer', value: SECRET } });
    expect(created).toMatchObject({
      slug: 'woo',
      name: 'WooCommerce',
      url: WOO_URL,
      enabled: true,
      credentialType: 'bearer',
      hasCredential: true,
      status: 'unknown',
      lastError: null,
      lastCheckedAt: null,
      toolCount: 0,
    });

    const list = await t.request('GET', '/api/upstreams', { cookie: admin });
    expect(list.statusCode).toBe(200);
    expectNoSecret(list);
    expect(UpstreamListResponseSchema.parse(list.json()).upstreams).toEqual([created]);

    const edit = await t.request('PATCH', `/api/upstreams/${created.id}`, {
      cookie: admin,
      body: {
        name: 'Woo store',
        url: 'https://api.example.com/mcp',
        enabled: false,
        // A new host needs the credential re-entered (see 'credential on host change').
        credential: { type: 'bearer', value: OTHER_SECRET },
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expectNoSecret(edit);
    expect(UpstreamResponseSchema.parse(edit.json()).upstream).toMatchObject({
      id: created.id,
      slug: 'woo',
      name: 'Woo store',
      url: 'https://api.example.com/mcp',
      enabled: false,
      credentialType: 'bearer',
      hasCredential: true,
    });

    const enable = await t.request('PATCH', `/api/upstreams/${created.id}`, {
      cookie: admin,
      body: { enabled: true },
    });
    expect(UpstreamResponseSchema.parse(enable.json()).upstream.enabled).toBe(true);

    const del = await t.request('DELETE', `/api/upstreams/${created.id}`, { cookie: admin });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    expect(await upstreamCount()).toBe(0);
    expectError(
      await t.request('DELETE', `/api/upstreams/${created.id}`, { cookie: admin }),
      404,
      'NOT_FOUND',
    );
  });

  it('creates without a credential and honours enabled: false', async () => {
    const u = await create({ enabled: false });
    expect(u).toMatchObject({ enabled: false, credentialType: 'none', hasCredential: false });
  });

  it('returns 404 for PATCH/DELETE of an unknown id and 400 for a malformed id', async () => {
    const id = crypto.randomUUID();
    expectError(
      await t.request('PATCH', `/api/upstreams/${id}`, { cookie: admin, body: { name: 'x' } }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await t.request('DELETE', `/api/upstreams/${id}`, { cookie: admin }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await t.request('DELETE', '/api/upstreams/1', { cookie: admin }),
      400,
      'VALIDATION_FAILED',
    );
  });

  it('rejects a duplicate slug with 409', async () => {
    await create();
    const res = await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug: 'woo', name: 'Again', url: 'https://api.example.com/mcp' },
    });
    expectError(res, 409, 'CONFLICT');
    expect(await upstreamCount()).toBe(1);
  });

  it('rejects a slug change (slug is immutable)', async () => {
    const u = await create();
    expectError(
      await t.request('PATCH', `/api/upstreams/${u.id}`, { cookie: admin, body: { slug: 'shop' } }),
      400,
      'VALIDATION_FAILED',
    );
    expect((await row(u.id)).slug).toBe('woo');
  });

  it('validates request bodies', async () => {
    for (const body of [
      {},
      { slug: 'Bad_Slug', name: 'x', url: WOO_URL },
      { slug: 'ok', name: 'x', url: WOO_URL, extra: 1 },
      { slug: 'ok', name: 'x', url: WOO_URL, credential: { type: 'bearer' } },
      {
        slug: 'ok',
        name: 'x',
        url: WOO_URL,
        credential: { type: 'header', headerName: 'Host', value: 'v' },
      },
      { slug: 'ok', name: 'x', url: WOO_URL, credential: { type: 'bearer', value: 'a\r\nb' } },
    ]) {
      expectError(
        await t.request('POST', '/api/upstreams', { cookie: admin, body }),
        400,
        'VALIDATION_FAILED',
      );
    }
    expect(await upstreamCount()).toBe(0);
  });
});

describe('access control', () => {
  it('lets members list upstreams without the url', async () => {
    await create({ credential: { type: 'bearer', value: SECRET } });
    const res = await t.request('GET', '/api/upstreams', { cookie: member });
    expect(res.statusCode).toBe(200);
    expectNoSecret(res);
    const [u] = UpstreamListResponseSchema.parse(res.json()).upstreams;
    expect(u).toBeDefined();
    expect(u).not.toHaveProperty('url');
    expect(res.body).not.toContain('woo-mcp.urumi');
    expect(u).toMatchObject({ slug: 'woo', hasCredential: true, credentialType: 'bearer' });
  });

  it('gives members 403 on every mutation', async () => {
    const u = await create();
    expectError(
      await t.request('POST', '/api/upstreams', {
        cookie: member,
        body: { slug: 'other', name: 'x', url: 'https://api.example.com/' },
      }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await t.request('PATCH', `/api/upstreams/${u.id}`, {
        cookie: member,
        body: { enabled: false },
      }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await t.request('DELETE', `/api/upstreams/${u.id}`, { cookie: member }),
      403,
      'FORBIDDEN',
    );
    expect(await row(u.id)).toMatchObject({ enabled: true });
    expect(await upstreamCount()).toBe(1);
  });

  it('requires a session to list', async () => {
    expectError(await t.request('GET', '/api/upstreams'), 401, 'UNAUTHENTICATED');
  });

  it('applies the CSRF origin check to mutations', async () => {
    expectError(
      await t.request('POST', '/api/upstreams', {
        cookie: admin,
        headers: { origin: 'http://evil.example' },
        body: { slug: 'woo', name: 'x', url: WOO_URL },
      }),
      403,
      'FORBIDDEN',
    );
    expect(await upstreamCount()).toBe(0);
  });
});

describe('credentials', () => {
  it('stores AES-GCM ciphertext bound to the upstream id, never the plaintext', async () => {
    const u = await create({ credential: { type: 'bearer', value: SECRET } });
    const r = await row(u.id);
    expect(r.credential_type).toBe('bearer');
    expect(r.credential_header_name).toBeNull();
    expect(r.credential_iv).toHaveLength(12);
    expect(r.credential_tag).toHaveLength(16);
    expect(Buffer.from(r.credential_ciphertext!).toString('utf8')).not.toContain(SECRET);
    const { rows } = await t.pool.query<{ j: string }>(
      'SELECT row_to_json(u)::text AS j FROM upstreams u',
    );
    expect(rows[0]!.j).not.toContain(SECRET);

    expect(credentialHeaders(r, ENC_KEY)).toEqual({ Authorization: `Bearer ${SECRET}` });
    // Ciphertext copied onto another row does not decrypt (AAD = upstream id).
    expect(() => credentialHeaders({ ...r, id: crypto.randomUUID() }, ENC_KEY)).toThrow();
  });

  it('replaces the credential with a custom header and a new IV', async () => {
    const u = await create({ credential: { type: 'bearer', value: SECRET } });
    const before = await row(u.id);
    const res = await t.request('PATCH', `/api/upstreams/${u.id}`, {
      cookie: admin,
      body: { credential: { type: 'header', headerName: 'X-Woo-Mcp-Secret', value: OTHER_SECRET } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expectNoSecret(res);
    expect(UpstreamResponseSchema.parse(res.json()).upstream).toMatchObject({
      credentialType: 'header',
      hasCredential: true,
    });
    const after = await row(u.id);
    expect(Buffer.from(after.credential_iv!).equals(Buffer.from(before.credential_iv!))).toBe(
      false,
    );
    expect(credentialHeaders(after, ENC_KEY)).toEqual({ 'X-Woo-Mcp-Secret': OTHER_SECRET });
  });

  it('keeps the credential when a PATCH omits it', async () => {
    const u = await create({ credential: { type: 'bearer', value: SECRET } });
    await t.request('PATCH', `/api/upstreams/${u.id}`, {
      cookie: admin,
      body: { name: 'Renamed' },
    });
    expect(credentialHeaders(await row(u.id), ENC_KEY)).toEqual({
      Authorization: `Bearer ${SECRET}`,
    });
  });

  it('removes the credential with credential: null (all columns cleared)', async () => {
    const u = await create({
      credential: { type: 'header', headerName: 'X-Api-Key', value: SECRET },
    });
    const res = await t.request('PATCH', `/api/upstreams/${u.id}`, {
      cookie: admin,
      body: { credential: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(UpstreamResponseSchema.parse(res.json()).upstream).toMatchObject({
      credentialType: 'none',
      hasCredential: false,
    });
    expect(await row(u.id)).toMatchObject({
      credential_type: 'none',
      credential_header_name: null,
      credential_ciphertext: null,
      credential_iv: null,
      credential_tag: null,
    });
    expect(credentialHeaders(await row(u.id), ENC_KEY)).toEqual({});
  });
});

describe('credential on host change', () => {
  const NEW_HOST_URL = 'https://api.example.com/mcp';
  const patch = (id: string, body: Record<string, unknown>) =>
    t.request('PATCH', `/api/upstreams/${id}`, { cookie: admin, body });

  it('rejects a new origin without the credential (400) and leaves the row unchanged', async () => {
    const u = await create({ credential: { type: 'bearer', value: SECRET } });
    const before = await row(u.id);
    for (const url of [
      NEW_HOST_URL, // host
      'https://woo-mcp.urumi.svc.cluster.local:8080/mcp', // scheme
      'http://woo-mcp.urumi.svc.cluster.local:9090/mcp', // port
    ]) {
      const res = await patch(u.id, { url, name: 'Changed' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(ErrorEnvelopeSchema.parse(res.json()).error.message).toBe(
        'Re-enter the credential when changing the upstream host',
      );
    }
    expect(await row(u.id)).toEqual(before);
  });

  it('accepts a new origin with a new credential and stores fresh ciphertext', async () => {
    const u = await create({ credential: { type: 'bearer', value: SECRET } });
    const before = await row(u.id);
    const res = await patch(u.id, {
      url: NEW_HOST_URL,
      credential: { type: 'bearer', value: OTHER_SECRET },
    });
    expect(res.statusCode, res.body).toBe(200);
    expectNoSecret(res);
    const after = await row(u.id);
    expect(after.url).toBe(NEW_HOST_URL);
    expect(Buffer.from(after.credential_ciphertext!)).not.toEqual(
      Buffer.from(before.credential_ciphertext!),
    );
    expect(credentialHeaders(after, ENC_KEY)).toEqual({ Authorization: `Bearer ${OTHER_SECRET}` });
  });

  it('accepts a new origin with credential: null and clears it', async () => {
    const u = await create({ credential: { type: 'header', headerName: 'X-Key', value: SECRET } });
    const res = await patch(u.id, { url: NEW_HOST_URL, credential: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(u.id)).toMatchObject({
      url: NEW_HOST_URL,
      credential_type: 'none',
      credential_header_name: null,
      credential_ciphertext: null,
      credential_iv: null,
      credential_tag: null,
    });
  });

  it('keeps the credential on a path-only change (same origin)', async () => {
    const u = await create({ credential: { type: 'bearer', value: SECRET } });
    const before = await row(u.id);
    // Same origin, different spelling of the host and path.
    const url = 'http://WOO-MCP.urumi.svc.cluster.local:8080/v2/mcp';
    const res = await patch(u.id, { url });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(u.id);
    expect(after.url).toBe(url);
    expect(Buffer.from(after.credential_ciphertext!)).toEqual(
      Buffer.from(before.credential_ciphertext!),
    );
    expect(credentialHeaders(after, ENC_KEY)).toEqual({ Authorization: `Bearer ${SECRET}` });
  });

  it('allows a host change on an upstream without a credential', async () => {
    const u = await create();
    const res = await patch(u.id, { url: NEW_HOST_URL });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(u.id)).toMatchObject({ url: NEW_HOST_URL, credential_type: 'none' });
  });
});

describe('SSRF guard', () => {
  it('rejects a blocked URL on create with 400 SSRF_BLOCKED and writes no row', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost:8080/',
      'http://internal.example.com/mcp',
    ]) {
      const res = await t.request('POST', '/api/upstreams', {
        cookie: admin,
        body: { slug: 'bad', name: 'Bad', url, credential: { type: 'bearer', value: SECRET } },
      });
      expectError(res, 400, 'SSRF_BLOCKED');
      expect(res.body).not.toContain('10.0.0.5');
      expect(res.body).not.toContain('internal.example.com');
    }
    expect(await upstreamCount()).toBe(0);
  });

  it('rejects a blocked URL on edit and leaves the row unchanged', async () => {
    const u = await create();
    expectError(
      await t.request('PATCH', `/api/upstreams/${u.id}`, {
        cookie: admin,
        body: { url: 'http://10.0.0.1/mcp', name: 'Changed' },
      }),
      400,
      'SSRF_BLOCKED',
    );
    expect(await row(u.id)).toMatchObject({ url: WOO_URL, name: 'WooCommerce' });
  });

  it('allows a public host and the allow-listed in-cluster host', async () => {
    await create({ slug: 'public', url: 'https://api.example.com/mcp' });
    await create({ slug: 'woo' });
    expect(await upstreamCount()).toBe(2);
  });
});
