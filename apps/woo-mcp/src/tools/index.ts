import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { WooClient } from '../woo-client.js';
import { createProduct } from './create-product.js';
import { runTool, type ToolDefinition } from './define.js';
import { listProducts } from './list-products.js';

export { defineTool, jsonResult, parseUpstream, runTool, type ToolDefinition } from './define.js';

export const tools: ToolDefinition[] = [listProducts, createProduct];

export function registerTools(server: McpServer, woo: WooClient, list: ToolDefinition[] = tools) {
  if (list.length === 0) {
    // McpServer only installs tools/list once a tool is registered; answer with an empty list until then.
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    return;
  }
  for (const tool of list) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: Record<string, unknown>) => runTool(tool, args, woo),
    );
  }
}
