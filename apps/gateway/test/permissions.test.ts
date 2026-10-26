// Tool permissions (ADR 008) end to end inside the gateway: the seeded default policy, the admin
// API, and enforcement on every path — MCP tools/list + tools/call, GET /api/tools,
// GET /api/upstreams/:id/tools and the chat agent's tool set + tool calls. Real Postgres, real fake
// MCP upstreams (slugs woo/everything as in the cluster), the SDK client over HTTP; only the
// Anthropic boundary is scripted.
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ChatResponseSchema,
  ErrorEnvelopeSchema,
  MCP_PATH,
  PermissionListResponseSchema,
  PermissionResponseSchema,
} from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnthropicLike } from '../src/chat/anthropic.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';

const WOO_TOOLS = [
  'list_products',
  'create_product',
  'list_orders',
  'get_order',
  'update_order_status',
];

let t: TestApp;
let base: string;
let admin: string;
let member: { id: string; cookie: string };
let anthropicRequests: Anthropic.MessageCreateParamsNonStreaming[];
let script: (call: number) => Anthropic.Message;
const fakes: Record<string, FakeUpstream> = {};
const upstreamIds: Record<string, string> = {};
const clients: Client[] = [];

const anthropic: AnthropicLike = {
  messages: {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      anthropicRequests.push(structuredClone(params));
      return script(anthropicRequests.length - 1);
    },
  },
} as unknown as AnthropicLike;

function message(content: unknown[], stop_reason: Anthropic.StopReason = 'end_turn') {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}

beforeEach(async () => {
  anthropicRequests = [];
  t = await setupApp(
    { upstreamAllowedHosts: ['localhost'], mcpTimeouts: { callMs: 1000 }, chat: { anthropic } },
    { toolPermissions: 'seeded' },
  );
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  admin = await t.login(ADMIN.email, ADMIN.password);
  const m = await t.createUser(admin, { email: 'm@example.com' });
  member = { id: m.id, cookie: await t.login('m@example.com', m.tempPassword) };
  for (const [slug, tools] of [
    ['woo', WOO_TOOLS],
    ['everything', ['echo', 'get-env']],
    ['newsrv', ['list_things']],
  ] as const) {
    const f = await startFakeUpstream({ identity: slug, tools: tools.map((name) => ({ name })) });
    fakes[slug] = f;
    const res = await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug, name: slug, url: f.url },
    });
    expect(res.statusCode, res.body).toBe(201);
    upstreamIds[slug] = (res.json() as { upstream: { id: string } }).upstream.id;
  }
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(Object.values(fakes).map((f) => f.stop()));
  await t.close();
});

async function connect(cookie: string): Promise<Client> {
  const res = await t.request('POST', '/api/keys', { cookie, body: { name: 'k' } });
  expect(res.statusCode).toBe(201);
  const secret = (res.json() as { secret: string }).secret;
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  clients.push(client);
  return client;
}

const names = async (c: Client) => (await c.listTools()).tools.map((x) => x.name).sort();

function errorCodeOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { text: string }[];
  return ErrorEnvelopeSchema.parse(JSON.parse(content[0]!.text)).error.code;
}

async function auditRows() {
  const { rows } = await t.pool.query<{
    user_id: string;
    source: string;
    server_slug: string;
    tool: string;
    outcome: string;
    error_code: string | null;
  }>('SELECT user_id, source, server_slug, tool, outcome, error_code FROM audit_log ORDER BY id');
  return rows;
}

async function setRule(body: Record<string, unknown>) {
  const res = await t.request('POST', '/api/permissions', { cookie: admin, body });
  expect(res.statusCode, res.body).toBe(200);
  return PermissionResponseSchema.parse(res.json()).rule;
}

