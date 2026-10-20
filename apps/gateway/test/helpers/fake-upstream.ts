// Real MCP servers for the aggregation tests: the SDK McpServer on Streamable HTTP (stateless,
// JSON responses) over node:http on an ephemeral 127.0.0.1 port. Variants are options: delays in
// tools/list or in a tool, a required bearer, custom tool lists. `stop()` + `start()` on the same
// port simulates a dead upstream coming back.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface FakeTool {
  name: string;
  description?: string;
  /** Default: `{ type: 'object', properties: { q: { type: 'string' } } }`. */
  inputSchema?: Record<string, unknown>;
}

export interface FakeUpstreamOptions {
  /** Echoed by every tool call, so a test can tell which server answered. */
  identity: string;
  tools?: FakeTool[];
  /** Delay before answering tools/list. */
  listDelayMs?: number;
  /** Delay before answering tools/call. */
  callDelayMs?: number;
  /** If set, requests without `Authorization: Bearer <value>` get HTTP 401. */
  requireBearer?: string;
  /** Pads every tool result's text with this many extra characters (oversized results). */
  resultPadding?: number;
}

export interface FakeUpstream {
  port: number;
  /** `http://localhost:<port>/mcp` (the tests allow-list `localhost`). */
  url: string;
  /** Every HTTP request received, in order. */
  requests: { method: string; headers: IncomingHttpHeaders }[];
  /** Tool calls received: name and arguments. */
  calls: { name: string; args: unknown }[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mcpServer(opts: FakeUpstreamOptions, calls: FakeUpstream['calls']): McpServer {
  const mcp = new McpServer(
    { name: `fake-${opts.identity}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const tools = opts.tools ?? [{ name: 'search', description: `Search ${opts.identity}` }];
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (opts.listDelayMs) await sleep(opts.listDelayMs);
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: {
          type: 'object' as const,
          properties: { q: { type: 'string' } },
          ...t.inputSchema,
        },
      })),
    };
  });
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push({ name: req.params.name, args: req.params.arguments });
    if (opts.callDelayMs) await sleep(opts.callDelayMs);
    const text = JSON.stringify({
      server: opts.identity,
      tool: req.params.name,
      args: req.params.arguments,
      padding: 'x'.repeat(opts.resultPadding ?? 0),
    });
    return { content: [{ type: 'text', text }] };
  });
  return mcp;
}

/** Starts listening immediately. Pass `port` to reuse one (restart after stop). */
export async function startFakeUpstream(
  opts: FakeUpstreamOptions,
  port = 0,
): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const calls: FakeUpstream['calls'] = [];
  let server: Server | null = null;

  const fake: FakeUpstream = {
    port,
    url: '',
    requests,
    calls,
    async start() {
      const s = createServer((req, res) => {
        requests.push({ method: req.method ?? '', headers: req.headers });
        if (opts.requireBearer && req.headers.authorization !== `Bearer ${opts.requireBearer}`) {
          res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
          return;
        }
        // Stateless: a fresh server + transport per request, as the SDK examples do.
        const mcp = mcpServer(opts, calls);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => void mcp.close());
        mcp
          .connect(transport)
          .then(() => transport.handleRequest(req, res))
          .catch(() => res.headersSent || res.writeHead(500).end());
      });
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(fake.port, '127.0.0.1', () => resolve());
      });
      server = s;
      fake.port = (s.address() as AddressInfo).port;
      fake.url = `http://localhost:${fake.port}/mcp`;
    },
    async stop() {
      const s = server;
      server = null;
      if (!s) return;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
  await fake.start();
  return fake;
}

/** A URL on a port nothing listens on (bound once, then released). */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://localhost:${port}/mcp`;
}
