// OAuth 2.1 for MCP clients (ADR 013) end to end inside the gateway: metadata, Dynamic Client
// Registration, /authorize (PKCE S256, state, resource), consent with the dashboard session
// (CSRF, Deny), /token (single-use code bound to client + redirect + PKCE, refresh rotation with
// reuse detection), /mcp with an access token through the same callTool path (permissions,
// audit attribution), and revocation from the dashboard API. Real Postgres, real SDK client.
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AuditListResponseSchema,
  ConnectedAppListResponseSchema,
  MCP_PATH,
  OAuthRequestInfoSchema,
} from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { s256Challenge } from '../src/oauth/crypto.js';
import { ADMIN, PUBLIC_ORIGIN, setupApp, type TestApp } from './helpers/app.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';

const REDIRECT = 'http://127.0.0.1:43123/callback';
const VERIFIER = 'v'.repeat(20) + 'erifier-0123456789-abcdefghijklmnop';
const CHALLENGE = s256Challenge(VERIFIER);
const RESOURCE = `${PUBLIC_ORIGIN}/mcp`;

let t: TestApp;
let base: string;
let admin: string;
let member: { id: string; cookie: string };
let other: { id: string; cookie: string };
const fakes: FakeUpstream[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  t = await setupApp({
    upstreamAllowedHosts: ['localhost'],
    oauth: { limits: { registerPerIp: { perMinute: 1, burst: 50 } } },
  });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'member@example.com', name: 'Mem Ber' });
  member = { id: m.id, cookie: await t.login('member@example.com', m.tempPassword) };
  const o = await t.createUser(admin, { email: 'other@example.com' });
  other = { id: o.id, cookie: await t.login('other@example.com', o.tempPassword) };
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await t.close();
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
function json(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return t.app.inject({
    method,
    url,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function form(url: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(params).toString(),
  });
}

async function registerClient(
  extra: Record<string, unknown> = {},
): Promise<{ client_id: string; client_secret?: string }> {
  const res = await json('POST', '/oauth/register', {
    client_name: 'Test MCP Client',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function authorizeUrl(clientId: string, over: Record<string, string | undefined> = {}): string {
  const p: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: RESOURCE,
    scope: 'mcp',
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v);
  return `/oauth/authorize?${q}`;
}

/** /authorize → consent page id. */
async function startAuthorize(clientId: string, over: Record<string, string | undefined> = {}) {
  const res = await t.request('GET', authorizeUrl(clientId, over));
  expect(res.statusCode, res.body).toBe(302);
  const loc = String(res.headers.location);
  expect(loc).toMatch(/^\/consent\?request=[A-Za-z0-9_-]{43}$/);
  return loc.split('=')[1]!;
}

async function decide(cookie: string, requestId: string, approve: boolean) {
  const info = await t.request('GET', `/api/oauth/requests/${requestId}`, { cookie });
  expect(info.statusCode, info.body).toBe(200);
  const { consentToken } = OAuthRequestInfoSchema.parse(info.json());
  const res = await t.request('POST', `/api/oauth/requests/${requestId}`, {
    cookie,
    body: { approve, consentToken },
    headers: { origin: PUBLIC_ORIGIN },
  });
  expect(res.statusCode, res.body).toBe(200);
  return new URL((res.json() as { redirectTo: string }).redirectTo);
}

/** Full browser leg: authorize → consent (approve) → code. */
async function getCode(clientId: string, cookie = member.cookie): Promise<string> {
  const redirect = await decide(cookie, await startAuthorize(clientId), true);
  expect(redirect.searchParams.get('state')).toBe('st-123');
  expect(redirect.searchParams.get('iss')).toBe(PUBLIC_ORIGIN);
  return redirect.searchParams.get('code')!;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function exchange(clientId: string, code: string, over: Record<string, string> = {}) {
  return form('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...over,
  });
}

async function tokensFor(clientId: string, cookie = member.cookie): Promise<Tokens> {
  const res = await exchange(clientId, await getCode(clientId, cookie));
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function refresh(clientId: string, refreshToken: string) {
  return form('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
}

function mcpStatus(token: string) {
  return fetch(`${base}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' },
      },
    }),
  }).then((r) => r.status);
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

async function addUpstream(slug: string, tools: string[]) {
  const f = await startFakeUpstream({ identity: slug, tools: tools.map((name) => ({ name })) });
  fakes.push(f);
  const res = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug, name: `Upstream ${slug}`, url: f.url },
  });
  expect(res.statusCode, res.body).toBe(201);
}

// ── metadata ────────────────────────────────────────────────────────────────────────────────
describe('discovery metadata', () => {
  it('serves protected resource metadata (RFC 9728) at both well-known paths', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await t.request('GET', path);
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [PUBLIC_ORIGIN],
        scopes_supported: ['mcp'],
      });
    }
  });

  it('serves authorization server metadata (RFC 8414): S256 only, DCR, refresh', async () => {
    const res = await t.request('GET', '/.well-known/oauth-authorization-server');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      issuer: PUBLIC_ORIGIN,
      authorization_endpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
      token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
      registration_endpoint: `${PUBLIC_ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
    });
  });

  it('401 from /mcp points at the resource metadata', async () => {
    const res = await fetch(`${base}${MCP_PATH}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await fetch(`${base}${MCP_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer uat_${'x'.repeat(43)}` },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('answers CORS preflight for browser-based clients', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/oauth/token',
      headers: { origin: 'http://localhost:6274' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

// ── Dynamic Client Registration ─────────────────────────────────────────────────────────────
describe('dynamic client registration', () => {
  it('registers a public client with loopback and https redirects; no secret', async () => {
    const c = await registerClient({ redirect_uris: [REDIRECT, 'https://client.example.com/cb'] });
    expect(c.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.client_secret).toBeUndefined();
    const { rows } = await t.pool.query('SELECT client_name, secret_hash FROM oauth_clients');
    expect(rows).toEqual([{ client_name: 'Test MCP Client', secret_hash: null }]);
  });

  it('works cross-origin (browser clients) despite the CSRF guard', async () => {
    const res = await json(
      'POST',
      '/oauth/register',
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
      { origin: 'http://localhost:6274' },
    );
    expect(res.statusCode, res.body).toBe(201);
  });

  it.each([
    ['http://evil.example.com/cb'],
    ['javascript:alert(1)'],
    ['https://client.example.com/cb#f'],
    ['cursor://anysphere.cursor-retrieval/oauth/callback'],
  ])('rejects redirect URI %s', async (uri) => {
    const res = await json('POST', '/oauth/register', {
      redirect_uris: [uri],
      token_endpoint_auth_method: 'none',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    expect((await t.pool.query('SELECT 1 FROM oauth_clients')).rowCount).toBe(0);
  });

  it('rejects missing redirect_uris, unknown auth methods and grant types', async () => {
    for (const body of [
      { client_name: 'x' },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' },
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
      { redirect_uris: [REDIRECT], response_types: ['token'] },
    ]) {
      const res = await json('POST', '/oauth/register', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('invalid_client_metadata');
    }
  });

  it('issues a hashed secret to confidential clients and checks it at /token', async () => {
    const c = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
    expect(c.client_secret).toMatch(/^urs_/);
    const { rows } = await t.pool.query<{ secret_hash: Buffer }>(
      'SELECT secret_hash FROM oauth_clients',
    );
    expect(rows[0]!.secret_hash.length).toBe(32);
    const basic = (s: string) => `Basic ${Buffer.from(`${c.client_id}:${s}`).toString('base64')}`;
    const code = await getCode(c.client_id);
    const params = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    };
    // No secret, a wrong secret, or the secret in the body (registered for Basic): invalid_client.
    expect((await form('/oauth/token', { ...params, client_id: c.client_id })).statusCode).toBe(
      401,
    );
    expect((await form('/oauth/token', params, { authorization: basic('nope') })).statusCode).toBe(
      401,
    );
    expect(
      (
        await form('/oauth/token', {
          ...params,
          client_id: c.client_id,
          client_secret: c.client_secret!,
        })
      ).statusCode,
    ).toBe(401);
    const ok = await form('/oauth/token', params, { authorization: basic(c.client_secret!) });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('is rate limited per IP', async () => {
    await t.close();
    t = await setupApp({ oauth: { limits: { registerPerIp: { perMinute: 1, burst: 2 } } } });
    const body = { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
    expect((await json('POST', '/oauth/register', body)).statusCode).toBe(201);
    expect((await json('POST', '/oauth/register', body)).statusCode).toBe(201);
    const third = await json('POST', '/oauth/register', body);
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    // Rate-limited OAuth requests are not audit rows.
    expect((await t.pool.query('SELECT 1 FROM audit_log')).rowCount).toBe(0);
  });
});

// ── /authorize ──────────────────────────────────────────────────────────────────────────────
describe('/oauth/authorize', () => {
  it('never redirects for an unknown client or unregistered redirect_uri (no open redirect)', async () => {
    const c = await registerClient();
    for (const url of [
      authorizeUrl('00000000-0000-4000-8000-000000000000'),
      authorizeUrl(c.client_id, { redirect_uri: 'https://evil.example.com/cb' }),
      authorizeUrl(c.client_id, { redirect_uri: 'http://127.0.0.1:43123/other' }),
      authorizeUrl(c.client_id, { redirect_uri: undefined }),
    ]) {
      const res = await t.request('GET', url);
      expect(res.statusCode, url).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it.each([
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ code_challenge_method: 'plain', code_challenge: VERIFIER }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ scope: 'admin' }, 'invalid_scope'],
    [{ resource: 'http://evil.example.com/mcp' }, 'invalid_target'],
    [{ resource: 'http://app.localtest.me/api' }, 'invalid_target'],
  ])('%o → redirect with error %s and the state', async (over, error) => {
    const c = await registerClient();
    const res = await t.request('GET', authorizeUrl(c.client_id, over));
    expect(res.statusCode).toBe(302);
    const loc = new URL(String(res.headers.location));
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe(error);
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect((await t.pool.query('SELECT 1 FROM oauth_auth_requests')).rowCount).toBe(0);
  });

  it('accepts another loopback port (RFC 8252) and sets anti-framing headers', async () => {
    const c = await registerClient();
    const res = await t.request(
      'GET',
      authorizeUrl(c.client_id, { redirect_uri: 'http://127.0.0.1:50000/callback' }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

// ── consent ─────────────────────────────────────────────────────────────────────────────────
describe('consent', () => {
  it('needs a session, names the client and redirect host, and binds to the first viewer', async () => {
    const c = await registerClient();
    const id = await startAuthorize(c.client_id);
    expect((await t.request('GET', `/api/oauth/requests/${id}`)).statusCode).toBe(401);
    const res = await t.request('GET', `/api/oauth/requests/${id}`, { cookie: member.cookie });
    expect(res.statusCode).toBe(200);
    expect(OAuthRequestInfoSchema.parse(res.json())).toMatchObject({
      client: { id: c.client_id, name: 'Test MCP Client' },
      redirectHost: '127.0.0.1:43123',
      scope: 'mcp',
    });
    // Another signed-in user cannot see or decide it now.
    expect(
      (await t.request('GET', `/api/oauth/requests/${id}`, { cookie: other.cookie })).statusCode,
    ).toBe(404);
  });

  it('CSRF: the decision needs the consent token, JSON and the dashboard Origin', async () => {
    const c = await registerClient();
    const id = await startAuthorize(c.client_id);
    const info = await t.request('GET', `/api/oauth/requests/${id}`, { cookie: member.cookie });
    const { consentToken } = OAuthRequestInfoSchema.parse(info.json());
    const wrongToken = await t.request('POST', `/api/oauth/requests/${id}`, {
      cookie: member.cookie,
      body: { approve: true, consentToken: 'A'.repeat(43) },
    });
    expect(wrongToken.statusCode).toBe(404);
    const crossSite = await t.request('POST', `/api/oauth/requests/${id}`, {
      cookie: member.cookie,
      body: { approve: true, consentToken },
      headers: { origin: 'https://evil.example.com' },
    });
    expect(crossSite.statusCode).toBe(403);
    const formPost = await t.app.inject({
      method: 'POST',
      url: `/api/oauth/requests/${id}`,
      headers: { cookie: member.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `approve=true&consentToken=${consentToken}`,
    });
    expect(formPost.statusCode).toBe(403);
    expect((await t.pool.query('SELECT 1 FROM oauth_grants')).rowCount).toBe(0);
  });

  it('Deny sends access_denied with the state and issues nothing', async () => {
    const c = await registerClient();
    const redirect = await decide(member.cookie, await startAuthorize(c.client_id), false);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('st-123');
    expect(redirect.searchParams.get('code')).toBeNull();
    expect((await t.pool.query('SELECT 1 FROM oauth_grants')).rowCount).toBe(0);
  });

  it('a decided request cannot be decided again', async () => {
    const c = await registerClient();
    const id = await startAuthorize(c.client_id);
    const info = await t.request('GET', `/api/oauth/requests/${id}`, { cookie: member.cookie });
    const { consentToken } = OAuthRequestInfoSchema.parse(info.json());
    const once = { cookie: member.cookie, body: { approve: true, consentToken } };
    expect((await t.request('POST', `/api/oauth/requests/${id}`, once)).statusCode).toBe(200);
    expect((await t.request('POST', `/api/oauth/requests/${id}`, once)).statusCode).toBe(404);
  });
});

// ── /token ──────────────────────────────────────────────────────────────────────────────────
describe('/oauth/token: authorization code', () => {
  it('exchanges a code once for opaque, hashed, short-lived tokens', async () => {
    const c = await registerClient();
    const res = await exchange(c.client_id, await getCode(c.client_id));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const tok = res.json() as Tokens;
    expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(tok.access_token).toMatch(/^uat_[A-Za-z0-9_-]{43}$/);
    expect(tok.refresh_token).toMatch(/^urt_[A-Za-z0-9_-]{43}$/);
    const { rows } = await t.pool.query<{ kind: string; ttl: number; len: number }>(
      `SELECT kind, extract(epoch FROM expires_at - created_at)::int AS ttl, length(token_hash) AS len
       FROM oauth_tokens ORDER BY kind`,
    );
    expect(rows).toEqual([
      { kind: 'access', ttl: 3600, len: 32 },
      { kind: 'refresh', ttl: 30 * 24 * 3600, len: 32 },
    ]);
    // Nothing stores a token in clear text.
    const dump = await t.pool.query(`SELECT row_to_json(x)::text AS j FROM oauth_tokens x`);
    expect(dump.rows.map((r) => r.j).join()).not.toContain(tok.access_token.slice(4));
  });

  it('code reuse fails and revokes what the first exchange issued', async () => {
    const c = await registerClient();
    const code = await getCode(c.client_id);
    const first = (await exchange(c.client_id, code)).json() as Tokens;
    expect(await mcpStatus(first.access_token)).toBe(200);
    const again = await exchange(c.client_id, code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
    expect(await mcpStatus(first.access_token)).toBe(401);
    expect((await refresh(c.client_id, first.refresh_token)).statusCode).toBe(400);
    const { rows } = await t.pool.query('SELECT revoke_reason FROM oauth_grants');
    expect(rows).toEqual([{ revoke_reason: 'code_reuse' }]);
  });

  it.each([
    [{ code_verifier: 'w'.repeat(43) }, 'PKCE verification failed'],
    [{ code_verifier: '' }, 'PKCE verification failed'],
    [{ redirect_uri: 'http://127.0.0.1:43123/other' }, 'redirect_uri does not match'],
  ])('binds the code to PKCE and redirect_uri: %o', async (over, msg) => {
    const c = await registerClient();
    const code = await getCode(c.client_id);
    const res = await exchange(c.client_id, code, over);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(res.json().error_description).toContain(msg);
    // The failed attempt burned the code.
    expect((await exchange(c.client_id, code)).statusCode).toBe(400);
  });

  it('binds the code to its client', async () => {
    const a = await registerClient();
    const b = await registerClient({ client_name: 'Other client' });
    const code = await getCode(a.client_id);
    const res = await exchange(b.client_id, code);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('rejects an expired code (60 s TTL)', async () => {
    const c = await registerClient();
    const code = await getCode(c.client_id);
    const { rows } = await t.pool.query<{ ttl: number }>(
      `SELECT extract(epoch FROM expires_at - now())::int AS ttl FROM oauth_codes`,
    );
    expect(rows[0]!.ttl).toBeGreaterThan(50);
    expect(rows[0]!.ttl).toBeLessThanOrEqual(60);
    await t.pool.query(`UPDATE oauth_codes SET expires_at = now() - interval '1 second'`);
    expect((await exchange(c.client_id, code)).json().error).toBe('invalid_grant');
  });

  it('rejects a resource that is not this server (RFC 8707)', async () => {
    const c = await registerClient();
    const res = await exchange(c.client_id, await getCode(c.client_id), {
      resource: 'https://evil.example.com/mcp',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_target');
  });

  it('rejects unknown clients and grant types', async () => {
    const res = await exchange('00000000-0000-4000-8000-000000000000', 'x');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    const c = await registerClient();
    const cc = await form('/oauth/token', {
      grant_type: 'client_credentials',
      client_id: c.client_id,
    });
    expect(cc.json().error).toBe('unsupported_grant_type');
  });
});

describe('/oauth/token: refresh rotation and reuse detection', () => {
  it('rotates the refresh token; the old one is single use and its reuse revokes the family', async () => {
    const c = await registerClient();
    const t1 = await tokensFor(c.client_id);
    const r2 = await refresh(c.client_id, t1.refresh_token);
    expect(r2.statusCode, r2.body).toBe(200);
    const t2 = r2.json() as Tokens;
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(await mcpStatus(t2.access_token)).toBe(200);

    // Reuse of the rotated-out token: refused, and every token of the grant dies.
    const reuse = await refresh(c.client_id, t1.refresh_token);
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe('invalid_grant');
    expect(await mcpStatus(t2.access_token)).toBe(401);
    expect(await mcpStatus(t1.access_token)).toBe(401);
    expect((await refresh(c.client_id, t2.refresh_token)).statusCode).toBe(400);
    const { rows } = await t.pool.query('SELECT revoke_reason FROM oauth_grants');
    expect(rows).toEqual([{ revoke_reason: 'refresh_reuse' }]);
  });

  it('refresh tokens are bound to their client', async () => {
    const a = await registerClient();
    const b = await registerClient();
    const tok = await tokensFor(a.client_id);
    expect((await refresh(b.client_id, tok.refresh_token)).json().error).toBe('invalid_grant');
  });

  it('an expired access token is refused', async () => {
    const c = await registerClient();
    const tok = await tokensFor(c.client_id);
    await t.pool.query(
      `UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'`,
    );
    expect(await mcpStatus(tok.access_token)).toBe(401);
  });
});

// ── /mcp with an access token ───────────────────────────────────────────────────────────────
describe('/mcp with an OAuth access token', () => {
  it('same path as API keys: permitted tools only, callTool, audit names oauth + client', async () => {
    await addUpstream('alpha', ['read_thing', 'delete_thing']);
    const deny = await t.request('POST', '/api/permissions', {
      cookie: admin,
      body: { role: 'member', serverSlug: 'alpha', tool: 'delete_*', effect: 'deny' },
    });
    expect(deny.statusCode, deny.body).toBe(200);
    const c = await registerClient({ client_name: 'Claude Code (test)' });
    const tok = await tokensFor(c.client_id);
    const client = await connect(tok.access_token);
    const { tools } = await client.listTools();
    const viaApi = await t.request('GET', '/api/tools', { cookie: member.cookie });
    expect(tools.map((x) => x.name).sort()).toEqual(
      (viaApi.json() as { tools: { name: string }[] }).tools.map((x) => x.name).sort(),
    );
    expect(tools.map((x) => x.name)).toContain('alpha__read_thing');
    expect(tools.map((x) => x.name)).not.toContain('alpha__delete_thing');

    const ok = await client.callTool({ name: 'alpha__read_thing', arguments: {} });
    expect(ok.isError).toBeFalsy();
    const denied = await client.callTool({ name: 'alpha__delete_thing', arguments: {} });
    expect(denied.isError).toBe(true);

    const audit = await t.request('GET', '/api/audit', { cookie: member.cookie });
    const items = AuditListResponseSchema.parse(audit.json()).items;
    expect(
      items.map((i) => [i.tool, i.outcome, i.userId, i.authMethod, i.oauthClientName]),
    ).toEqual([
      ['delete_thing', 'denied', member.id, 'oauth', 'Claude Code (test)'],
      ['read_thing', 'ok', member.id, 'oauth', 'Claude Code (test)'],
    ]);
    const { rows } = await t.pool.query('SELECT api_key_id, oauth_grant_id FROM audit_log');
    expect(rows.every((r) => r.api_key_id === null && r.oauth_grant_id !== null)).toBe(true);
  });

  it('API keys keep working and are audited as api_key', async () => {
    await addUpstream('alpha', ['read_thing']);
    const key = await t.request('POST', '/api/keys', {
      cookie: member.cookie,
      body: { name: 'k' },
    });
    const client = await connect((key.json() as { secret: string }).secret);
    await client.callTool({ name: 'alpha__read_thing', arguments: {} });
    const audit = await t.request('GET', '/api/audit', { cookie: member.cookie });
    const [item] = AuditListResponseSchema.parse(audit.json()).items;
    expect([item!.authMethod, item!.oauthClientName]).toEqual(['api_key', null]);
  });

  it('a disabled user’s tokens stop working', async () => {
    const c = await registerClient();
    const tok = await tokensFor(c.client_id);
    expect(await mcpStatus(tok.access_token)).toBe(200);
    const res = await t.request('PATCH', `/api/users/${member.id}`, {
      cookie: admin,
      body: { disabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(await mcpStatus(tok.access_token)).toBe(401);
    expect((await refresh(c.client_id, tok.refresh_token)).statusCode).toBe(400);
  });
});

// ── connected apps + revocation ─────────────────────────────────────────────────────────────
describe('connected apps', () => {
  it('members see and revoke their own; revocation kills access and refresh tokens at once', async () => {
    const c = await registerClient({ client_name: 'Cursor (test)' });
    const tok = await tokensFor(c.client_id);
    await tokensFor(c.client_id, other.cookie);

    const mine = ConnectedAppListResponseSchema.parse(
      (await t.request('GET', '/api/connected-apps', { cookie: member.cookie })).json(),
    ).apps;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      clientName: 'Cursor (test)',
      userId: member.id,
      redirectHosts: ['127.0.0.1:43123'],
    });
    const theirs = ConnectedAppListResponseSchema.parse(
      (await t.request('GET', '/api/connected-apps', { cookie: other.cookie })).json(),
    ).apps[0]!;
    // Someone else's grant is 404 for a member.
    expect(
      (await t.request('DELETE', `/api/connected-apps/${theirs.id}`, { cookie: member.cookie }))
        .statusCode,
    ).toBe(404);

    expect(await mcpStatus(tok.access_token)).toBe(200);
    const del = await t.request('DELETE', `/api/connected-apps/${mine[0]!.id}`, {
      cookie: member.cookie,
    });
    expect(del.statusCode).toBe(204);
    expect(await mcpStatus(tok.access_token)).toBe(401);
    expect((await refresh(c.client_id, tok.refresh_token)).json().error).toBe('invalid_grant');
    const after = (await t.request('GET', '/api/connected-apps', { cookie: member.cookie })).json();
    expect(after.apps).toEqual([]);
  });

  it('admins see everyone’s and can revoke any', async () => {
    const c = await registerClient();
    const tok = await tokensFor(c.client_id);
    const all = ConnectedAppListResponseSchema.parse(
      (await t.request('GET', '/api/connected-apps', { cookie: admin })).json(),
    ).apps;
    expect(all.map((a) => a.userEmail)).toEqual(['member@example.com']);
    expect(
      (await t.request('DELETE', `/api/connected-apps/${all[0]!.id}`, { cookie: admin }))
        .statusCode,
    ).toBe(204);
    expect(await mcpStatus(tok.access_token)).toBe(401);
    const { rows } = await t.pool.query('SELECT revoke_reason FROM oauth_grants');
    expect(rows).toEqual([{ revoke_reason: 'admin' }]);
  });

  it('RFC 7009 revocation of a refresh token revokes the grant', async () => {
    const c = await registerClient();
    const tok = await tokensFor(c.client_id);
    const res = await form('/oauth/revoke', { client_id: c.client_id, token: tok.refresh_token });
    expect(res.statusCode).toBe(200);
    expect(await mcpStatus(tok.access_token)).toBe(401);
  });
});
