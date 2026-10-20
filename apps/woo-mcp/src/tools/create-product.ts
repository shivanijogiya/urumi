import { z } from 'zod';
import { defineTool, jsonResult, parseUpstream } from './define.js';

/** Fields kept from the created product; zod drops the rest of the payload. */
const CreatedProduct = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  regular_price: z.string(),
  permalink: z.string(),
});

export const createProduct = defineTool({
  name: 'create_product',
  description:
    'Creates a simple WooCommerce product and returns its id, name, status, regular price, and permalink.',
  inputSchema: {
    name: z.string().trim().min(1).max(200).describe('Product name'),
    // WooCommerce takes prices as strings.
    regular_price: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .describe('Regular price as a decimal string, e.g. "123.00"'),
    description: z.string().max(5000).optional().describe('Full product description'),
    short_description: z.string().max(1000).optional().describe('Short product description'),
    sku: z.string().max(100).optional().describe('Stock keeping unit; must be unique'),
    status: z.enum(['publish', 'draft']).default('publish').describe('Product status'),
  },
  handler: async (args, woo) => {
    const body = await woo.post('/products', { type: 'simple', ...args });
    return jsonResult({ product: parseUpstream(CreatedProduct, body) });
  },
});
