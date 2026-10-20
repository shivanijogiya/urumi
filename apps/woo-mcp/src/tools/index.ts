import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WooTool } from '@urumi/contracts';
import type { z } from 'zod';
import { toToolError, type WooClient } from '../woo-client.js';

/** One MCP tool. Each tool lives in its own file under src/tools/ and is added to `tools` below. */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: WooTool;
  /** One sentence: what it does and what it returns. No instructions to the model. */
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, woo: WooClient) => Promise<CallToolResult>;
}

/** Keeps the handler's argument type tied to its schema, then erases it for the `tools` list. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>) {
  return tool as unknown as ToolDefinition;
}

export const tools: ToolDefinition[] = [];

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
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args, woo);
        } catch (e) {
          return toToolError(e);
        }
      },
    );
  }
}
