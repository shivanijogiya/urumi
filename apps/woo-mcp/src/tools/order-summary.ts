import { z } from 'zod';

/** WooCommerce order statuses a person may set (REST names, without the `wc-` prefix). */
export const SETTABLE_ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;

/** Every order status; checkout-draft is set only by the Store API checkout itself. */
export const ORDER_STATUSES = [...SETTABLE_ORDER_STATUSES, 'checkout-draft'] as const;

export const orderId = z.number().int().positive().describe('WooCommerce order id');

/**
 * Fields kept from each WooCommerce order; zod drops the rest of the payload. Customer data is
 * minimal on purpose: billing name and email only, never addresses, phones, IPs, or notes.
 */
export const OrderSummary = z
  .object({
    id: z.number().int(),
    number: z.string(),
    status: z.string(),
    total: z.string(),
    currency: z.string(),
    // Store-local time as WooCommerce returns it, and the same instant in UTC.
    date_created: z.string().nullable(),
    date_created_gmt: z.string().nullable(),
    billing: z
      .object({
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
        email: z.string().nullish(),
      })
      .nullish(),
    line_items: z.array(z.object({ name: z.string(), quantity: z.number(), total: z.string() })),
    payment_method: z.string(),
  })
  .transform(({ billing, ...order }) => {
    const name = [billing?.first_name, billing?.last_name]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');
    const email = billing?.email?.trim();
    return { ...order, customer: email ? { name, email } : { name } };
  });
