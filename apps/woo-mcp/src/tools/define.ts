import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WooTool } from '@urumi/contracts';
import type { z } from 'zod';
import { WooError, toToolError, type WooClient } from '../woo-client.js';

/** One MCP tool. Each tool lives in its own file under src/tools/ and is listed in index.ts. */
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

/** Compact JSON text content: tools return only the fields a user needs. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Picks the expected fields out of an untrusted WooCommerce payload, or fails with UPSTREAM_ERROR. */
export function parseUpstream<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new WooError('UPSTREAM_ERROR', 'WooCommerce returned an unexpected response');
  }
  return parsed.data;
}

/** Calls a tool's handler with already-validated arguments; any failure becomes an isError result. */
export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  woo: WooClient,
): Promise<CallToolResult> {
  try {
    return await tool.handler(args, woo);
  } catch (e) {
    return toToolError(e);
  }
}
