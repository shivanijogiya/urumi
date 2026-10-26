// Discovery mode (ADR 012): instead of hundreds of tool definitions, a client gets two meta-tools.
//   gateway__search_tools(query, limit) — ranked search (search.ts) over the tools THIS user may
//     call (listToolsFor: tool permissions applied), returning names, descriptions and schemas.
//   gateway__call_tool(name, arguments) — runs a tool by its qualified name through the one call
//     path, callTool: permissions, timeouts and the audit row carry the REAL server and tool.
// Searches run no upstream tool and are not audited (like tools/list). Meta-tools cannot call
// meta-tools. Tool descriptions in results are the registry's sanitised, capped copies — still
// untrusted data.
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { CALL_TOOL_NAME, GATEWAY_SLUG, SEARCH_TOOLS_NAME } from '@urumi/contracts';
import { z } from 'zod';
import type { CallOptions, CallTool } from '../core/call-tool.js';
import type { ListToolsFor } from '../core/visible-tools.js';
import { HttpError } from '../http/errors.js';
import { ToolIndex } from './search.js';

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 25;

export const META_TOOLS: McpTool[] = [
  {
    name: SEARCH_TOOLS_NAME,
    description:
      'Search the tools you are allowed to use by keywords (what you want to do, e.g. "list store orders" or "merge request"). Returns the best-matching tool names with their descriptions and input schemas. Call a result with gateway__call_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the task', maxLength: 200 },
        limit: {
          type: 'integer',
          description: `Maximum results (1–${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
      },
      required: ['query'],
    },
  },
  {
    name: CALL_TOOL_NAME,
    description:
      'Run one tool found with gateway__search_tools, by its exact name, with arguments matching its input schema.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name, e.g. woo__list_orders' },
        arguments: {
          type: 'object',
          description: "The tool's arguments",
          additionalProperties: true,
        },
      },
      required: ['name'],
    },
  },
];

const SearchArgs = z.strictObject({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});
const CallArgs = z.strictObject({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export function isMetaTool(name: string): boolean {
  return name === SEARCH_TOOLS_NAME || name === CALL_TOOL_NAME;
}

export interface SearchResult {
  query: string;
  totalTools: number;
  results: { name: string; server: string; description: string; inputSchema: object }[];
}

function invalid(what: string): HttpError {
  return new HttpError('VALIDATION_FAILED', `Invalid arguments for ${what}`);
}

export interface Discovery {
  search(userId: string, args: unknown): Promise<SearchResult>;
  /** gateway__call_tool: the target's qualified name and callTool's result. */
  call(
    userId: string,
    args: unknown,
    opts: CallOptions,
  ): Promise<{ name: string; result: CallToolResult }>;
  /** Either meta-tool as an MCP CallToolResult (search results as JSON text). */
  handle(userId: string, name: string, args: unknown, opts: CallOptions): Promise<CallToolResult>;
}

export function createDiscovery(deps: {
  listToolsFor: ListToolsFor;
  callTool: CallTool;
}): Discovery {
  async function search(userId: string, args: unknown): Promise<SearchResult> {
    const parsed = SearchArgs.safeParse(args ?? {});
    if (!parsed.success) throw invalid(SEARCH_TOOLS_NAME);
    const tools = (await deps.listToolsFor(userId)).filter((t) => t.serverSlug !== GATEWAY_SLUG);
    const index = new ToolIndex(tools);
    return {
      query: parsed.data.query,
      totalTools: index.size,
      results: index.search(parsed.data.query, parsed.data.limit).map(({ tool }) => ({
        name: tool.name,
        server: tool.serverSlug,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, type: 'object' },
      })),
    };
  }

  async function call(userId: string, args: unknown, opts: CallOptions) {
    const parsed = CallArgs.safeParse(args ?? {});
    if (!parsed.success) throw invalid(CALL_TOOL_NAME);
    const { name, arguments: toolArgs } = parsed.data;
    if (isMetaTool(name)) throw invalid(CALL_TOOL_NAME);
    // The one call path: permission check, routing, timeout and the audit row of the real tool.
    return { name, result: await deps.callTool(userId, name, toolArgs, opts) };
  }

  return {
    search,
    call,
    async handle(userId, name, args, opts) {
      if (name === SEARCH_TOOLS_NAME) {
        return { content: [{ type: 'text', text: JSON.stringify(await search(userId, args)) }] };
      }
      return (await call(userId, args, opts)).result;
    },
  };
}
