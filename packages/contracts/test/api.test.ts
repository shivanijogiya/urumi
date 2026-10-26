import { describe, expect, it } from 'vitest';
import {
  AuditQuerySchema,
  ChatRequestSchema,
  CreateKeyResponseSchema,
  CreateUpstreamRequestSchema,
  CreateUserRequestSchema,
  LoginRequestSchema,
  ROUTES,
  UpdateUpstreamRequestSchema,
  UpstreamSchema,
} from '../src/index.js';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;
const now = new Date().toISOString();
const uuid = '6f1c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

describe('auth and users', () => {
  it('login lowercases email and requires a password', () => {
    expect(LoginRequestSchema.parse({ email: 'B@Example.com', password: 'x' }).email).toBe(
      'b@example.com',
    );
    expect(ok(LoginRequestSchema, { email: 'not-an-email', password: 'x' })).toBe(false);
    expect(ok(LoginRequestSchema, { email: 'b@example.com', password: '' })).toBe(false);
  });

  it('create user validates role and rejects unknown fields', () => {
    const base = { email: 'm@example.com', name: 'Member', role: 'member' };
    expect(ok(CreateUserRequestSchema, base)).toBe(true);
    expect(ok(CreateUserRequestSchema, { ...base, role: 'owner' })).toBe(false);
    expect(ok(CreateUserRequestSchema, { ...base, password: 'chosen' })).toBe(false);
  });
});

describe('api keys', () => {
  const key = { id: uuid, name: 'laptop', createdAt: now, lastUsedAt: null, revokedAt: null };
  const secret = 'urk_' + Buffer.alloc(32, 7).toString('base64url');

  it('accepts a well-formed create-key response', () => {
    expect(
      ok(CreateKeyResponseSchema, { key: { ...key, prefix: secret.slice(0, 8) }, secret }),
    ).toBe(true);
  });

  it('rejects a secret without the urk_ prefix or of the wrong length', () => {
    const prefix = secret.slice(0, 8);
    expect(ok(CreateKeyResponseSchema, { key: { ...key, prefix }, secret: secret.slice(4) })).toBe(
      false,
    );
    expect(ok(CreateKeyResponseSchema, { key: { ...key, prefix }, secret: secret + 'A' })).toBe(
      false,
    );
  });
});

describe('upstreams', () => {
  const base = { slug: 'woo', name: 'Woo', url: 'http://woo-mcp:3000/mcp' };

  it('defaults enabled to true and accepts bearer/header credentials', () => {
    expect(CreateUpstreamRequestSchema.parse(base).enabled).toBe(true);
    expect(
      ok(CreateUpstreamRequestSchema, { ...base, credential: { type: 'bearer', value: 't' } }),
    ).toBe(true);
    const header = { type: 'header', headerName: 'X-Api-Key', value: 't' };
    expect(ok(CreateUpstreamRequestSchema, { ...base, credential: header })).toBe(true);
  });

  it.each(['file:///etc/passwd', 'ftp://host/x', 'javascript:alert(1)', 'not a url'])(
    'rejects url %j',
    (url) => expect(ok(CreateUpstreamRequestSchema, { ...base, url })).toBe(false),
  );

  it.each(['Host', 'content-length', 'Bad Header', 'x:y', '', 'Transfer-Encoding'])(
    'rejects header name %j',
    (headerName) => {
      const credential = { type: 'header', headerName, value: 't' };
      expect(ok(CreateUpstreamRequestSchema, { ...base, credential })).toBe(false);
    },
  );

  it('rejects credential values containing CR/LF', () => {
    const credential = { type: 'bearer', value: 'a\r\nX-Evil: 1' };
    expect(ok(CreateUpstreamRequestSchema, { ...base, credential })).toBe(false);
  });

  it('update allows credential null (remove) but not changing the slug', () => {
    expect(ok(UpdateUpstreamRequestSchema, { credential: null })).toBe(true);
    expect(ok(UpdateUpstreamRequestSchema, { slug: 'other' })).toBe(false);
  });

  it('upstream response is strict: never carries a credential value', () => {
    const upstream = {
      id: uuid,
      slug: 'woo',
      name: 'Woo',
      enabled: true,
      credentialType: 'bearer',
      hasCredential: true,
      status: 'up',
      lastError: null,
      lastCheckedAt: now,
      lastErrorReason: null,
      lastOkAt: now,
      toolCount: 5,
    };
    expect(ok(UpstreamSchema, upstream)).toBe(true);
    expect(ok(UpstreamSchema, { ...upstream, url: 'http://woo-mcp:3000/mcp' })).toBe(true);
    expect(ok(UpstreamSchema, { ...upstream, value: 'secret' })).toBe(false);
    expect(ok(UpstreamSchema, { ...upstream, credential: { type: 'bearer', value: 's' } })).toBe(
      false,
    );
  });
});

describe('audit query', () => {
  it('coerces limit from the query string and defaults to 50', () => {
    expect(AuditQuerySchema.parse({}).limit).toBe(50);
    expect(AuditQuerySchema.parse({ limit: '200' }).limit).toBe(200);
  });

  it.each(['0', '201', '1.5', 'abc'])('rejects limit %j', (limit) => {
    expect(ok(AuditQuerySchema, { limit })).toBe(false);
  });

  it('validates filters', () => {
    expect(ok(AuditQuerySchema, { outcome: 'timeout', from: now, serverSlug: 'woo' })).toBe(true);
    expect(ok(AuditQuerySchema, { outcome: 'maybe' })).toBe(false);
    expect(ok(AuditQuerySchema, { userId: 'not-a-uuid' })).toBe(false);
  });
});

describe('chat', () => {
  const msg = { role: 'user', content: 'How many orders today?' };

  it('accepts 1–40 messages of up to 8000 chars', () => {
    expect(ok(ChatRequestSchema, { messages: [msg] })).toBe(true);
    expect(ok(ChatRequestSchema, { messages: Array(40).fill(msg) })).toBe(true);
    expect(ok(ChatRequestSchema, { messages: [{ role: 'user', content: 'x'.repeat(8000) }] })).toBe(
      true,
    );
  });

  it('rejects empty, oversized, or system-role conversations', () => {
    expect(ok(ChatRequestSchema, { messages: [] })).toBe(false);
    expect(ok(ChatRequestSchema, { messages: Array(41).fill(msg) })).toBe(false);
    expect(ok(ChatRequestSchema, { messages: [{ role: 'user', content: 'x'.repeat(8001) }] })).toBe(
      false,
    );
    expect(ok(ChatRequestSchema, { messages: [{ role: 'system', content: 'hi' }] })).toBe(false);
  });
});

describe('ROUTES', () => {
  it('has unique method+path pairs and guards admin endpoints', () => {
    const routes = Object.values(ROUTES);
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
    expect(ROUTES.createUpstream.auth).toBe('admin');
    expect(ROUTES.revokeUserKey).toMatchObject({ method: 'DELETE', auth: 'admin' });
    expect(ROUTES.login.auth).toBe('public');
  });
});
