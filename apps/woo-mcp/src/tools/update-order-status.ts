import { z } from 'zod';
import { defineTool, jsonResult, parseUpstream } from './define.js';
import { SETTABLE_ORDER_STATUSES, orderId } from './order-summary.js';

const OrderStatus = z.object({ id: z.number().int(), status: z.string() });

export const updateOrderStatus = defineTool({
  name: 'update_order_status',
  description:
    'Sets the status of a WooCommerce order and returns its id, new status, and previous status.',
  inputSchema: {
    id: orderId,
    status: z.enum(SETTABLE_ORDER_STATUSES).describe('New order status'),
  },
  handler: async ({ id, status }, woo) => {
    // The PUT response only carries the new status, so the previous one is read first. A change
    // made by someone else between the two calls would show up as the previous status.
    const before = parseUpstream(OrderStatus, await woo.get(`/orders/${id}`));
    const after = parseUpstream(OrderStatus, await woo.put(`/orders/${id}`, { status }));
    return jsonResult({
      order: { id: after.id, status: after.status, previous_status: before.status },
    });
  },
});
