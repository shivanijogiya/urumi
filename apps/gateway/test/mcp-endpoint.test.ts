// External MCP endpoint (#15, G2/T2): the real SDK Client over Streamable HTTP against buildApp
// listening on an ephemeral port, real Postgres, real fake MCP upstreams. Bearer key checked on
// every request (stateless), tools aggregated under qualified names, calls through callTool (audit
// row, source 'mcp'), errors as isError tool results, 405 for GET/DELETE, 1 MB body limit, and the
// key never logged.
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorEnvelopeSchema, MCP_PATH } from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS } from '../src/server.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import {
  startFakeUpstream,
  type FakeUpstream,
  type FakeUpstreamOptions,
} from './helpers/fake-upstream.js';

const UPSTREAM_SECRET = 'upstream-credential-9d1e7b33a0';

let t: TestApp;
let base: string;
let admin: string;
let member: { id: string; cookie: string };
let logs: string;
const fakes: FakeUpstream[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  logs = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += String(chunk);
      cb();
    },
  });
  t = await setupApp({
    upstreamAllowedHosts: ['localhost'],
    mcpTimeouts: { callMs: 1000 },
    // The production redaction rules at the most verbose level.
    logger: { ...LOGGER_OPTIONS, level: 'trace', stream },
  });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'm@example.com' });
  member = { id: m.id, cookie: await t.login('m@example.com', m.tempPassword) };
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await t.close();
});

async function addUpstream(
  slug: string,
  opts: Partial<FakeUpstreamOptions> = {},
  extra: Record<string, unknown> = {},
): Promise<{ id: string; fake: FakeUpstream }> {
  const f = await startFakeUpstream({ identity: slug, ...opts });
  fakes.push(f);
  const res = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug, name: `Upstream ${slug}`, url: f.url, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: (res.json() as { upstream: { id: string } }).upstream.id, fake: f };
}

async function createKey(cookie: string): Promise<{ id: string; secret: string }> {
  const res = await t.request('POST', '/api/keys', { cookie, body: { name: 'inspector' } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { key: { id: string }; secret: string };
  return { id: body.key.id, secret: body.secret };
}

/** An SDK client that knows only the gateway URL and the bearer key, as MCP Inspector does. */
async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1.0.0' },
  },
};

