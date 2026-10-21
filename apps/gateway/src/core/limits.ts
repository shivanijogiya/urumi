// Size caps on untrusted upstream payloads, in one place. Upstreams are admin-registered but their
// responses are data we do not control: these bound what the gateway keeps in memory, caches, and
// hands to MCP clients and the chat model.

/** tools/list: tools kept per upstream (the first ones, in the upstream's order). */
export const MAX_TOOLS_PER_UPSTREAM = 200;
/** tools/list: a tool whose JSON-serialised inputSchema exceeds this (UTF-8 bytes) is dropped. */
export const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;
/** tools/call: a JSON-serialised result over this (UTF-8 bytes) fails with UPSTREAM_ERROR. */
export const MAX_RESULT_BYTES = 256 * 1024;
/**
 * tools/call: a page of a paginated tool (its inputSchema has `per_page`) over this (UTF-8 bytes)
 * fails like an oversized result. Big pages are slow to ship to MCP clients and to the chat model,
 * and the caller can always ask for a smaller `per_page`.
 */
export const MAX_PAGE_RESULT_BYTES = 4 * 1024;
/**
 * tools/call: raw HTTP response body bytes read before the upstream is cut off (same error). The
 * body wraps the result in a JSON-RPC envelope (and SSE framing), hence the slack; the check on
 * the parsed result above stays the exact one.
 */
export const MAX_RESULT_RESPONSE_BYTES = MAX_RESULT_BYTES + 16 * 1024;

/** UTF-8 byte length of JSON.stringify(value); Infinity if it cannot be serialised. */
export function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Infinity;
  }
}
