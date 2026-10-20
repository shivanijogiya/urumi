import { z } from 'zod';
import { defineTool, jsonResult, parseUpstream, totalFrom } from './define.js';

/** Fields kept from each WooCommerce product; zod drops the rest of the payload. */
const ProductSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  sku: z.string(),
  status: z.string(),
  price: z.string(),
  regular_price: z.string(),
  stock_status: z.string(),
  permalink: z.string(),
});

export const listProducts = defineTool({
  name: 'list_products',
  description:
    'Lists WooCommerce products, optionally filtered by search text and status, with id, name, SKU, status, prices, stock status, permalink, and the total match count.',
  inputSchema: {
    search: z.string().min(1).max(100).optional().describe('Text to match in product names'),
    page: z.number().int().min(1).default(1).describe('Page number, starting at 1'),
    per_page: z.number().int().min(1).max(100).default(20).describe('Products per page'),
    status: z
      .enum(['publish', 'draft', 'pending', 'private', 'any'])
      .default('any')
      .describe('Product status filter'),
  },
  handler: async ({ search, page, per_page, status }, woo) => {
    const { body, headers } = await woo.getWithHeaders('/products', {
      search,
      page,
      per_page,
      status,
    });
    const products = parseUpstream(z.array(ProductSummary), body);
    return jsonResult({ products, page, per_page, total: totalFrom(headers) });
  },
});
