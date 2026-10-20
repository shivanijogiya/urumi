import { describe, expect, it } from 'vitest';
import { createProduct } from '../../src/tools/create-product.js';
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

const schema = schemaOf(createProduct);
const minimal = { name: 'Mug', regular_price: '123.00' };

function created(overrides: Record<string, unknown> = {}) {
  return {
    id: 51,
    name: 'Mug',
    slug: 'mug',
    permalink: 'http://store.localtest.me/product/mug/',
    type: 'simple',
    status: 'publish',
    description: '',
    sku: '',
    price: '123.00',
    regular_price: '123.00',
    stock_status: 'instock',
    meta_data: [],
    _links: { self: [{ href: `${BASE}/wp-json/wc/v3/products/51` }] },
    ...overrides,
  };
}

describe('create_product schema', () => {
  it('applies the publish default', () => {
    expect(schema.parse(minimal)).toEqual({ ...minimal, status: 'publish' });
  });

  it('accepts all optional fields', () => {
    const input = {
      ...minimal,
      description: 'd'.repeat(5000),
      short_description: 's'.repeat(1000),
      sku: 'k'.repeat(100),
      status: 'draft',
    };
    expect(schema.parse(input)).toEqual(input);
  });

  it.each(['0', '7', '9.9', '9.99', '1000000'])('accepts price %s', (price) => {
    expect(schema.safeParse({ ...minimal, regular_price: price }).success).toBe(true);
  });

  it.each([
    ['empty name', { ...minimal, name: '' }],
    ['whitespace-only name', { ...minimal, name: '   ' }],
    ['name over 200 chars', { ...minimal, name: 'x'.repeat(201) }],
    ['missing name', { regular_price: '1.00' }],
    ['missing price', { name: 'Mug' }],
    ['numeric price', { ...minimal, regular_price: 12 }],
    ['price with 3 decimals', { ...minimal, regular_price: '9.999' }],
    ['price with a comma', { ...minimal, regular_price: '9,99' }],
    ['negative price', { ...minimal, regular_price: '-1.00' }],
    ['price with a currency sign', { ...minimal, regular_price: '$9.99' }],
    ['price with a trailing dot', { ...minimal, regular_price: '9.' }],
    ['empty price', { ...minimal, regular_price: '' }],
    ['description over 5000', { ...minimal, description: 'x'.repeat(5001) }],
    ['short_description over 1000', { ...minimal, short_description: 'x'.repeat(1001) }],
    ['sku over 100', { ...minimal, sku: 'x'.repeat(101) }],
    ['status pending', { ...minimal, status: 'pending' }],
  ])('rejects %s', (_label, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('create_product', () => {
  it('POSTs a simple product and returns compact JSON', async () => {
    const fetchImpl = fakeFetch(() => json(created({ status: 'draft', sku: 'MUG-1' }), 201));
    const result = await call(
      createProduct,
      {
        name: 'Mug',
        regular_price: '123.00',
        description: 'A mug.',
        short_description: 'Mug',
        sku: 'MUG-1',
        status: 'draft',
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(new URL(url).pathname).toBe('/wp-json/wc/v3/products');
    expect(new URL(url).search).toBe('');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'simple',
      name: 'Mug',
      regular_price: '123.00',
      description: 'A mug.',
      short_description: 'Mug',
      sku: 'MUG-1',
      status: 'draft',
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual({
      product: {
        id: 51,
        name: 'Mug',
        status: 'draft',
        regular_price: '123.00',
        permalink: 'http://store.localtest.me/product/mug/',
      },
    });
  });

  it('sends only the given fields plus type and default status', async () => {
    const fetchImpl = fakeFetch(() => json(created(), 201));
    await call(createProduct, minimal, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string)).toEqual({
      type: 'simple',
      name: 'Mug',
      regular_price: '123.00',
      status: 'publish',
    });
  });

  it('maps a duplicate SKU (Woo 400) to VALIDATION_FAILED with the Woo code only', async () => {
    const upstream = {
      code: 'product_invalid_sku',
      message: `Invalid or duplicated SKU. See ${BASE} as mcp-bot:${PASSWORD}`,
      data: { status: 400, resource_id: 50, unique_sku: 'MUG-1-1' },
    };
    const result = await call(
      createProduct,
      { ...minimal, sku: 'MUG-1' },
      fakeFetch(() => json(upstream, 400)),
    );
    expectToolError(result, 'VALIDATION_FAILED');
    const text = textOf(result);
    expect(text).toContain('product_invalid_sku');
    expect(text).not.toContain('duplicated');
    expect(text).not.toContain('MUG-1-1');
  });

  it('maps an unexpected payload shape to UPSTREAM_ERROR', async () => {
    const result = await call(
      createProduct,
      minimal,
      fakeFetch(() => json([created()], 201)),
    );
    expectToolError(result, 'UPSTREAM_ERROR');
  });

  it('maps 404 to NOT_FOUND', async () => {
    const result = await call(
      createProduct,
      minimal,
      fakeFetch(() => json({}, 404)),
    );
    expectToolError(result, 'NOT_FOUND');
  });

  it('maps 401 to UPSTREAM_ERROR', async () => {
    const result = await call(
      createProduct,
      minimal,
      fakeFetch(() => json({ code: 'woocommerce_rest_cannot_create' }, 401)),
    );
    expectToolError(result, 'UPSTREAM_ERROR');
  });

  it('maps a timeout to UPSTREAM_TIMEOUT', async () => {
    const result = await call(createProduct, minimal, hangingFetch(), 50);
    expectToolError(result, 'UPSTREAM_TIMEOUT');
  });
});
