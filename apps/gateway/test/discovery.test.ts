// Discovery mode end to end in-process (ADR 012): a synthetic upstream with 123 tools plus a
// woo-like one; the real SDK client against /mcp?mode=discovery; real Postgres; tool permissions
// as seeded (members read-only); the chat agent with a scripted model switching to discovery
// above the threshold.
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ChatResponseSchema, MCP_PATH } from '@urumi/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnthropicLike } from '../src/chat/anthropic.js';
import { DEFAULT_CHAT_MODEL } from '../src/chat/service.js';
import { ADMIN, PUBLIC_ORIGIN, setupApp, type TestApp } from './helpers/app.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { syntheticTools } from './helpers/synthetic-tools.js';

let t: TestApp;
let base: string;
let admin: string;
const fakes: FakeUpstream[] = [];
const clients: Client[] = [];

type Params = Anthropic.MessageCreateParamsNonStreaming;
class ScriptedAnthropic implements AnthropicLike {
  readonly requests: Params[] = [];
  constructor(private readonly script: (p: Params, call: number) => Anthropic.Message) {}
  readonly messages = {
    create: async (params: Params) => {
      this.requests.push(structuredClone(params));
      return this.script(params, this.requests.length - 1);
    },
  };
}
let seq = 0;
const message = (content: unknown[], stop: Anthropic.StopReason = 'end_turn') =>
  ({
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    model: DEFAULT_CHAT_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as Anthropic.Message;
const toolUse = (name: string, input: unknown) => ({
  type: 'tool_use',
  id: `toolu_${++seq}`,
  name,
  input,
});

async function start(chat?: { anthropic: AnthropicLike; discoveryThreshold?: number }) {
  t = await setupApp(
    { upstreamAllowedHosts: ['localhost'], ...(chat ? { chat } : {}) },
    { toolPermissions: 'seeded' },
  );
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  admin = await t.login(ADMIN.email, ADMIN.password);
  for (const [slug, tools] of [
    ['synth', syntheticTools()],
    [
      'woo',
      [
        { name: 'list_orders', description: 'Lists WooCommerce orders by status and date' },
        { name: 'create_product', description: 'Creates a simple WooCommerce product' },
      ],
    ],
  ] as const) {
    const f = await startFakeUpstream({ identity: slug, tools: [...tools] });
    fakes.push(f);
    const res = await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug, name: slug, url: f.url },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await t.close();
});

async function key(cookie: string): Promise<string> {
  const res = await t.request('POST', '/api/keys', { cookie, body: { name: 'disc' } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { secret: string }).secret;
}

async function connect(secret: string, query = '?mode=discovery', headers = {}): Promise<Client> {
  const client = new Client({ name: 'disc', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}${query}`), {
      requestInit: { headers: { authorization: `Bearer ${secret}`, ...headers } },
    }),
  );
  clients.push(client);
  return client;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe('/mcp discovery mode', () => {
  it('lists two meta-tools; search finds the right tool among 125; call runs and audits the real tool', async () => {
    await start();
    const c = await connect(await key(admin));
    const { tools } = await c.listTools();
    expect(tools.map((x) => x.name)).toEqual(['gateway__search_tools', 'gateway__call_tool']);

    const found = JSON.parse(
      textOf(
        await c.callTool({
          name: 'gateway__search_tools',
          arguments: { query: 'refund a payment', limit: 3 },
        }),
      ),
    ) as { totalTools: number; results: { name: string; inputSchema: { type: string } }[] };
    expect(found.totalTools).toBe(125);
    // Only tools that match are returned (BM25 score > 0): one here.
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.name).toBe('synth__refund_payment');
    expect(found.results[0]!.inputSchema.type).toBe('object');

    const r = await c.callTool({
      name: 'gateway__call_tool',
      arguments: { name: 'synth__refund_payment', arguments: { q: 'order 42' } },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('synth');
    expect(fakes[0]!.calls).toEqual([{ name: 'refund_payment', args: { q: 'order 42' } }]);
    const { rows } = await t.pool.query(
      'SELECT source, server_slug, tool, outcome FROM audit_log ORDER BY id',
    );
    expect(rows).toEqual([
      { source: 'mcp', server_slug: 'synth', tool: 'refund_payment', outcome: 'ok' },
    ]);
  });

  it('the header selects it too; direct mode still lists every tool; an unknown mode is a 400', async () => {
    await start();
    const secret = await key(admin);
    const viaHeader = await connect(secret, '', { 'x-urumi-tool-mode': 'discovery' });
    expect((await viaHeader.listTools()).tools).toHaveLength(2);
    const direct = await connect(secret, '');
    expect((await direct.listTools()).tools.length).toBe(125);
    const res = await fetch(`${base}${MCP_PATH}?mode=everything`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(400);
  });

  it('respects tool permissions: a member neither finds nor calls a restricted tool', async () => {
    await start();
    const m = await t.createUser(admin, { email: 'm@example.com' });
    const cookie = await t.login('m@example.com', m.tempPassword);
    const c = await connect(await key(cookie));
    const found = JSON.parse(
      textOf(
        await c.callTool({
          name: 'gateway__search_tools',
          arguments: { query: 'create a woocommerce product' },
        }),
      ),
    ) as { totalTools: number; results: { name: string }[] };
    // Seeded policy: members get woo read tools only; synth and woo writes are not permitted.
    expect(found.results.map((x) => x.name)).not.toContain('woo__create_product');
    expect(found.results.every((x) => !x.name.startsWith('synth__'))).toBe(true);
    expect(found.totalTools).toBe(1);

    const r = await c.callTool({
      name: 'gateway__call_tool',
      arguments: { name: 'woo__create_product', arguments: { q: 'x' } },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r)).error.code).toBe('FORBIDDEN');
    expect(fakes[1]!.calls).toEqual([]);
    const { rows } = await t.pool.query(
      'SELECT server_slug, tool, outcome, error_code FROM audit_log',
    );
    expect(rows).toEqual([
      { server_slug: 'woo', tool: 'create_product', outcome: 'denied', error_code: 'FORBIDDEN' },
    ]);
  });

  it('rejects bad meta-tool arguments and meta-tool recursion; the gateway slug is reserved', async () => {
    await start();
    const c = await connect(await key(admin));
    for (const [name, args] of [
      ['gateway__search_tools', {}],
      ['gateway__search_tools', { query: 'x', limit: 999 }],
      ['gateway__call_tool', { arguments: {} }],
      ['gateway__call_tool', { name: 'gateway__search_tools', arguments: { query: 'x' } }],
    ] as const) {
      const r = await c.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.parse(textOf(r)).error.code).toBe('VALIDATION_FAILED');
    }
    const res = await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug: 'gateway', name: 'x', url: 'http://localhost:1/mcp' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('chat discovery mode', () => {
  it('above the threshold the model gets the two meta-tools; the reply lists the real tool executed', async () => {
    const model = new ScriptedAnthropic((_p, call) => {
      if (call === 0)
        return message([toolUse('gateway__search_tools', { query: 'refund payment' })], 'tool_use');
      if (call === 1)
        return message(
          [
            toolUse('gateway__call_tool', {
              name: 'synth__refund_payment',
              arguments: { q: 'o-1' },
            }),
          ],
          'tool_use',
        );
      return message([{ type: 'text', text: 'Refunded.', citations: null }]);
    });
    await start({ anthropic: model, discoveryThreshold: 40 });
    const res = await t.request('POST', '/api/chat', {
      cookie: admin,
      headers: { origin: PUBLIC_ORIGIN },
      body: { messages: [{ role: 'user', content: 'Refund order o-1' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = ChatResponseSchema.parse(res.json());
    expect(model.requests[0]!.tools!.map((x) => (x as { name: string }).name)).toEqual([
      'gateway__search_tools',
      'gateway__call_tool',
    ]);
    expect(model.requests[0]!.system).toContain('gateway__search_tools');
    // The search result went back to the model with the right tool on top.
    const searchResult = (model.requests[1]!.messages.at(-1)!.content as { content: string }[])[0]!;
    expect(JSON.parse(searchResult.content).results[0].name).toBe('synth__refund_payment');
    expect(body.toolMode).toBe('discovery');
    expect(body.discoverySearches).toEqual([
      {
        query: 'refund payment',
        resultCount: 1,
        top: ['synth__refund_payment'],
      },
    ]);
    expect(body.toolCalls).toMatchObject([
      { name: 'synth__refund_payment', serverSlug: 'synth', outcome: 'ok', via: 'discovery' },
    ]);
    const { rows } = await t.pool.query('SELECT source, server_slug, tool, outcome FROM audit_log');
    expect(rows).toEqual([
      { source: 'chat', server_slug: 'synth', tool: 'refund_payment', outcome: 'ok' },
    ]);
  });

  it('at or below the threshold the model gets every permitted tool directly', async () => {
    const model = new ScriptedAnthropic(() =>
      message([{ type: 'text', text: 'hi', citations: null }]),
    );
    await start({ anthropic: model, discoveryThreshold: 500 });
    const res = await t.request('POST', '/api/chat', {
      cookie: admin,
      headers: { origin: PUBLIC_ORIGIN },
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(ChatResponseSchema.parse(res.json()).toolMode).toBe('direct');
    expect(model.requests[0]!.tools).toHaveLength(125);
  });
});
