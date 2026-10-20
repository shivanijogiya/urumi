/** External MCP endpoint: stateless Streamable HTTP, POST only (GET/DELETE → 405), JSON responses. */
export const MCP_PATH = '/mcp';
export const MCP_TIMEOUTS = { listMs: 3000, callMs: 15000, healthIntervalMs: 15000 } as const;
/** Shared-secret header the gateway sends to woo-mcp (internal only). */
export const WOO_MCP_SECRET_HEADER = 'x-woo-mcp-secret';
export const WOO_TOOLS = [
  'list_products',
  'create_product',
  'list_orders',
  'get_order',
  'update_order_status',
] as const;
export type WooTool = (typeof WOO_TOOLS)[number];
/** "Today" for orders is computed in this zone, by `date_created`. */
export const STORE_TIMEZONE = 'Asia/Kolkata';
