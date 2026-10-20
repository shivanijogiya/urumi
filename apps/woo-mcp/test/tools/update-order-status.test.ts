import { describe, expect, it, vi } from 'vitest';
import { updateOrderStatus } from '../../src/tools/update-order-status.js';
import type { FetchLike } from '../../src/woo-client.js';
import { wooOrder } from './order-fixtures.js';
import {
  call,
  expectToolError,
  fakeFetch,
  hangingFetch,
  json,
  schemaOf,
  textOf,
  BASE,
  PASSWORD,
} from './helpers.js';

const schema = schemaOf(updateOrderStatus);
const ALLOWED = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
];

/** GET answers with the current order, PUT with the updated one, like WooCommerce. */
function orderStore(current: string) {
  return vi.fn<FetchLike>(async (_url, init) => {
    if (init.method === 'PUT') {
      const { status } = JSON.parse(init.body as string) as { status: string };
      return json(wooOrder(42, { status }));
    }
    return json(wooOrder(42, { status: current }));
  });
}

describe('update_order_status schema', () => {
  it.each(ALLOWED)('accepts %s', (status) => {
    expect(schema.parse({ id: 42, status })).toEqual({ id: 42, status });
  });

  it.each([
    ['unknown status', { id: 42, status: 'shipped' }],
    ['checkout-draft', { id: 42, status: 'checkout-draft' }],
    ['any', { id: 42, status: 'any' }],
    ['wc- prefix', { id: 42, status: 'wc-completed' }],
    ['upper case', { id: 42, status: 'Completed' }],
    ['missing status', { id: 42 }],
    ['missing id', { status: 'completed' }],
    ['zero id', { id: 0, status: 'completed' }],
    ['string id', { id: '42', status: 'completed' }],
  ])('rejects %s', (_label, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('update_order_status', () => {
  it('reads the previous status, PUTs only the new status, and returns both', async () => {
    const fetchImpl = orderStore('processing');
    const result = await call(updateOrderStatus, { id: 42, status: 'completed' }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchImpl.mock.calls[0]!;
    expect(getInit.method).toBe('GET');
    expect(new URL(getUrl).pathname).toBe('/wp-json/wc/v3/orders/42');
    const [putUrl, putInit] = fetchImpl.mock.calls[1]!;
    expect(putInit.method).toBe('PUT');
    expect(new URL(putUrl).pathname).toBe('/wp-json/wc/v3/orders/42');
    expect(new URL(putUrl).search).toBe('');
    expect(JSON.parse(putInit.body as string)).toEqual({ status: 'completed' });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(JSON.parse(text)).toEqual({
      order: { id: 42, status: 'completed', previous_status: 'processing' },
    });
    expect(text).not.toContain('Janpath');
    expect(text).not.toContain('9999999999');
  });

  it("rejects an unknown status ('shipped') as VALIDATION_FAILED and never calls WooCommerce", async () => {
    const fetchImpl = orderStore('processing');
    const result = await call(updateOrderStatus, { id: 42, status: 'shipped' }, fetchImpl);
    expectToolError(result, 'VALIDATION_FAILED');
    expect(textOf(result)).toContain('status');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a 404 on the read to NOT_FOUND and does not PUT', async () => {
    const fetchImpl = fakeFetch(() =>
      json({ code: 'woocommerce_rest_shop_order_invalid_id' }, 404),
    );
    expectToolError(
      await call(updateOrderStatus, { id: 999, status: 'completed' }, fetchImpl),
      'NOT_FOUND',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps a Woo 400 on the update to VALIDATION_FAILED with the Woo code only', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'PUT'
        ? json(
            {
              code: 'rest_invalid_param',
              message: `Invalid parameter(s): status at ${BASE} for mcp-bot:${PASSWORD}`,
              data: { status: 400, params: { status: 'status is not one of ...' } },
            },
            400,
          )
        : json(wooOrder(42)),
    );
    const result = await call(updateOrderStatus, { id: 42, status: 'refunded' }, fetchImpl);
    expectToolError(result, 'VALIDATION_FAILED');
    expect(textOf(result)).toContain('rest_invalid_param');
    expect(textOf(result)).not.toContain('is not one of');
  });

  it('maps 401 to UPSTREAM_ERROR', async () => {
    const fetchImpl = fakeFetch(() => json({ code: 'woocommerce_rest_cannot_edit' }, 401));
    expectToolError(
      await call(updateOrderStatus, { id: 42, status: 'completed' }, fetchImpl),
      'UPSTREAM_ERROR',
    );
  });

  it('maps an unexpected payload shape to UPSTREAM_ERROR', async () => {
    const fetchImpl = fakeFetch(() => json({ id: 42 }));
    expectToolError(
      await call(updateOrderStatus, { id: 42, status: 'completed' }, fetchImpl),
      'UPSTREAM_ERROR',
    );
  });

  it('maps a timeout to UPSTREAM_TIMEOUT', async () => {
    const res = await call(updateOrderStatus, { id: 42, status: 'completed' }, hangingFetch(), 50);
    expectToolError(res, 'UPSTREAM_TIMEOUT');
  });
});
