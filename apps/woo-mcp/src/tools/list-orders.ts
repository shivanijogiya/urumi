import { z } from 'zod';
import { dayWindow, isCalendarDate, toWooGmt } from '../store-time.js';
import type { Query } from '../woo-client.js';
import { defineTool, jsonResult, parseUpstream, totalFrom } from './define.js';
import { ORDER_STATUSES, OrderSummary } from './order-summary.js';

const dateTime = z.iso.datetime({ offset: true });

/**
 * WooCommerce's `after`/`before` are exclusive and compared to `date_created_gmt` at one-second
 * precision when `dates_are_gmt=true`. A day window `[start, end)` is therefore sent as
 * `after = start - 1 s`, `before = end`, both as naive UTC (see `toWooGmt`), so the result does
 * not depend on the store's timezone setting.
 */
function dateQuery(after?: string | number, before?: string | number): Query {
  if (after === undefined && before === undefined) return {};
  return {
    after: after === undefined ? undefined : toWooGmt(after),
    before: before === undefined ? undefined : toWooGmt(before),
    dates_are_gmt: true,
  };
}

/** `now` is injectable so tests can pin "today", including just either side of IST midnight. */
export function createListOrders(now: () => Date = () => new Date()) {
  return defineTool({
    name: 'list_orders',
    description:
      "Lists WooCommerce orders filtered by status and by creation date, where date='today' or YYYY-MM-DD means that calendar day in the store timezone (Asia/Kolkata), with each order's number, status, total, customer name and email, line items, and the total match count.",
    inputSchema: {
      date: z
        .string()
        .regex(/^(today|\d{4}-\d{2}-\d{2})$/)
        .refine((d) => d === 'today' || isCalendarDate(d), { message: 'Not a calendar date' })
        .optional()
        .describe("'today' or YYYY-MM-DD, a calendar day in the store timezone (Asia/Kolkata)"),
      after: dateTime
        .optional()
        .describe('Only orders created after this ISO 8601 date-time with Z or an offset'),
      before: dateTime
        .optional()
        .describe('Only orders created before this ISO 8601 date-time with Z or an offset'),
      status: z
        .enum([...ORDER_STATUSES, 'any'])
        .default('any')
        .describe('Order status filter'),
      page: z.number().int().min(1).default(1).describe('Page number, starting at 1'),
      per_page: z.number().int().min(1).max(100).default(20).describe('Orders per page'),
    },
    refinements: [
      {
        check: (a) => a.date === undefined || (a.after === undefined && a.before === undefined),
        message: 'date cannot be combined with after or before',
      },
      {
        check: (a) =>
          a.after === undefined ||
          a.before === undefined ||
          Date.parse(a.after) < Date.parse(a.before),
        message: 'after must be earlier than before',
      },
    ],
    handler: async ({ date, after, before, status, page, per_page }, woo) => {
      const window = date === undefined ? undefined : dayWindow(date, now());
      const range = window
        ? dateQuery(Date.parse(window.after) - 1000, window.before)
        : dateQuery(after, before);
      const { body, headers } = await woo.getWithHeaders('/orders', {
        ...range,
        status,
        page,
        per_page,
      });
      const orders = parseUpstream(z.array(OrderSummary), body);
      return jsonResult({ orders, page, per_page, total: totalFrom(headers), window });
    },
  });
}

export const listOrders = createListOrders();
