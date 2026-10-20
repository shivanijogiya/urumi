// Size caps on untrusted upstream payloads, in one place. Upstreams are admin-registered but their
// responses are data we do not control: these bound what the gateway keeps in memory, caches, and
// hands to MCP clients and the chat model.

/** tools/list: tools kept per upstream (the first ones, in the upstream's order). */
export const MAX_TOOLS_PER_UPSTREAM = 200;
/** tools/list: a tool whose JSON-serialised inputSchema exceeds this (UTF-8 bytes) is dropped. */
export const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;
/** tools/call: a JSON-serialised result over this (UTF-8 bytes) fails with UPSTREAM_ERROR. */
export const MAX_RESULT_BYTES = 256 * 1024;

/** UTF-8 byte length of JSON.stringify(value); Infinity if it cannot be serialised. */
export function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Infinity;
  }
}
