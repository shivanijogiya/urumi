import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { WooClient } from '../woo-client.js';
import { createProduct } from './create-product.js';
import { runTool, type ToolDefinition } from './define.js';
import { getOrder } from './get-order.js';
import { listOrders } from './list-orders.js';
import { listProducts } from './list-products.js';
import { updateOrderStatus } from './update-order-status.js';

export {
  argsSchema,
  defineTool,
  jsonResult,
  parseUpstream,
  runTool,
  type ToolDefinition,
} from './define.js';

export const tools: ToolDefinition[] = [
  listProducts,
  createProduct,
  listOrders,
  getOrder,
  updateOrderStatus,
];

export function registerTools(server: McpServer, woo: WooClient, list: ToolDefinition[] = tools) {
  if (list.length === 0) {
    // McpServer only installs tools/list once a tool is registered; answer with an empty list until then.
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    return;
  }
  const byName = new Map<string, ToolDefinition>();
  for (const tool of list) {
    byName.set(tool.name, tool);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: Record<string, unknown>) => runTool(tool, args, woo),
    );
  }
  // McpServer still answers tools/list from the registrations above. tools/call is replaced so
  // runTool validates the raw arguments itself: the SDK's own validation answers with plain text
  // and skips refinements, while every tool error here must carry the contracts envelope.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
    return runTool(tool, request.params.arguments, woo);
  });
}
