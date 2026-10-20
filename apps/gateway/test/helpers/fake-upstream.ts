// Real MCP servers for the aggregation tests: the SDK McpServer on Streamable HTTP (stateless,
// JSON responses) over node:http on an ephemeral 127.0.0.1 port. Variants are options: delays in
// tools/list or in a tool, a required bearer, custom tool lists, failing calls, stateful sessions.
// `stop()` + `start()` on the same port simulates a dead upstream coming back.
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
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
  /** Tool calls fail: 'throw' answers with a JSON-RPC error, 'isError' with an isError result. */
  callFails?: 'throw' | 'isError';
  /**
   * Stateful, like server-everything or GitLab: initialize opens a session (Mcp-Session-Id) that
   * lives until the client sends DELETE. `liveSessions()` counts the open ones.
   */
  stateful?: boolean;
  /** With `stateful`: DELETE requests are never answered. */
  deleteHangs?: boolean;
}

export interface FakeUpstream {
  port: number;
  /** `http://localhost:<port>/mcp` (the tests allow-list `localhost`). */
  url: string;
  /** Every HTTP request received, in order. */
  requests: { method: string; headers: IncomingHttpHeaders }[];
  /** Tool calls received: name and arguments. */
  calls: { name: string; args: unknown }[];
  /** Sessions opened and not yet terminated (always 0 unless `stateful`). */
  liveSessions(): number;
  /** TCP connections currently open. */
  openConnections: number;
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
    if (opts.callFails === 'throw') throw new Error(`${opts.identity} failed`);
    if (opts.callFails === 'isError') {
      return { content: [{ type: 'text', text: 'tool reported an error' }], isError: true };
    }
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
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let server: Server | null = null;

  // One server + transport per session, kept until DELETE (the SDK's stateful example).
  const handleStateful = (req: IncomingMessage, res: ServerResponse) => {
    const fail = () => res.headersSent || res.writeHead(500).end();
    const sid = req.headers['mcp-session-id'];
    const existing = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (req.method === 'DELETE' && opts.deleteHangs) return;
    if (existing) {
      existing.handleRequest(req, res).catch(fail);
      return;
    }
    if (sid) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown session');
      return;
    }
    const mcp = mcpServer(opts, calls);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => void sessions.set(id, transport),
      onsessionclosed: (id) => void sessions.delete(id),
    });
    mcp
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(fail);
  };

  const fake: FakeUpstream = {
    port,
    url: '',
    requests,
    calls,
    liveSessions: () => sessions.size,
    openConnections: 0,
    async start() {
      const s = createServer((req, res) => {
        requests.push({ method: req.method ?? '', headers: req.headers });
        if (opts.requireBearer && req.headers.authorization !== `Bearer ${opts.requireBearer}`) {
          res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
          return;
        }
        if (opts.stateful) {
          handleStateful(req, res);
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
      s.on('connection', (socket) => {
        fake.openConnections++;
        socket.on('close', () => void fake.openConnections--);
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
