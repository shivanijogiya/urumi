import { describe, expect, it } from 'vitest';
import { getOrder } from '../../src/tools/get-order.js';
import { compactOrder, expectNoPersonalData, wooOrder } from './order-fixtures.js';
import {
  call,
  expectToolError,
  fakeFetch,
  hangingFetch,
  json,
  schemaOf,
  textOf,
} from './helpers.js';

const schema = schemaOf(getOrder);

describe('get_order schema', () => {
  it('accepts a positive integer id', () => {
    expect(schema.parse({ id: 42 })).toEqual({ id: 42 });
  });

  it.each([
    ['missing id', {}],
    ['zero', { id: 0 }],
    ['negative', { id: -1 }],
    ['fraction', { id: 1.5 }],
    ['string', { id: '42' }],
    ['unsafe integer', { id: 2 ** 60 }],
  ])('rejects %s', (_label, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('get_order', () => {
  it('GETs /orders/{id} and returns the compact order', async () => {
    const fetchImpl = fakeFetch(() => json(wooOrder(42, { status: 'completed' })));
    const result = await call(getOrder, { id: 42 }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('GET');
    expect(new URL(url).pathname).toBe('/wp-json/wc/v3/orders/42');
    expect(new URL(url).search).toBe('');

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(JSON.parse(text)).toEqual({ order: compactOrder(42, { status: 'completed' }) });
    expectNoPersonalData(text);
  });

  it('rejects a bad id as VALIDATION_FAILED without calling WooCommerce', async () => {
    const fetchImpl = fakeFetch(() => json(wooOrder(1)));
    expectToolError(await call(getOrder, { id: -1 }, fetchImpl), 'VALIDATION_FAILED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps 404 to NOT_FOUND', async () => {
    const body = { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' };
    expectToolError(
      await call(
        getOrder,
        { id: 999 },
        fakeFetch(() => json(body, 404)),
      ),
      'NOT_FOUND',
    );
  });

  it('maps 401 to UPSTREAM_ERROR', async () => {
    const res = await call(
      getOrder,
      { id: 1 },
      fakeFetch(() => json({ code: 'woocommerce_rest_cannot_view' }, 401)),
    );
    expectToolError(res, 'UPSTREAM_ERROR');
  });

  it('maps an unexpected payload shape to UPSTREAM_ERROR', async () => {
    expectToolError(
      await call(
        getOrder,
        { id: 1 },
        fakeFetch(() => json([wooOrder(1)])),
      ),
      'UPSTREAM_ERROR',
    );
  });

  it('maps a timeout to UPSTREAM_TIMEOUT', async () => {
    expectToolError(await call(getOrder, { id: 1 }, hangingFetch(), 50), 'UPSTREAM_TIMEOUT');
  });
});
