import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, vi } from 'vitest';
import type { WooConfig } from '../../src/config.js';
import { argsSchema, runTool, type ToolDefinition } from '../../src/tools/index.js';
import { createWooClient, type FetchLike } from '../../src/woo-client.js';

export const BASE = 'http://wordpress.internal:8081';
export const PASSWORD = 'abcd efgh ijkl mnop';
const config: WooConfig = { url: BASE, user: 'mcp-bot', appPassword: PASSWORD };

export type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function fakeFetch(response: () => Response): FetchMock {
  return vi.fn<FetchLike>(async () => response());
}

/** A fetch that never answers, so only the client's AbortSignal can end it. */
export function hangingFetch(): FetchMock {
  return vi.fn<FetchLike>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      }),
  );
}

/** The full argument schema: the published shape plus the tool's cross-field refinements. */
export function schemaOf(tool: ToolDefinition) {
  return argsSchema(tool);
}

/**
 * Runs a tool the way the MCP server does: `runTool` parses the raw arguments with the tool's
 * schema, calls the handler, and maps errors. Only fetch (the HTTP boundary) is fake.
 */
export async function call(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  fetchImpl: FetchLike,
  timeoutMs?: number,
): Promise<CallToolResult> {
  const woo = createWooClient(config, fetchImpl, timeoutMs);
  return runTool(tool, args, woo);
}

export function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [first] = result.content;
  expect(first!.type).toBe('text');
  return (first as { text: string }).text;
}

/** Asserts an isError result carrying the contracts envelope with `code`, and nothing leaked. */
export function expectToolError(result: CallToolResult, code: string) {
  expect(result.isError).toBe(true);
  const text = textOf(result);
  expect(JSON.parse(text)).toEqual({ error: { code, message: expect.any(String) } });
  expect(text).not.toContain('wordpress.internal');
  expect(text).not.toContain('http');
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain('mcp-bot');
}
