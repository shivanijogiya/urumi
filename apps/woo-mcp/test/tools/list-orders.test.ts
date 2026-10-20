import { describe, expect, it } from 'vitest';
import { createListOrders, listOrders } from '../../src/tools/list-orders.js';
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

const schema = schemaOf(listOrders);
// 18:45 UTC on 20 Oct is already 21 Oct in Asia/Kolkata.
const NOW = new Date('2026-10-20T18:45:00Z');
const tool = createListOrders(() => NOW);

function sentQuery(fetchImpl: ReturnType<typeof fakeFetch>) {
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(init.method).toBe('GET');
  const sent = new URL(url);
  expect(sent.pathname).toBe('/wp-json/wc/v3/orders');
  return Object.fromEntries(sent.searchParams);
}

describe('list_orders schema', () => {
  it('applies defaults to an empty input', () => {
    expect(schema.parse({})).toEqual({ status: 'any', page: 1, per_page: 20 });
  });

  it.each([
    [{ date: 'today' }],
    [{ date: '2026-10-20', status: 'on-hold', page: 2, per_page: 100 }],
    [{ after: '2026-10-20T00:00:00Z' }],
    [{ before: '2026-10-20T00:00:00+05:30' }],
    [{ after: '2026-10-19T00:00:00Z', before: '2026-10-20T00:00:00Z', status: 'checkout-draft' }],
  ])('accepts %j', (input) => {
    expect(schema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['date with after', { date: 'today', after: '2026-10-20T00:00:00Z' }],
    ['date with before', { date: '2026-10-20', before: '2026-10-21T00:00:00Z' }],
    ['after not before before', { after: '2026-10-21T00:00:00Z', before: '2026-10-20T00:00:00Z' }],
    ['impossible date', { date: '2026-02-30' }],
    ['date yesterday', { date: 'yesterday' }],
    ['date with time', { date: '2026-10-20T00:00:00Z' }],
    ['after without a zone', { after: '2026-10-20T00:00:00' }],
    ['after as a date', { after: '2026-10-20' }],
    ['unknown status', { status: 'shipped' }],
    ['trash status', { status: 'trash' }],
    ['page 0', { page: 0 }],
    ['per_page 0', { per_page: 0 }],
    ['per_page 101', { per_page: 101 }],
    ['per_page as a string', { per_page: '5' }],
  ])('rejects %s', (_label, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('list_orders', () => {
  it("date=today queries the store's day in UTC with dates_are_gmt and returns compact orders", async () => {
    const fetchImpl = fakeFetch(() =>
      json([wooOrder(101), wooOrder(102)], 200, { 'x-wp-total': '2' }),
    );
    const result = await call(
      tool,
      { date: 'today', status: 'processing', page: 1, per_page: 50 },
      fetchImpl,
    );

    // Woo's `after` is exclusive, so it gets the second before the day starts; values are naive UTC.
    expect(sentQuery(fetchImpl)).toEqual({
      after: '2026-10-20T18:29:59',
      before: '2026-10-21T18:30:00',
      dates_are_gmt: 'true',
      status: 'processing',
      page: '1',
      per_page: '50',
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual({
      orders: [compactOrder(101), compactOrder(102)],
      page: 1,
      per_page: 50,
      total: 2,
      window: {
        date: '2026-10-21',
        timezone: 'Asia/Kolkata',
        after: '2026-10-20T18:30:00.000Z',
        before: '2026-10-21T18:30:00.000Z',
      },
    });
    expectNoPersonalData(text);
  });

  it('just before IST midnight, today is still the earlier day', async () => {
    const fetchImpl = fakeFetch(() => json([]));
    const result = await call(
      createListOrders(() => new Date('2026-10-20T18:29:59Z')),
      { date: 'today' },
      fetchImpl,
    );
    expect(sentQuery(fetchImpl)).toMatchObject({
      after: '2026-10-19T18:29:59',
      before: '2026-10-20T18:30:00',
    });
    expect(JSON.parse(textOf(result)).window.date).toBe('2026-10-20');
  });

  it('an explicit date spans that day in Asia/Kolkata', async () => {
    const fetchImpl = fakeFetch(() => json([]));
    await call(tool, { date: '2026-03-01' }, fetchImpl);
    expect(sentQuery(fetchImpl)).toMatchObject({
      after: '2026-02-28T18:29:59',
      before: '2026-03-01T18:30:00',
      dates_are_gmt: 'true',
    });
  });

  it('passes after/before through as UTC and omits the window', async () => {
    const fetchImpl = fakeFetch(() => json([wooOrder(5)]));
    const result = await call(
      tool,
      { after: '2026-10-20T10:00:00+05:30', before: '2026-10-20T12:00:00.500Z' },
      fetchImpl,
    );
    expect(sentQuery(fetchImpl)).toEqual({
      after: '2026-10-20T04:30:00',
      before: '2026-10-20T12:00:00',
      dates_are_gmt: 'true',
      status: 'any',
      page: '1',
      per_page: '20',
    });
    expect(JSON.parse(textOf(result))).toEqual({
      orders: [compactOrder(5)],
      page: 1,
      per_page: 20,
    });
  });

  it('sends only status and paging without date filters', async () => {
    const fetchImpl = fakeFetch(() => json([]));
    await call(tool, {}, fetchImpl);
    expect(sentQuery(fetchImpl)).toEqual({ status: 'any', page: '1', per_page: '20' });
  });

  it('keeps only the name when the email is empty, and handles null created dates', async () => {
    const order = wooOrder(9, {
      billing: { first_name: '', last_name: 'Rao', email: '', phone: '1', address_1: 'x' },
      date_created: null,
      date_created_gmt: null,
    });
    const result = await call(
      tool,
      {},
      fakeFetch(() => json([order])),
    );
    expect(JSON.parse(textOf(result)).orders[0]).toEqual(
      compactOrder(9, { customer: { name: 'Rao' }, date_created: null, date_created_gmt: null }),
    );
  });

  it('rejects date combined with after as VALIDATION_FAILED without calling WooCommerce', async () => {
    const fetchImpl = fakeFetch(() => json([]));
    const result = await call(tool, { date: 'today', after: '2026-10-20T00:00:00Z' }, fetchImpl);
    expectToolError(result, 'VALIDATION_FAILED');
    expect(textOf(result)).toContain('date');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an impossible date as VALIDATION_FAILED without calling WooCommerce', async () => {
    const fetchImpl = fakeFetch(() => json([]));
    expectToolError(await call(tool, { date: '2026-02-30' }, fetchImpl), 'VALIDATION_FAILED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an unexpected payload shape to UPSTREAM_ERROR', async () => {
    expectToolError(
      await call(
        tool,
        {},
        fakeFetch(() => json({ orders: [] })),
      ),
      'UPSTREAM_ERROR',
    );
  });

  it('maps 404 to NOT_FOUND', async () => {
    expectToolError(
      await call(
        tool,
        {},
        fakeFetch(() => json({ code: 'x' }, 404)),
      ),
      'NOT_FOUND',
    );
  });

  it('maps 401 to UPSTREAM_ERROR', async () => {
    const res = await call(
      tool,
      {},
      fakeFetch(() => json({ code: 'woocommerce_rest_cannot_view' }, 401)),
    );
    expectToolError(res, 'UPSTREAM_ERROR');
  });

  it('maps a timeout to UPSTREAM_TIMEOUT', async () => {
    expectToolError(await call(tool, {}, hangingFetch(), 50), 'UPSTREAM_TIMEOUT');
  });
});