describe('default policy over MCP', () => {
  it('a member sees only the read-only tools; new upstreams are admin-only', async () => {
    expect(await names(await connect(member.cookie))).toEqual([
      'everything__echo',
      'woo__get_order',
      'woo__list_orders',
      'woo__list_products',
    ]);
  });

  it('an admin sees every tool', async () => {
    expect(await names(await connect(admin))).toEqual(
      [
        ...WOO_TOOLS.map((n) => `woo__${n}`),
        'everything__echo',
        'everything__get-env',
        'newsrv__list_things',
      ].sort(),
    );
  });

  it('a member calling a hidden tool directly gets FORBIDDEN, the upstream is never called, and the call is audited as denied', async () => {
    const client = await connect(member.cookie);
    const result = await client.callTool({ name: 'woo__create_product', arguments: { name: 'x' } });
    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe('FORBIDDEN');
    expect((result.content as { text: string }[])[0]!.text).toContain('woo__create_product');
    expect(fakes.woo!.calls).toEqual([]);
    expect(await auditRows()).toEqual([
      {
        user_id: member.id,
        source: 'mcp',
        server_slug: 'woo',
        tool: 'create_product',
        outcome: 'denied',
        error_code: 'FORBIDDEN',
      },
    ]);
  });

  it('a member can still call an allowed tool; an admin can call the restricted one', async () => {
    const m = await connect(member.cookie);
    expect((await m.callTool({ name: 'woo__list_orders', arguments: {} })).isError).toBeFalsy();
    const a = await connect(admin);
    expect((await a.callTool({ name: 'woo__create_product', arguments: {} })).isError).toBeFalsy();
    expect(fakes.woo!.calls.map((c) => c.name)).toEqual(['list_orders', 'create_product']);
    expect((await auditRows()).map((r) => r.outcome)).toEqual(['ok', 'ok']);
  });

  it('a name that is not a well-formed tool name is not echoed back', async () => {
    const client = await connect(member.cookie);
    const result = await client.callTool({ name: 'woo__<script>', arguments: {} });
    expect(errorCodeOf(result)).toBe('FORBIDDEN');
    expect((result.content as { text: string }[])[0]!.text).not.toContain('<script>');
  });
});

describe('dashboard tool lists', () => {
  it('GET /api/tools and GET /api/upstreams/:id/tools are filtered for the caller', async () => {
    const all = await t.request('GET', '/api/tools', { cookie: member.cookie });
    expect((all.json() as { tools: { name: string }[] }).tools.map((x) => x.name)).not.toContain(
      'woo__create_product',
    );
    const woo = await t.request('GET', `/api/upstreams/${upstreamIds.woo}/tools`, {
      cookie: member.cookie,
    });
    expect((woo.json() as { tools: { name: string }[] }).tools.map((x) => x.name).sort()).toEqual([
      'woo__get_order',
      'woo__list_orders',
      'woo__list_products',
    ]);
    const asAdmin = await t.request('GET', `/api/upstreams/${upstreamIds.woo}/tools`, {
      cookie: admin,
    });
    expect((asAdmin.json() as { tools: unknown[] }).tools).toHaveLength(WOO_TOOLS.length);
  });
});

