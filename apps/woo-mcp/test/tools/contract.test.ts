import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WOO_MCP_SECRET_HEADER, WOO_TOOLS } from '@urumi/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createApp } from '../../src/server.js';
import { createWooClient, type FetchLike } from '../../src/woo-client.js';
import { fakeFetch, json } from './helpers.js';

const SECRET = 'contract-test-secret-'.padEnd(48, 'x');
const config: Config = {
  port: 0,
  sharedSecret: SECRET,
  woo: { url: 'http://wordpress.invalid', user: 'u', appPassword: 'p' },
};

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

/** The real server with the real tool list; only fetch to WooCommerce is fake. */
async function connect(fetchImpl: FetchLike = fakeFetch(() => json([]))) {
  server = createApp(config, { client: createWooClient(config.woo, fetchImpl), log: () => {} });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'contract-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { [WOO_MCP_SECRET_HEADER]: SECRET } },
    }),
  );
  return client;
}

describe('tools/list contract', () => {
  it('lists exactly list_products and create_product, all members of WOO_TOOLS', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['create_product', 'list_products']);
    for (const name of names) expect(WOO_TOOLS).toContain(name);
    for (const tool of tools) {
      expect(tool.description).toMatch(/^[A-Z][^.]*\.$/); // one sentence
    }
    await client.close();
  });

  it('publishes the list_products input schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'list_products')!.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.required ?? []).toEqual([]);
    expect(schema.properties).toMatchObject({
      search: { type: 'string', minLength: 1, maxLength: 100 },
      page: { type: 'integer', minimum: 1, default: 1 },
      per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      status: { enum: ['publish', 'draft', 'pending', 'private', 'any'], default: 'any' },
    });
    expect(Object.keys(schema.properties!).sort()).toEqual([
      'page',
      'per_page',
      'search',
      'status',
    ]);
    await client.close();
  });

  it('publishes the create_product input schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'create_product')!.inputSchema;
    expect(schema.type).toBe('object');
    expect([...(schema.required ?? [])].sort()).toEqual(['name', 'regular_price']);
    expect(schema.properties).toMatchObject({
      name: { type: 'string', minLength: 1, maxLength: 200 },
      regular_price: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
      description: { type: 'string', maxLength: 5000 },
      short_description: { type: 'string', maxLength: 1000 },
      sku: { type: 'string', maxLength: 100 },
      status: { enum: ['publish', 'draft'], default: 'publish' },
    });
    expect(Object.keys(schema.properties!).sort()).toEqual([
      'description',
      'name',
      'regular_price',
      'short_description',
      'sku',
      'status',
    ]);
    await client.close();
  });
});

describe('tools/call over HTTP', () => {
  it('runs list_products end to end and rejects invalid arguments', async () => {
    const fetchImpl = fakeFetch(() => json([], 200, { 'x-wp-total': '0' }));
    const client = await connect(fetchImpl);

    const ok = await client.callTool({ name: 'list_products', arguments: { per_page: 5 } });
    expect(ok.isError).toBeFalsy();
    const [first] = ok.content as { text: string }[];
    expect(JSON.parse(first!.text)).toEqual({ products: [], page: 1, per_page: 5, total: 0 });

    const bad = await client.callTool({ name: 'list_products', arguments: { per_page: 101 } });
    expect(bad.isError).toBe(true);
    const badPrice = await client.callTool({
      name: 'create_product',
      arguments: { name: 'Mug', regular_price: '9.999' },
    });
    expect(badPrice.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await client.close();
  });
});
