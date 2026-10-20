/**
 * Live check against a real WooCommerce (not part of `npm test`): places a COD order through the
 * Store API (cart → checkout, as a shopper would), starts woo-mcp in-process, then through the MCP
 * SDK client checks list_orders date=today includes it, get_order returns it, and
 * update_order_status → completed sticks.
 *
 *   WOO_URL=http://127.0.0.1:18081 WOO_USER=… WOO_APP_PASSWORD=… [WOO_HOST_HEADER=…] \
 *     [STORE_URL=http://store.localtest.me] npm run test:cluster:orders -w @urumi/woo-mcp
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

const STORE_TIMEOUT_MS = 30_000;
const ADDRESS = {
  first_name: 'Cluster',
  last_name: 'Buyer',
  address_1: '1 Janpath',
  city: 'New Delhi',
  state: 'DL',
  postcode: '110001',
  country: 'IN',
  email: 'cluster-buyer@example.com',
  phone: '9999999999',
};

interface Order {
  id: number;
  status: string;
  date_created_gmt: string | null;
  customer: { name: string; email?: string };
}

async function storeApi(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/wp-json/wc/store/v1${path}`, {
    ...init,
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Fail(`Store API ${path} answered ${res.status} ${String(body?.code)}`);
  return { body, headers: res.headers };
}

/** Cart → add-item → checkout with cash on delivery; returns the new order id. */
async function placeOrder(storeUrl: string): Promise<number> {
  const { body: products } = await storeApi(storeUrl, '/products?per_page=20');
  const product = (products as unknown as { id: number; is_purchasable: boolean }[]).find(
    (p) => p.is_purchasable,
  );
  if (!product) throw new Fail('no purchasable product in the store');

  const { headers } = await storeApi(storeUrl, '/cart');
  const nonce = headers.get('nonce');
  const cartToken = headers.get('cart-token');
  if (!nonce || !cartToken) throw new Fail('GET /cart returned no Nonce/Cart-Token header');
  const session = {
    Nonce: nonce,
    'Cart-Token': cartToken,
    'content-type': 'application/json',
  };
  await storeApi(storeUrl, '/cart/add-item', {
    method: 'POST',
    headers: session,
    body: JSON.stringify({ id: product.id, quantity: 1 }),
  });
  const { body } = await storeApi(storeUrl, '/checkout', {
    method: 'POST',
    headers: session,
    body: JSON.stringify({
      billing_address: ADDRESS,
      shipping_address: ADDRESS,
      payment_method: 'cod',
    }),
  });
  const orderId = body?.order_id;
  if (typeof orderId !== 'number') throw new Fail('checkout returned no order id');
  return orderId;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text?: string }[];
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Fail('no text content');
  // Tool errors carry the contracts envelope, which is safe to print.
  if (result.isError) throw new Fail(`tool error ${first.text}`);
  return first.text;
}

async function main() {
  const storeUrl = (process.env.STORE_URL ?? 'http://store.localtest.me').replace(/\/+$/, '');
  const sharedSecret = randomBytes(32).toString('hex');
  const config = loadConfig({ ...process.env, PORT: '0', WOO_MCP_SHARED_SECRET: sharedSecret });

  const orderId = await placeOrder(storeUrl);

  const server = createApp(config, { client: createWooClient(config.woo), log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: 'orders-cluster-test', version: '0' });
  const tool = async <T>(name: string, args: Record<string, unknown>) =>
    JSON.parse(textOf(await client.callTool({ name, arguments: args }))) as T;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { [WOO_MCP_SECRET_HEADER]: sharedSecret } },
      }),
    );

    const today = await tool<{ orders: Order[]; total?: number; window: { date: string } }>(
      'list_orders',
      { date: 'today', per_page: 100 },
    );
    if (!today.orders.some((o) => o.id === orderId)) {
      throw new Fail(
        `list_orders date=today (${today.window.date}) did not include order ${orderId}`,
      );
    }

    const { order } = await tool<{ order: Order }>('get_order', { id: orderId });
    if (order.id !== orderId || !order.date_created_gmt) {
      throw new Fail(`get_order returned unexpected fields for order ${orderId}`);
    }
    if (
      order.customer.name !== 'Cluster Buyer' ||
      /Janpath|9999999999/.test(JSON.stringify(order))
    ) {
      throw new Fail(`get_order customer data is not minimal for order ${orderId}`);
    }

    // Woo's after/before are exclusive and compared in UTC: a 1 s window around the order finds it,
    // starting exactly at its creation second does not.
    const created = Date.parse(`${order.date_created_gmt}Z`);
    const iso = (ms: number) => new Date(ms).toISOString();
    const around = await tool<{ orders: Order[] }>('list_orders', {
      after: iso(created - 1000),
      before: iso(created + 1000),
    });
    const fromCreated = await tool<{ orders: Order[] }>('list_orders', {
      after: iso(created),
      before: iso(created + 1000),
    });
    if (
      !around.orders.some((o) => o.id === orderId) ||
      fromCreated.orders.some((o) => o.id === orderId)
    ) {
      throw new Fail(`after/before boundaries are not exclusive UTC for order ${orderId}`);
    }

    const updated = await tool<{ order: { id: number; status: string; previous_status: string } }>(
      'update_order_status',
      { id: orderId, status: 'completed' },
    );
    if (updated.order.status !== 'completed' || updated.order.previous_status !== order.status) {
      throw new Fail(`update_order_status returned ${JSON.stringify(updated.order)}`);
    }
    const after = await tool<{ order: Order }>('get_order', { id: orderId });
    if (after.order.status !== 'completed') {
      throw new Fail(`get_order shows status ${after.order.status} after update`);
    }

    process.stdout.write(
      `PASS orders: placed order id=${orderId} (COD); list_orders date=today (${today.window.date} Asia/Kolkata) included it (total=${today.total ?? 'n/a'}); get_order ok; update_order_status ${order.status} -> completed; get_order shows completed\n`,
    );
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e: unknown) => {
  const reason =
    e instanceof Fail || e instanceof ConfigError ? e.message : `${(e as Error)?.name ?? 'error'}`;
  process.stdout.write(`FAIL orders: ${reason}\n`);
  process.exitCode = 1;
});