describe('chat uses the same policy', () => {
  it('Claude is offered only allowed tools, and a hallucinated restricted call is denied + audited', async () => {
    script = (call) =>
      call === 0
        ? message(
            [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'woo__create_product',
                input: { name: 'x' },
              },
            ],
            'tool_use',
          )
        : message([{ type: 'text', text: 'not allowed', citations: null }]);
    const res = await t.request('POST', '/api/chat', {
      cookie: member.cookie,
      headers: { origin: 'http://app.localtest.me' },
      body: { messages: [{ role: 'user', content: 'create a product' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const offered = (anthropicRequests[0]!.tools ?? []).map((x) => (x as { name: string }).name);
    expect(offered).toContain('woo__list_orders');
    expect(offered).not.toContain('woo__create_product');
    expect(ChatResponseSchema.parse(res.json()).toolCalls).toEqual([
      expect.objectContaining({
        name: 'woo__create_product',
        outcome: 'denied',
        errorCode: 'FORBIDDEN',
      }),
    ]);
    expect(fakes.woo!.calls).toEqual([]);
    expect(await auditRows()).toEqual([
      expect.objectContaining({ source: 'chat', outcome: 'denied', error_code: 'FORBIDDEN' }),
    ]);
  });
});

describe('admin API', () => {
  it('lists the seeded rules, admin only', async () => {
    const res = await t.request('GET', '/api/permissions', { cookie: admin });
    expect(res.statusCode).toBe(200);
    const { rules } = PermissionListResponseSchema.parse(res.json());
    expect(rules).toContainEqual(
      expect.objectContaining({ role: 'admin', serverSlug: '*', tool: '*', effect: 'allow' }),
    );
    expect(rules).toContainEqual(
      expect.objectContaining({ role: 'member', serverSlug: 'woo', tool: 'list_orders' }),
    );
    for (const [method, url, body] of [
      ['GET', '/api/permissions', undefined],
      ['POST', '/api/permissions', { role: 'member', serverSlug: '*', tool: '*', effect: 'allow' }],
      ['DELETE', `/api/permissions/${rules[0]!.id}`, undefined],
    ] as const) {
      const r = await t.request(method, url, { cookie: member.cookie, body });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await t.request('GET', '/api/permissions')).statusCode).toBe(401);
  });

  it('a per-user grant and a per-user deny take effect on the next request', async () => {
    const client = await connect(member.cookie);
    const grant = await setRule({
      userId: member.id,
      serverSlug: 'woo',
      tool: 'create_product',
      effect: 'allow',
    });
    expect(grant).toMatchObject({ userId: member.id, userEmail: 'm@example.com', role: null });
    await setRule({ userId: member.id, serverSlug: 'woo', tool: 'list_orders', effect: 'deny' });

    const visible = await names(client);
    expect(visible).toContain('woo__create_product');
    expect(visible).not.toContain('woo__list_orders');
    expect(
      (await client.callTool({ name: 'woo__create_product', arguments: {} })).isError,
    ).toBeFalsy();
    expect(errorCodeOf(await client.callTool({ name: 'woo__list_orders', arguments: {} }))).toBe(
      'FORBIDDEN',
    );

    // Another member is not affected by these overrides.
    const m2 = await t.createUser(admin, { email: 'm2@example.com' });
    const other = await connect(await t.login('m2@example.com', m2.tempPassword));
    expect(await names(other)).toContain('woo__list_orders');
    expect(await names(other)).not.toContain('woo__create_product');

    // Deleting the grant hides the tool again.
    const del = await t.request('DELETE', `/api/permissions/${grant.id}`, { cookie: admin });
    expect(del.statusCode).toBe(204);
    expect(await names(client)).not.toContain('woo__create_product');
    expect(
      (await t.request('DELETE', `/api/permissions/${grant.id}`, { cookie: admin })).statusCode,
    ).toBe(404);
  });

  it('upserts by subject + server + tool (same id, new effect)', async () => {
    const a = await setRule({
      role: 'member',
      serverSlug: 'newsrv',
      tool: 'list_*',
      effect: 'allow',
    });
    expect(await names(await connect(member.cookie))).toContain('newsrv__list_things');
    const b = await setRule({
      role: 'member',
      serverSlug: 'newsrv',
      tool: 'list_*',
      effect: 'deny',
    });
    expect(b.id).toBe(a.id);
    expect(b.effect).toBe('deny');
    expect(await names(await connect(member.cookie))).not.toContain('newsrv__list_things');
  });

  it('rejects invalid rules and unknown users', async () => {
    for (const body of [
      { serverSlug: 'woo', tool: 'x', effect: 'allow' },
      { role: 'member', userId: member.id, serverSlug: 'woo', tool: 'x', effect: 'allow' },
      { role: 'member', serverSlug: 'Bad Slug', tool: 'x', effect: 'allow' },
      { role: 'member', serverSlug: 'woo', tool: 'a*b', effect: 'allow' },
      { role: 'member', serverSlug: 'woo', tool: 'x', effect: 'sometimes' },
    ]) {
      const r = await t.request('POST', '/api/permissions', { cookie: admin, body });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const r = await t.request('POST', '/api/permissions', {
      cookie: admin,
      body: {
        userId: '6f1c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
        serverSlug: 'woo',
        tool: 'x',
        effect: 'allow',
      },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('callTool', () => {
  it('denies everything for a disabled or unknown user', async () => {
    await t.request('PATCH', `/api/users/${member.id}`, {
      cookie: admin,
      body: { disabled: true },
    });
    for (const userId of [member.id, '6f1c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f']) {
      await expect(
        t.app.tools.callTool(userId, 'woo__list_orders', {}, { source: 'chat' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(fakes.woo!.calls).toEqual([]);
  });
});