/** A raw POST /mcp, as an MCP client would send it. */
function post(authorization: string | undefined, body: unknown = INITIALIZE): Promise<Response> {
  return fetch(`${base}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function expect401(res: Response): Promise<string> {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata="[^"]+"/);
  const text = await res.text();
  expect(ErrorEnvelopeSchema.parse(JSON.parse(text)).error.code).toBe('UNAUTHENTICATED');
  return text;
}

async function auditRows() {
  const { rows } = await t.pool.query<{
    user_id: string;
    api_key_id: string | null;
    source: string;
    server_slug: string;
    tool: string;
    outcome: string;
    error_code: string | null;
  }>('SELECT * FROM audit_log ORDER BY id');
  return rows;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  expect(content[0]!.type).toBe('text');
  return content[0]!.text;
}

describe('a client with only the URL and a key', () => {
  it('lists tools from every enabled upstream under qualified names', async () => {
    await addUpstream('a', { tools: [{ name: 'echo', description: 'Echo back' }] });
    await addUpstream('b', { tools: [{ name: 'search' }, { name: 'get.item' }] });
    const { secret } = await createKey(member.cookie);

    const client = await connect(secret);
    expect(client.getServerVersion()?.name).toBe('urumi-gateway');
    const { tools } = await client.listTools();

    expect(tools.map((x) => x.name)).toEqual(['a__echo', 'b__search', 'b__get_item']);
    expect(tools[0]).toMatchObject({
      name: 'a__echo',
      description: 'Echo back',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    });
  });

  it('calls a tool through callTool: result returned, one audit row with source mcp and the key', async () => {
    const a = await addUpstream('a', { tools: [{ name: 'echo' }] });
    const key = await createKey(member.cookie);
    const client = await connect(key.secret);

    const result = await client.callTool({ name: 'a__echo', arguments: { q: 'hello' } });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({
      server: 'a',
      tool: 'echo',
      args: { q: 'hello' },
    });
    expect(a.fake.calls).toEqual([{ name: 'echo', args: { q: 'hello' } }]);
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        user_id: member.id,
        api_key_id: key.id,
        source: 'mcp',
        server_slug: 'a',
        tool: 'echo',
        outcome: 'ok',
        error_code: null,
      }),
    ]);
  });

  it('treats omitted arguments as an empty object', async () => {
    const a = await addUpstream('a', { tools: [{ name: 'echo' }] });
    const client = await connect((await createKey(member.cookie)).secret);
    const result = await client.callTool({ name: 'a__echo' });
    expect(result.isError).toBeFalsy();
    expect(a.fake.calls).toEqual([{ name: 'echo', args: {} }]);
  });

  it('records last use of the key', async () => {
    await addUpstream('a');
    const key = await createKey(member.cookie);
    await (await connect(key.secret)).listTools();

    // Written in the background: poll briefly.
    let lastUsed: Date | null = null;
    for (let i = 0; i < 50 && !lastUsed; i++) {
      const { rows } = await t.pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM api_keys WHERE id = $1',
        [key.id],
      );
      lastUsed = rows[0]!.last_used_at;
      if (!lastUsed) await new Promise((r) => setTimeout(r, 20));
    }
    expect(lastUsed).toBeInstanceOf(Date);
  });
});

describe('authentication on every request', () => {
  it('rejects a missing, malformed or unknown key with an identical detail-free 401', async () => {
    const { secret } = await createKey(member.cookie);
    const unknown = `urk_${'A'.repeat(43)}`;
    const bodies = [
      await expect401(await post(undefined)),
      await expect401(await post('Bearer garbage')),
      await expect401(await post(`Bearer ${unknown}`)),
      await expect401(await post(`Basic ${Buffer.from(`x:${secret}`).toString('base64')}`)),
      await expect401(await post(secret)),
      await expect401(await post(`bearer ${secret} `)),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(await auditRows()).toEqual([]);
  });

  it('rejects a revoked key', async () => {
    const key = await createKey(member.cookie);
    const res = await t.request('DELETE', `/api/keys/${key.id}`, { cookie: member.cookie });
    expect(res.statusCode, res.body).toBe(204);
    await expect401(await post(`Bearer ${key.secret}`));
  });

  it('rejects the key of a disabled user', async () => {
    const { secret } = await createKey(member.cookie);
    expect((await post(`Bearer ${secret}`)).status).toBe(200);
    const res = await t.request('PATCH', `/api/users/${member.id}`, {
      cookie: admin,
      body: { disabled: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    await expect401(await post(`Bearer ${secret}`));
  });

  it('the SDK client cannot connect with a bad key', async () => {
    await expect(connect(`urk_${'B'.repeat(43)}`)).rejects.toMatchObject({ code: 401 });
  });

  it('revoking a key makes the very next request of a connected client fail (D5)', async () => {
    await addUpstream('a', { tools: [{ name: 'echo' }] });
    const key = await createKey(member.cookie);
    const client = await connect(key.secret);
    expect((await client.callTool({ name: 'a__echo', arguments: {} })).isError).toBeFalsy();

    const res = await t.request('DELETE', `/api/keys/${key.id}`, { cookie: member.cookie });
    expect(res.statusCode, res.body).toBe(204);

    // StreamableHTTPError carries the HTTP status as `code`.
    await expect(client.callTool({ name: 'a__echo', arguments: {} })).rejects.toMatchObject({
      code: 401,
    });
    await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
    // Only the call made before the revocation reached the upstream and the audit log.
    expect(await auditRows()).toHaveLength(1);
  });

  it('authenticates before reading the body', async () => {
    await expect401(await post(undefined, 'not json at all'));
  });
});

describe('HTTP surface', () => {
  it.each(['GET', 'DELETE'])('%s /mcp is 405, Allow: POST', async (method) => {
    const { secret } = await createKey(member.cookie);
    for (const authorization of [undefined, `Bearer ${secret}`]) {
      const res = await fetch(`${base}${MCP_PATH}`, {
        method,
        headers: {
          accept: 'application/json, text/event-stream',
          ...(authorization ? { authorization } : {}),
        },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(ErrorEnvelopeSchema.safeParse(await res.json()).success).toBe(true);
    }
  });

  it('answers JSON (no SSE) and issues no session id', async () => {
    const { secret } = await createKey(member.cookie);
    const res = await post(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('urumi-gateway');
  });

  it('rejects a body over 1 MB without calling any upstream', async () => {
    const a = await addUpstream('a', { tools: [{ name: 'echo' }] });
    const { secret } = await createKey(member.cookie);
    const call = (size: number) => ({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'a__echo', arguments: { q: 'x'.repeat(size) } },
    });

    const tooBig = await post(`Bearer ${secret}`, call(1024 * 1024 + 1));
    expect(tooBig.status).toBeGreaterThanOrEqual(400);
    expect(tooBig.status).toBeLessThan(500);
    expect(ErrorEnvelopeSchema.parse(await tooBig.json()).error.code).toBe('VALIDATION_FAILED');
    expect(a.fake.calls).toHaveLength(0);

    const fits = await post(`Bearer ${secret}`, call(1000 * 1000));
    expect(fits.status).toBe(200);
    expect(a.fake.calls).toHaveLength(1);
  });
});

describe('upstream state', () => {
  it("drops a disabled upstream's tools from the next tools/list (D6)", async () => {
    await addUpstream('a', { tools: [{ name: 'echo' }] });
    const b = await addUpstream('b', { tools: [{ name: 'search' }] });
    const client = await connect((await createKey(member.cookie)).secret);
    expect((await client.listTools()).tools.map((x) => x.name)).toEqual(['a__echo', 'b__search']);

    const res = await t.request('PATCH', `/api/upstreams/${b.id}`, {
      cookie: admin,
      body: { enabled: false },
    });
    expect(res.statusCode, res.body).toBe(200);

    expect((await client.listTools()).tools.map((x) => x.name)).toEqual(['a__echo']);
  });

  it('surfaces an upstream failure as an isError result with the error envelope, no URL or credential', async () => {
    const boom = await addUpstream(
      'boom',
      { callFails: 'throw', requireBearer: UPSTREAM_SECRET },
      { credential: { type: 'bearer', value: UPSTREAM_SECRET } },
    );
    const key = await createKey(member.cookie);
    const client = await connect(key.secret);
    expect((await client.listTools()).tools.map((x) => x.name)).toEqual(['boom__search']);

    const result = await client.callTool({ name: 'boom__search', arguments: { q: 'x' } });

    expect(result.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(JSON.parse(textOf(result)));
    expect(envelope.error.code).toBe('UPSTREAM_ERROR');
    const raw = JSON.stringify(result);
    for (const leak of [UPSTREAM_SECRET, boom.fake.url, String(boom.fake.port), 'boom failed']) {
      expect(raw).not.toContain(leak);
    }
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        source: 'mcp',
        api_key_id: key.id,
        outcome: 'error',
        error_code: 'UPSTREAM_ERROR',
      }),
    ]);
  });

  it('answers an unknown tool with a TOOL_NOT_FOUND isError result', async () => {
    const client = await connect((await createKey(member.cookie)).secret);
    const result = await client.callTool({ name: 'nope__missing', arguments: {} });
    expect(result.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(textOf(result))).error.code).toBe('TOOL_NOT_FOUND');
  });

  it('passes an upstream isError result through unchanged', async () => {
    await addUpstream('iserr', { callFails: 'isError' });
    const client = await connect((await createKey(member.cookie)).secret);
    const result = await client.callTool({ name: 'iserr__search', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('tool reported an error');
  });
});

describe('logging', () => {
  it('never writes the Authorization header value', async () => {
    await addUpstream('a', { tools: [{ name: 'echo' }] });
    const key = await createKey(member.cookie);
    const client = await connect(key.secret);
    await client.listTools();
    await client.callTool({ name: 'a__echo', arguments: {} });
    await expect401(await post(`Bearer urk_${'C'.repeat(43)}`));
    await t.request('DELETE', `/api/keys/${key.id}`, { cookie: member.cookie });
    await expect401(await post(`Bearer ${key.secret}`));

    // The capture works (requests to /mcp were logged), and the key is nowhere in it.
    expect(logs).toContain(MCP_PATH);
    expect(logs).not.toContain(key.secret);
    expect(logs).not.toContain(key.secret.slice(4));
    expect(logs).not.toContain('C'.repeat(43));
  });
});
