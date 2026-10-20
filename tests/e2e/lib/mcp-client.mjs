/* global process, URL, console */
// Minimal MCP client for the e2e steps: what an external team member's client does, given only the
// gateway URL and an API key. Uses the official SDK Client + StreamableHTTPClientTransport.
//   MCP_KEY_FILE=<file holding the key> node mcp-client.mjs <url> list
//   MCP_KEY_FILE=<file holding the key> node mcp-client.mjs <url> call <tool> '<json args>'
// The key is read from a file (never argv or stdout). Prints one JSON object:
//   list -> {"tools": ["woo__list_orders", ...]}
//   call -> the CallToolResult ({"content": [...], "isError"?: true})
//   failure -> {"error": {"status": <HTTP status or null>, "message": "..."}}, exit code 2
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, command, name, rawArgs] = process.argv.slice(2);
const TIMEOUT_MS = 20_000;

function out(value, code = 0) {
  process.stdout.write(JSON.stringify(value) + '\n');
  process.exit(code);
}

if (!url || !['list', 'call'].includes(command) || (command === 'call' && !name)) {
  out({ error: { status: null, message: 'usage: mcp-client.mjs <url> list|call <tool> [json]' } }, 2);
}
const keyFile = process.env.MCP_KEY_FILE;
if (!keyFile) out({ error: { status: null, message: 'MCP_KEY_FILE is not set' } }, 2);
const key = readFileSync(keyFile, 'utf8').trim();

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${key}` } },
});
const client = new Client({ name: 'urumi-e2e', version: '0.1.0' });

try {
  await client.connect(transport, { timeout: TIMEOUT_MS });
  if (command === 'list') {
    const { tools } = await client.listTools(undefined, { timeout: TIMEOUT_MS });
    await client.close();
    out({ tools: tools.map((t) => t.name) });
  } else {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: TIMEOUT_MS,
    });
    await client.close();
    out(result);
  }
} catch (err) {
  // StreamableHTTPError carries the HTTP status as `code`; the message never contains the key.
  const status = typeof err?.code === 'number' && err.code >= 100 ? err.code : null;
  out({ error: { status, message: String(err?.message ?? err).slice(0, 300) } }, 2);
}
