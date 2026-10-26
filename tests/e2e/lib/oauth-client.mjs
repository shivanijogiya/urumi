/* global process, URL, fetch */
// D13: the official MCP SDK client signs in with OAuth (ADR 013), as Claude Code / Cursor would,
// given only the gateway's MCP URL. The browser leg (consent page) is played with a dashboard
// session cookie read from a curl cookie jar. Steps the SDK does by itself: 401 → protected
// resource metadata → authorization server metadata → Dynamic Client Registration → /authorize
// with PKCE S256 + state + resource → (consent) → code exchange → MCP with the access token.
//   OAUTH_JAR=<curl cookie jar> OAUTH_STATE=<file> node oauth-client.mjs <mcp url> [tool] [json]
// Writes {client_id, access_token, refresh_token} to OAUTH_STATE (mode 600; never stdout) and
// prints one JSON object: what the SDK sent to /authorize (method, resource; no secrets), the
// tools/list names and, if a tool was given, its CallToolResult.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, tool, rawArgs] = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
const REDIRECT = 'http://127.0.0.1:43913/callback';

function out(value, code = 0) {
  process.stdout.write(JSON.stringify(value) + '\n');
  process.exit(code);
}
if (!url || !process.env.OAUTH_JAR || !process.env.OAUTH_STATE) {
  out(
    { error: { message: 'usage: OAUTH_JAR=… OAUTH_STATE=… oauth-client.mjs <url> [tool] [json]' } },
    2,
  );
}

/** urumi_session=<token> from a Netscape cookie jar written by curl. */
function sessionCookie(jarFile) {
  for (const line of readFileSync(jarFile, 'utf8').split('\n')) {
    const f = line.replace(/^#HttpOnly_/, '').split('\t');
    if (f.length >= 7 && f[5] === 'urumi_session') return `urumi_session=${f[6].trim()}`;
  }
  throw new Error('no urumi_session in the cookie jar');
}

const origin = new URL(url).origin;
const cookie = sessionCookie(process.env.OAUTH_JAR);
const seen = {};

const provider = {
  info: undefined,
  saved: undefined,
  verifier: '',
  code: undefined,
  // The SDK sends `state` only if the provider supplies one; the gateway must pass it back.
  stateValue: randomBytes(16).toString('hex'),
  state() {
    return this.stateValue;
  },
  get redirectUrl() {
    return REDIRECT;
  },
  get clientMetadata() {
    return {
      client_name: 'Urumi e2e (MCP SDK client)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  clientInformation() {
    return this.info;
  },
  saveClientInformation(i) {
    this.info = i;
  },
  tokens() {
    return this.saved;
  },
  saveTokens(t) {
    this.saved = t;
  },
  saveCodeVerifier(v) {
    this.verifier = v;
  },
  codeVerifier() {
    return this.verifier;
  },
  // The browser: /authorize → 302 /consent?request=… → the consent API with the session → code.
  async redirectToAuthorization(authUrl) {
    const p = authUrl.searchParams;
    seen.authorize = {
      endpoint: `${authUrl.origin}${authUrl.pathname}`,
      response_type: p.get('response_type'),
      code_challenge_method: p.get('code_challenge_method'),
      has_code_challenge: !!p.get('code_challenge'),
      has_state: !!p.get('state'),
      resource: p.get('resource'),
      scope: p.get('scope'),
    };
    const res = await fetch(authUrl, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status !== 302 || !loc) throw new Error(`/authorize answered ${res.status}`);
    const consent = new URL(loc, origin);
    seen.consentPage = consent.pathname;
    const id = consent.searchParams.get('request');
    const info = await fetch(`${origin}/api/oauth/requests/${id}`, { headers: { cookie } });
    if (info.status !== 200) throw new Error(`consent GET answered ${info.status}`);
    const body = await info.json();
    seen.consent = { client: body.client.name, redirectHost: body.redirectHost, scope: body.scope };
    const decided = await fetch(`${origin}/api/oauth/requests/${id}`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true, consentToken: body.consentToken }),
    });
    if (decided.status !== 200) throw new Error(`consent POST answered ${decided.status}`);
    const back = new URL((await decided.json()).redirectTo);
    seen.stateRoundTrip =
      p.get('state') === this.stateValue && back.searchParams.get('state') === this.stateValue;
    seen.iss = back.searchParams.get('iss');
    this.code = back.searchParams.get('code');
  },
};

try {
  const mcpUrl = new URL(url);
  const first = new Client({ name: 'urumi-e2e-oauth', version: '0.1.0' });
  try {
    await first.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }), {
      timeout: TIMEOUT_MS,
    });
    throw new Error('connected without signing in');
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }
  if (!provider.code) throw new Error('no authorization code');
  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  await transport.finishAuth(provider.code);
  writeFileSync(
    process.env.OAUTH_STATE,
    JSON.stringify({
      client_id: provider.info.client_id,
      access_token: provider.saved.access_token,
      refresh_token: provider.saved.refresh_token,
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: 'urumi-e2e-oauth', version: '0.1.0' });
  await client.connect(transport, { timeout: TIMEOUT_MS });
  const { tools } = await client.listTools(undefined, { timeout: TIMEOUT_MS });
  const result = tool
    ? await client.callTool(
        { name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} },
        undefined,
        {
          timeout: TIMEOUT_MS,
        },
      )
    : undefined;
  await client.close();
  out({
    ...seen,
    clientIdIssued: !!provider.info.client_id,
    tokenType: provider.saved.token_type,
    expiresIn: provider.saved.expires_in,
    tools: tools.map((t) => t.name),
    ...(result ? { result } : {}),
  });
} catch (err) {
  const status = typeof err?.code === 'number' && err.code >= 100 ? err.code : null;
  out({ ...seen, error: { status, message: String(err?.message ?? err).slice(0, 300) } }, 2);
}
