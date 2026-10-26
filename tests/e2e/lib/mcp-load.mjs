/* global process, URL, fetch */
// Load and burst client for tests/e2e D10 (ADR 010: several gateway replicas, rate limits).
//   MCP_KEY_FILE=<key file> node mcp-load.mjs <url> session <iterations> <tool> '<json args>' [progress-file]
//     ONE official-SDK client session: initialize once, then per iteration tools/list + tools/call.
//     Writes the number of finished iterations to progress-file after each one (the caller kills a
//     gateway pod mid-run). Every failure is counted, never retried.
//   MCP_KEY_FILE=<key file> node mcp-load.mjs <url> burst <requests> <concurrency>
//     Raw JSON-RPC `ping` POSTs as fast as possible: counts HTTP statuses, keeps one Retry-After.
// Prints one JSON summary. The key is read from a file and never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, mode, ...rest] = process.argv.slice(2);
const key = readFileSync(process.env.MCP_KEY_FILE ?? '', 'utf8').trim();
const TIMEOUT_MS = 20_000;
const out = (v, code = 0) => {
  process.stdout.write(JSON.stringify(v) + '\n');
  process.exit(code);
};

async function session(iterations, tool, rawArgs, progressFile) {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'urumi-e2e-load', version: '0.1.0' });
  const started = Date.now();
  await client.connect(transport, { timeout: TIMEOUT_MS });
  let ok = 0;
  const errors = [];
  for (let i = 0; i < iterations; i++) {
    try {
      const { tools } = await client.listTools(undefined, { timeout: TIMEOUT_MS });
      if (!tools.some((t) => t.name === tool)) throw new Error(`tools/list lacks ${tool}`);
      const r = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: TIMEOUT_MS,
      });
      if (r.isError) throw new Error(`isError: ${JSON.stringify(r.content).slice(0, 150)}`);
      ok++;
    } catch (err) {
      errors.push({ iteration: i, message: String(err?.message ?? err).slice(0, 200) });
    }
    if (progressFile) writeFileSync(progressFile, String(i + 1));
  }
  await client.close().catch(() => undefined);
  return {
    mode: 'session',
    iterations,
    ok,
    failed: errors.length,
    errors,
    ms: Date.now() - started,
  };
}

async function burst(requests, concurrency) {
  const statuses = {};
  let retryAfter = null;
  let next = 0;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const worker = async () => {
    while (next < requests) {
      next++;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body,
        });
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        if (r.status === 429 && retryAfter === null) {
          retryAfter = r.headers.get('retry-after');
          const e = await r.json().catch(() => null);
          statuses.code429 = e?.error?.code ?? null;
        } else {
          await r.arrayBuffer();
        }
      } catch {
        statuses.network = (statuses.network ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { mode: 'burst', requests, statuses, retryAfter };
}

try {
  if (mode === 'session') {
    out(await session(Number(rest[0]), rest[1], rest[2], rest[3]));
  } else if (mode === 'burst') {
    out(await burst(Number(rest[0]), Number(rest[1] ?? 20)));
  } else {
    out({ error: 'usage: mcp-load.mjs <url> session|burst ...' }, 2);
  }
} catch (err) {
  out({ error: String(err?.message ?? err).slice(0, 300) }, 2);
}
