/**
 * Live check against a real WooCommerce (not part of `npm test`): starts woo-mcp in-process, then
 * through the MCP SDK client calls create_product and finds the new product with list_products.
 *
 *   WOO_URL=http://127.0.0.1:18081 WOO_USER=… WOO_APP_PASSWORD=… [WOO_HOST_HEADER=…] \
 *     npm run test:cluster -w @urumi/woo-mcp
 *
 * Prints one PASS or FAIL line. Never prints configuration values.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WOO_MCP_SECRET_HEADER } from '@urumi/contracts';
import { ConfigError, loadConfig } from '../../src/config.js';
import { createApp } from '../../src/server.js';
import { createWooClient } from '../../src/woo-client.js';

class Fail extends Error {}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text?: string }[];
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Fail('no text content');
  // Tool errors carry the contracts envelope, which is safe to print.
  if (result.isError) throw new Fail(`tool error ${first.text}`);
  return first.text;
}

async function main() {
  const sharedSecret = randomBytes(32).toString('hex');
  const config = loadConfig({ ...process.env, PORT: '0', WOO_MCP_SHARED_SECRET: sharedSecret });
  const server = createApp(config, { client: createWooClient(config.woo), log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: 'products-cluster-test', version: '0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { [WOO_MCP_SECRET_HEADER]: sharedSecret } },
      }),
    );

    const name = `e2e-${Date.now()}`;
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_product',
          arguments: { name, regular_price: '123.00' },
        }),
      ),
    ) as { product: { id: number; name: string; regular_price: string } };
    const { id } = created.product;
    if (created.product.name !== name || created.product.regular_price !== '123.00') {
      throw new Fail(`create_product returned unexpected fields for id ${id}`);
    }

    const listed = JSON.parse(
      textOf(await client.callTool({ name: 'list_products', arguments: { search: name } })),
    ) as { products: { id: number; name: string }[]; total?: number };
    if (!listed.products.some((p) => p.id === id && p.name === name)) {
      throw new Fail(`list_products search=${name} did not return product ${id}`);
    }
    process.stdout.write(
      `PASS products: created product id=${id} name=${name}; list_products found it (total=${listed.total ?? 'n/a'})\n`,
    );
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e: unknown) => {
  const reason =
    e instanceof Fail || e instanceof ConfigError ? e.message : `${(e as Error)?.name ?? 'error'}`;
  process.stdout.write(`FAIL products: ${reason}\n`);
  process.exitCode = 1;
});
