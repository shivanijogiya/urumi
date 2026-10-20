import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WOO_MCP_SECRET_HEADER } from '@urumi/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { defineTool, type ToolDefinition } from '../src/tools/index.js';
import { WooError, type WooClient } from '../src/woo-client.js';

const SECRET = 'test-shared-secret-'.padEnd(48, 'x');
const config: Config = {
  port: 0,
  sharedSecret: SECRET,
  woo: { url: 'http://wordpress.invalid', user: 'u', appPassword: 'p' },
};

// The WooCommerce client is an external boundary here; these tests never reach it.
const unusedClient: WooClient = {
  get: async () => {
    throw new Error('not expected');
  },
  post: async () => {
    throw new Error('not expected');
  },
  put: async () => {
    throw new Error('not expected');
  },
};

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

let server: Server | undefined;
let logs: string[] = [];

async function start(tools?: ToolDefinition[], client: WooClient = unusedClient) {
  logs = [];
  server = createApp(config, { client, tools, log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function connect(base: string) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { [WOO_MCP_SECRET_HEADER]: SECRET } },
  });
  await client.connect(transport);
  return client;
}

describe('auth and routing', () => {
  it('rejects POST /mcp without the shared secret', async () => {
    const base = await start();
    const res = await post(base, INIT);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
    });
  });

  it('rejects POST /mcp with a wrong secret (same length and different length)', async () => {
    const base = await start();
    const sameLength = SECRET.slice(0, -1) + 'y';
    for (const wrong of [sameLength, 'nope', SECRET + 'x']) {
      const res = await post(base, INIT, { [WOO_MCP_SECRET_HEADER]: wrong });
      expect(res.status).toBe(401);
    }
  });

  it('accepts POST /mcp initialize with the right secret', async () => {
    const base = await start();
    const res = await post(base, INIT, { [WOO_MCP_SECRET_HEADER]: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; capabilities: { tools?: object } };
    };
    expect(body.result.serverInfo.name).toBe('urumi-woo-mcp');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('serves /healthz without the secret and without calling WooCommerce', async () => {
    const base = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each(['GET', 'DELETE'])('answers %s /mcp with 405', async (method) => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method,
      headers: { [WOO_MCP_SECRET_HEADER]: SECRET },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('answers unknown paths with 404', async () => {
    const base = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/mcp/extra`, { method: 'POST' })).status).toBe(404);
  });

  it('rejects bodies over 1 MB with 413', async () => {
    const base = await start();
    const res = await post(base, 'x'.repeat(1024 * 1024 + 1), {
      [WOO_MCP_SECRET_HEADER]: SECRET,
    });
    expect(res.status).toBe(413);
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const base = await start();
    const res = await post(base, '{not json', { [WOO_MCP_SECRET_HEADER]: SECRET });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('lists no tools yet', async () => {
    const base = await start();
    const client = await connect(base);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();
  });

  it('registers tools from definitions and maps handler errors to the envelope', async () => {
    const echo = defineTool({
      name: 'get_order',
      description: 'Returns one order by id.',
      inputSchema: { id: z.number().int().positive() },
      handler: async ({ id }, woo) => {
        if (id === 404) throw new WooError('NOT_FOUND', 'Order not found', 404);
        const order = await woo.get(`/orders/${id}`);
        return { content: [{ type: 'text', text: JSON.stringify(order) }] };
      },
    });
    const woo: WooClient = { ...unusedClient, get: async (path) => ({ path }) };
    const base = await start([echo], woo);
    const client = await connect(base);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('get_order');
    expect(tools[0]!.inputSchema.required).toEqual(['id']);

    const ok = await client.callTool({ name: 'get_order', arguments: { id: 5 } });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: 'text', text: JSON.stringify({ path: '/orders/5' }) }]);

    const missing = await client.callTool({ name: 'get_order', arguments: { id: 404 } });
    expect(missing.isError).toBe(true);
    const [first] = missing.content as { text: string }[];
    expect(JSON.parse(first!.text)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Order not found' },
    });

    const invalid = await client.callTool({ name: 'get_order', arguments: { id: 'x' } });
    expect(invalid.isError).toBe(true);
    await client.close();
  });
});

describe('request logs', () => {
  it('writes one JSON line per request and never the secret', async () => {
    const base = await start();
    await post(base, INIT, { [WOO_MCP_SECRET_HEADER]: SECRET });
    await post(base, INIT, { [WOO_MCP_SECRET_HEADER]: SECRET.slice(0, -1) + 'y' });
    await fetch(`${base}/healthz?token=${SECRET}`);
    // 'close' fires after the response is flushed; give the last one a tick.
    await new Promise((r) => setTimeout(r, 20));

    expect(logs).toHaveLength(3);
    const entries = logs.map((l) => JSON.parse(l));
    expect(entries.map((e) => [e.method, e.path, e.status])).toEqual([
      ['POST', '/mcp', 200],
      ['POST', '/mcp', 401],
      ['GET', '/healthz', 200],
    ]);
    for (const e of entries) expect(typeof e.durationMs).toBe('number');
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SECRET.slice(0, -1));
    expect(all).not.toContain('initialize');
  });
});
