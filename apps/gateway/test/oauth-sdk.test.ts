// The official MCP SDK client's OAuth flow against the gateway (ADR 013): the client starts with
// only the server URL, gets 401 + resource_metadata, discovers both metadata documents, registers
// itself (DCR), sends the user to /authorize with PKCE S256 and `resource`, and after consent
// exchanges the code and talks MCP with the access token. The "browser" leg (consent page) is
// played with the member's dashboard session.
import { createServer, type AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuditListResponseSchema, OAuthRequestInfoSchema } from '@urumi/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';

let t: TestApp;
let origin: string;
let fake: FakeUpstream;

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

beforeEach(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  t = await setupApp({ publicOrigin: origin, upstreamAllowedHosts: ['localhost'] });
  await t.app.listen({ port, host: '127.0.0.1' });
  fake = await startFakeUpstream({ identity: 'alpha', tools: [{ name: 'read_thing' }] });
});

afterEach(async () => {
  await fake.stop();
  await t.close();
});

class TestProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  code: string | undefined;
  authorizeParams: URLSearchParams | undefined;
  constructor(private readonly cookie: string) {}
  get redirectUrl() {
    return 'http://127.0.0.1:43999/callback';
  }
  get clientMetadata() {
    return {
      client_name: 'SDK test client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tok: OAuthTokens) {
    this.saved = tok;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  /** The browser: follow /authorize to the consent page and approve with the session. */
  async redirectToAuthorization(url: URL) {
    this.authorizeParams = url.searchParams;
    const res = await fetch(url, { redirect: 'manual' });
    const consent = new URL(res.headers.get('location')!, origin);
    const id = consent.searchParams.get('request')!;
    const info = await fetch(`${origin}/api/oauth/requests/${id}`, {
      headers: { cookie: this.cookie },
    });
    const { consentToken, client } = OAuthRequestInfoSchema.parse(await info.json());
    expect(client.name).toBe('SDK test client');
    const decided = await fetch(`${origin}/api/oauth/requests/${id}`, {
      method: 'POST',
      headers: { cookie: this.cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true, consentToken }),
    });
    const back = new URL(((await decided.json()) as { redirectTo: string }).redirectTo);
    expect(back.searchParams.get('state')).toBe(url.searchParams.get('state'));
    this.code = back.searchParams.get('code')!;
  }
}

it('the MCP SDK client signs in with OAuth and calls a tool as the member', async () => {
  const admin = await t.login(ADMIN.email, ADMIN.password);
  const up = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug: 'alpha', name: 'Alpha', url: fake.url },
  });
  expect(up.statusCode, up.body).toBe(201);
  const m = await t.createUser(admin, { email: 'sdk@example.com' });
  const cookie = await t.login('sdk@example.com', m.tempPassword);

  const url = new URL(`${origin}/mcp`);
  const provider = new TestProvider(cookie);
  const first = new Client({ name: 'sdk-oauth', version: '1.0.0' });
  await expect(
    first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })),
  ).rejects.toBeInstanceOf(UnauthorizedError);
  // What the SDK sent to /authorize.
  expect(provider.authorizeParams?.get('code_challenge_method')).toBe('S256');
  expect(provider.authorizeParams?.get('resource')).toBe(`${origin}/mcp`);
  expect(provider.info?.client_id).toMatch(/^[0-9a-f-]{36}$/);

  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await transport.finishAuth(provider.code!);
  expect(provider.saved?.access_token).toMatch(/^uat_/);
  const client = new Client({ name: 'sdk-oauth', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((x) => x.name)).toEqual(['alpha__read_thing']);
  const result = await client.callTool({ name: 'alpha__read_thing', arguments: {} });
  expect(result.isError).toBeFalsy();
  await client.close();

  const audit = await t.request('GET', '/api/audit', { cookie });
  const [row] = AuditListResponseSchema.parse(audit.json()).items;
  expect([row!.userId, row!.tool, row!.authMethod, row!.oauthClientName]).toEqual([
    m.id,
    'read_thing',
    'oauth',
    'SDK test client',
  ]);
});
