#!/usr/bin/env node
/* global Headers, console, process */
// Demo regression check (#28; scripts/demo/README.md). Not part of `npm test`.
//
// Sends one realistic `woo__list_orders` page through the gateway's real result path and checks
// that it comes back as a normal tool result:
//   real woo-mcp app (apps/woo-mcp createApp: real list_orders tool, schema and result shape) with
//   a stubbed WooCommerce client returning 24 of today's orders with line items
//   -> real gateway UpstreamClient (pinned fetch, streaming body cap, MCP SDK client)
//   -> real ToolRegistry + createCallTool (resolve, size checks, error mapping).
// Only the external boundaries are stubbed: WooCommerce (no store) and Postgres (one upstream row).
// The TypeScript sources of the checkout this file lives in are bundled with esbuild on the fly, so
// running the copy inside the demo worktree tests the regressed code.
//
//   node scripts/demo/check-regression.mjs     exit 0 PASS, 1 FAIL
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ORDERS = 24;
const PER_PAGE = 20; // list_orders' default page size

const entry = `
import { randomUUID } from 'node:crypto';
export { createApp } from ${JSON.stringify(join(ROOT, 'apps/woo-mcp/src/server.ts'))};
export { UpstreamClient } from ${JSON.stringify(join(ROOT, 'apps/gateway/src/mcp-client/upstream-client.ts'))};
export { ToolRegistry } from ${JSON.stringify(join(ROOT, 'apps/gateway/src/core/registry.ts'))};
export { createCallTool } from ${JSON.stringify(join(ROOT, 'apps/gateway/src/core/call-tool.ts'))};
export { encrypt } from ${JSON.stringify(join(ROOT, 'apps/gateway/src/crypto/secretbox.ts'))};
export { jsonBytes } from ${JSON.stringify(join(ROOT, 'apps/gateway/src/core/limits.ts'))};
export const newId = randomUUID;
`;

/** A WooCommerce REST order as GET /wc/v3/orders returns it (the fields woo-mcp reads, plus noise it drops). */
function wooOrder(i, now) {
  const first = ['Aarav', 'Diya', 'Kabir', 'Ishaan', 'Meera', 'Rohan', 'Ananya', 'Vihaan'][i % 8];
  const last = ['Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta'][i % 6];
  const created = new Date(now.getTime() - i * 60_000);
  const local = new Date(created.getTime() + 330 * 60_000).toISOString().slice(0, 19);
  const items = [
    { name: 'Demo Tee', quantity: 1 + (i % 3), price: 499 },
    { name: 'Masala Chai 250 g', quantity: 2, price: 180 },
    { name: 'Steel Water Bottle', quantity: 1, price: 650 },
  ].slice(0, 1 + (i % 3));
  const total = items.reduce((s, it) => s + it.quantity * it.price, 0);
  return {
    id: 100 + i,
    number: String(100 + i),
    status: i % 4 === 0 ? 'completed' : 'processing',
    currency: 'INR',
    total: total.toFixed(2),
    date_created: local,
    date_created_gmt: created.toISOString().slice(0, 19),
    billing: {
      first_name: first,
      last_name: last,
      email: `${first}.${last}${i}@example.com`.toLowerCase(),
      address_1: '1 Janpath',
      city: 'New Delhi',
      phone: '9999999999',
    },
    shipping: { address_1: '1 Janpath', city: 'New Delhi' },
    line_items: items.map((it, n) => ({
      id: 1000 + i * 10 + n,
      name: it.name,
      product_id: 10 + n,
      quantity: it.quantity,
      total: (it.quantity * it.price).toFixed(2),
      sku: `SKU-${n}`,
      meta_data: [],
    })),
    payment_method: 'cod',
    payment_method_title: 'Cash on delivery',
    customer_note: '',
    meta_data: [],
  };
}

function stubWoo() {
  const now = new Date();
  const orders = Array.from({ length: ORDERS }, (_, i) => wooOrder(i, now));
  return {
    async getWithHeaders(path, query = {}) {
      if (path !== '/orders') throw new Error(`unexpected WooCommerce path ${path}`);
      const page = Number(query.page ?? 1);
      const perPage = Number(query.per_page ?? PER_PAGE);
      return {
        body: orders.slice((page - 1) * perPage, page * perPage),
        headers: new Headers({ 'x-wp-total': String(orders.length) }),
      };
    },
    get: async () => {
      throw new Error('not used');
    },
    post: async () => {
      throw new Error('not used');
    },
    put: async () => {
      throw new Error('not used');
    },
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'urumi-check-'));
  const out = join(dir, 'bundle.mjs');
  let woo;
  try {
    writeFileSync(join(dir, 'entry.ts'), entry);
    await build({
      entryPoints: [join(dir, 'entry.ts')],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['pg-native'],
      nodePaths: [join(ROOT, 'node_modules')],
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: 'error',
    });
    const gw = await import(pathToFileURL(out).href);

    const secret = randomBytes(24).toString('hex');
    woo = gw.createApp(
      {
        port: 0,
        sharedSecret: secret,
        woo: { url: 'http://woo.invalid', user: 'x', appPassword: 'x' },
      },
      { client: stubWoo(), log: () => {} },
    );
    await new Promise((r) => woo.listen(0, '127.0.0.1', r));
    const url = `http://localhost:${woo.address().port}/mcp`;

    const encKey = randomBytes(32);
    const id = gw.newId();
    const sealed = gw.encrypt(encKey, secret, id);
    const row = {
      id,
      slug: 'woo',
      name: 'WooCommerce store',
      url,
      enabled: true,
      status: 'up',
      last_error: null,
      last_checked_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      credential_type: 'header',
      credential_header_name: 'x-woo-mcp-secret',
      credential_ciphertext: sealed.ciphertext,
      credential_iv: sealed.iv,
      credential_tag: sealed.tag,
    };
    const pool = { query: async () => ({ rows: [row], rowCount: 1 }) };
    const client = new gw.UpstreamClient({ encKey, allowedHosts: ['localhost'] });
    const registry = new gw.ToolRegistry({ pool, client, log: silent });
    const callTool = gw.createCallTool({ pool, registry, client, log: silent });

    let result;
    try {
      result = await callTool(
        'demo-user',
        'woo__list_orders',
        { date: 'today' },
        { source: 'mcp' },
      );
    } catch (err) {
      console.log(`FAIL woo__list_orders: ${err.code ?? err.name}: ${err.message}`);
      console.log(`     a normal page of ${PER_PAGE} of today's orders did not reach the client`);
      return 1;
    }
    const text = result.content?.[0]?.text ?? '';
    const page = JSON.parse(text);
    const bytes = gw.jsonBytes(result);
    if (result.isError || page.orders?.length !== PER_PAGE || page.total !== ORDERS) {
      console.log(
        `FAIL woo__list_orders: unexpected result (isError=${!!result.isError}, ${bytes} bytes)`,
      );
      return 1;
    }
    const items = page.orders.reduce((n, o) => n + o.line_items.length, 0);
    console.log(
      `PASS woo__list_orders: ${page.orders.length} of ${page.total} orders, ${items} line items, ` +
        `${bytes} bytes through UpstreamClient + callTool`,
    );
    return 0;
  } finally {
    if (woo) await new Promise((r) => woo.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ERROR check-regression: ${err.stack ?? err}`);
    process.exit(2);
  },
);
