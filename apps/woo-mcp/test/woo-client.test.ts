import { describe, expect, it, vi } from 'vitest';
import type { WooConfig } from '../src/config.js';
import { WooError, createWooClient, toToolError } from '../src/woo-client.js';

const PASSWORD = 'abcd efgh ijkl mnop';
const BASE = 'http://wordpress.internal:8081';
const config: WooConfig = { url: BASE, user: 'mcp-bot', appPassword: PASSWORD };

type FetchArgs = [string, RequestInit];

function fetchReturning(response: Response) {
  return vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => response);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function caught(p: Promise<unknown>): Promise<WooError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WooError);
    return e as WooError;
  }
  throw new Error('expected rejection');
}

function expectSafe(err: WooError) {
  expect(err.message).not.toContain(BASE);
  expect(err.message).not.toContain('wordpress.internal');
  expect(err.message).not.toContain('http');
  expect(err.message).not.toContain(PASSWORD);
  expect(err.message).not.toContain('mcp-bot');
}

describe('createWooClient', () => {
  it('GETs under /wp-json/wc/v3 with basic auth, query, and a timeout signal', async () => {
    const fetchImpl = fetchReturning(json([{ id: 1 }]));
    const client = createWooClient(config, fetchImpl);

    await expect(
      client.get('/orders', { per_page: 20, status: 'processing', search: undefined }),
    ).resolves.toEqual([{ id: 1 }]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/wp-json/wc/v3/orders?per_page=20&status=processing`);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    const expected = Buffer.from(`mcp-bot:${PASSWORD}`).toString('base64');
    expect(headers.get('authorization')).toBe(`Basic ${expected}`);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('x-forwarded-proto')).toBe(false);
  });

  it('sends X-Forwarded-Proto when configured', async () => {
    const fetchImpl = fetchReturning(json({}));
    await createWooClient({ ...config, forwardedProto: 'https' }, fetchImpl).get('/products');
    const headers = new Headers(fetchImpl.mock.calls[0]![1].headers);
    expect(headers.get('x-forwarded-proto')).toBe('https');
  });

  it('POSTs and PUTs JSON bodies', async () => {
    const fetchImpl = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () =>
      json({ id: 7 }, 201),
    );
    const client = createWooClient(config, fetchImpl);

    await expect(client.post('/products', { name: 'Mug', regular_price: '9.99' })).resolves.toEqual(
      { id: 7 },
    );
    await client.put('/orders/7', { status: 'completed' });

    const [postUrl, postInit] = fetchImpl.mock.calls[0]!;
    expect(postUrl).toBe(`${BASE}/wp-json/wc/v3/products`);
    expect(postInit.method).toBe('POST');
    expect(postInit.body).toBe(JSON.stringify({ name: 'Mug', regular_price: '9.99' }));
    expect(new Headers(postInit.headers).get('content-type')).toBe('application/json');

    const [putUrl, putInit] = fetchImpl.mock.calls[1]!;
    expect(putUrl).toBe(`${BASE}/wp-json/wc/v3/orders/7`);
    expect(putInit.method).toBe('PUT');
  });

  it('exposes response headers with getWithHeaders', async () => {
    const res = new Response(JSON.stringify([{ id: 1 }]), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-wp-total': '42' },
    });
    const fetchImpl = fetchReturning(res);
    const result = await createWooClient(config, fetchImpl).getWithHeaders('/products', {
      page: 2,
    });

    expect(result.body).toEqual([{ id: 1 }]);
    expect(result.headers.get('x-wp-total')).toBe('42');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/wp-json/wc/v3/products?page=2`);
    expect(init.method).toBe('GET');
  });

  it('passes a known WooCommerce 400 code through in a safe message', async () => {
    const upstream = {
      code: 'product_invalid_sku',
      message: `Invalid or duplicated SKU. ${BASE} mcp-bot:${PASSWORD}`,
      data: { status: 400, resource_id: 12 },
    };
    const err = await caught(
      createWooClient(config, fetchReturning(json(upstream, 400))).post('/products', {}),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(400);
    expect(err.message).toContain('product_invalid_sku');
    expect(err.message).not.toContain('Invalid or duplicated');
    expectSafe(err);
  });

  it.each([
    ['an unknown code', { code: 'some_plugin_code_with_secret_abc' }],
    ['a non-string code', { code: { nested: true } }],
    ['no code', { message: 'oops' }],
    ['a non-JSON body', `<html>${BASE}</html>`],
  ])('keeps the generic 400 message for %s', async (_label, body) => {
    const res = typeof body === 'string' ? new Response(body, { status: 400 }) : json(body, 400);
    const err = await caught(createWooClient(config, fetchReturning(res)).post('/products', {}));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe('WooCommerce rejected the request as invalid');
  });

  it('rejects paths that could escape the API base', async () => {
    const fetchImpl = fetchReturning(json({}));
    const client = createWooClient(config, fetchImpl);
    for (const path of ['orders', '/../users', '/orders?x=1', '//evil.example/x']) {
      const err = await caught(client.get(path));
      expect(err.code).toBe('INTERNAL');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'VALIDATION_FAILED'],
    [401, 'UPSTREAM_ERROR'],
    [403, 'UPSTREAM_ERROR'],
    [404, 'NOT_FOUND'],
    [409, 'UPSTREAM_ERROR'],
    [500, 'UPSTREAM_ERROR'],
    [503, 'UPSTREAM_ERROR'],
  ] as const)('maps HTTP %i to %s without leaking the upstream body', async (status, code) => {
    const upstreamBody = {
      code: 'woocommerce_rest_cannot_view',
      message: `Sorry, ${BASE}/wp-json/wc/v3 refused mcp-bot:${PASSWORD}`,
    };
    const err = await caught(
      createWooClient(config, fetchReturning(json(upstreamBody, status))).get('/orders/1'),
    );
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).not.toContain('Sorry');
    expect(err.message).not.toContain('woocommerce_rest');
    expectSafe(err);
  });

  it('maps a redirect to UPSTREAM_ERROR instead of following it', async () => {
    const res = new Response(null, {
      status: 301,
      headers: { location: 'http://store.localtest.me/wp-json/wc/v3/orders' },
    });
    const err = await caught(createWooClient(config, fetchReturning(res)).get('/orders'));
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.message).not.toContain('localtest');
    expectSafe(err);
  });

  it('maps a fetch TimeoutError to UPSTREAM_TIMEOUT', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const err = await caught(createWooClient(config, fetchImpl).get('/orders'));
    expect(err.code).toBe('UPSTREAM_TIMEOUT');
    expectSafe(err);
  });

  it('aborts a hung request after the timeout (real AbortSignal)', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    const err = await caught(createWooClient(config, fetchImpl, 50).get('/orders'));
    expect(err.code).toBe('UPSTREAM_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('uses a 10 s timeout by default', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await createWooClient(config, fetchReturning(json({}))).get('/orders');
    expect(spy).toHaveBeenCalledWith(10_000);
    spy.mockRestore();
  });

  it('maps a network TypeError to UPSTREAM_UNREACHABLE', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: new Error(`connect ECONNREFUSED ${BASE} with ${PASSWORD}`),
      });
    });
    const err = await caught(createWooClient(config, fetchImpl).get('/orders'));
    expect(err.code).toBe('UPSTREAM_UNREACHABLE');
    expectSafe(err);
  });

  it('maps invalid JSON to UPSTREAM_ERROR without echoing it', async () => {
    const res = new Response(`<html>${BASE} fatal error</html>`, { status: 200 });
    const err = await caught(createWooClient(config, fetchReturning(res)).get('/orders'));
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.message).not.toContain('fatal');
    expectSafe(err);
  });

  it('rejects an oversized response body', async () => {
    const big = new Response(JSON.stringify({ blob: 'x'.repeat(6 * 1024 * 1024) }), {
      status: 200,
    });
    const err = await caught(createWooClient(config, fetchReturning(big)).get('/products'));
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.message).toMatch(/too large/i);
  });

  it('returns null for an empty 2xx body', async () => {
    const res = new Response(null, { status: 204 });
    await expect(createWooClient(config, fetchReturning(res)).get('/orders')).resolves.toBeNull();
  });
});

describe('toToolError', () => {
  it('wraps a WooError in an MCP error result carrying the contracts envelope', () => {
    const result = toToolError(new WooError('NOT_FOUND', 'Order not found', 404));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Order not found' },
    });
  });

  it('hides unknown errors behind INTERNAL', () => {
    const result = toToolError(new Error(`boom at ${BASE} ${PASSWORD}`));
    const text = result.content[0]!.text;
    expect(JSON.parse(text).error.code).toBe('INTERNAL');
    expect(text).not.toContain(BASE);
    expect(text).not.toContain(PASSWORD);
  });
});
