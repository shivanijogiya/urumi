import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WooTool } from '@urumi/contracts';
import { z } from 'zod';
import { WooError, toToolError, type WooClient } from '../woo-client.js';

const MAX_VALIDATION_MESSAGE = 500;

/** A rule across fields that a per-field shape can't express; applied as a zod refinement. */
export interface Refinement<Args> {
  check: (args: Args) => boolean;
  message: string;
}

/** One MCP tool. Each tool lives in its own file under src/tools/ and is listed in index.ts. */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: WooTool;
  /** One sentence: what it does and what it returns. No instructions to the model. */
  description: string;
  /** Published in tools/list as JSON Schema. */
  inputSchema: Shape;
  /** Checked after `inputSchema`; failures are VALIDATION_FAILED like any schema error. */
  refinements?: Refinement<z.infer<z.ZodObject<Shape>>>[];
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

/** The match count from a list endpoint's `X-WP-Total` header, if it is a plain number. */
export function totalFrom(headers: Headers): number | undefined {
  const raw = headers.get('x-wp-total')?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Picks the expected fields out of an untrusted WooCommerce payload, or fails with UPSTREAM_ERROR. */
export function parseUpstream<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new WooError('UPSTREAM_ERROR', 'WooCommerce returned an unexpected response');
  }
  return parsed.data;
}

/** The full argument schema: the published shape plus the tool's refinements. */
export function argsSchema(tool: ToolDefinition): z.ZodType<Record<string, unknown>> {
  let schema: z.ZodType<Record<string, unknown>> = z.object(tool.inputSchema);
  for (const r of tool.refinements ?? []) schema = schema.refine(r.check, { message: r.message });
  return schema;
}

/**
 * Zod issue paths and messages only. These name schema fields and limits, never the given values;
 * refinement messages are our own text.
 */
function describeIssues(error: z.ZodError) {
  const issues = error.issues.map((i) =>
    i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message,
  );
  return `Invalid arguments: ${issues.join('; ')}`.slice(0, MAX_VALIDATION_MESSAGE);
}

/**
 * Validates raw arguments, then calls the handler. Invalid arguments never reach WooCommerce and,
 * like any failure, become an isError result with the contracts envelope (VALIDATION_FAILED).
 */
export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown> | undefined,
  woo: WooClient,
): Promise<CallToolResult> {
  const parsed = argsSchema(tool).safeParse(args ?? {});
  if (!parsed.success) {
    return toToolError(new WooError('VALIDATION_FAILED', describeIssues(parsed.error)));
  }
  try {
    return await tool.handler(parsed.data, woo);
  } catch (e) {
    return toToolError(e);
  }
}
