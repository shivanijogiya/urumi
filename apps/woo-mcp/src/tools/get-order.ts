import { defineTool, jsonResult, parseUpstream } from './define.js';
import { OrderSummary, orderId } from './order-summary.js';

export const getOrder = defineTool({
  name: 'get_order',
  description:
    'Gets one WooCommerce order by id with its number, status, total, currency, created dates, customer name and email, line items, and payment method.',
  inputSchema: { id: orderId },
  handler: async ({ id }, woo) => {
    const body = await woo.get(`/orders/${id}`);
    return jsonResult({ order: parseUpstream(OrderSummary, body) });
  },
});
