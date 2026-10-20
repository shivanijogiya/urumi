import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, auditQueryString, setUnauthorizedHandler } from '../src/api.js';
import { admin, upstream } from './fixtures.js';
import { envelope, json, stubApi } from './fetch-stub.js';

describe('api client', () => {
  afterEach(() => setUnauthorizedHandler(() => {}));

  it('parses responses with the contracts schema', async () => {
    stubApi({ 'GET /api/auth/me': json({ user: admin }) });
    await expect(api.me()).resolves.toEqual(admin);
  });

  it('rejects a response that does not match the schema', async () => {
    stubApi({ 'GET /api/auth/me': json({ user: { ...admin, role: 'root' } }) });
    await expect(api.me()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects an upstream carrying an unknown field (strict schema)', async () => {
    const stray = { ...upstream(), credential: { type: 'bearer', value: 's3cret' } };
    stubApi({ 'GET /api/upstreams': json({ upstreams: [stray] }) });
    const err = await api.listUpstreams().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).not.toContain('s3cret');
  });

  it('calls the unauthorized handler on 401', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    stubApi({ 'GET /api/upstreams': envelope(401, 'UNAUTHENTICATED', 'Sign in') });
    await expect(api.listUpstreams()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not treat a failed login as "signed out"', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    stubApi({
      'POST /api/auth/login': envelope(401, 'UNAUTHENTICATED', 'Invalid email or password'),
    });
    await expect(api.login({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({
      message: 'Invalid email or password',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('surfaces the envelope message and code', async () => {
    stubApi({ 'DELETE /api/keys/:id': envelope(409, 'CONFLICT', 'Key already revoked') });
    await expect(api.revokeKey(crypto.randomUUID())).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'Key already revoked',
    });
  });

  it('falls back to a generic message when the error body is not an envelope', async () => {
    stubApi({ 'POST /api/chat': { status: 503, body: 'nope' } });
    await expect(api.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      message: 'Request failed (HTTP 503).',
    });
  });

  it('sends JSON with same-origin credentials on writes, and no body type without a body', async () => {
    const { fetchMock } = stubApi({
      'POST /api/keys': json(
        { key: undefined, secret: undefined }, // shape irrelevant: only the request is checked
      ),
      'DELETE /api/keys/:id': { status: 204 },
    });
    await api.createKey('laptop').catch(() => {});
    await api.revokeKey(crypto.randomUUID());
    const [post, del] = fetchMock.mock.calls.map(([, init]) => init!);
    expect(post!.credentials).toBe('same-origin');
    expect(new Headers(post!.headers).get('content-type')).toBe('application/json');
    expect(post!.body).toBe(JSON.stringify({ name: 'laptop' }));
    expect(new Headers(del!.headers).get('content-type')).toBeNull();
    expect(del!.body).toBeUndefined();
  });

  it('validates request bodies before sending', async () => {
    const { fetchMock } = stubApi({});
    await expect(api.createKey('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the audit query string from non-empty filters', () => {
    const qs = new URLSearchParams(
      auditQueryString({ serverSlug: 'woo', tool: '', outcome: 'error', cursor: 'abc' }),
    );
    expect(Object.fromEntries(qs)).toEqual({
      serverSlug: 'woo',
      outcome: 'error',
      cursor: 'abc',
      limit: '50',
    });
  });
});
