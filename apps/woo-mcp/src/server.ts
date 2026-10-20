import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  MCP_PATH,
  WOO_MCP_SECRET_HEADER,
  httpStatusFor,
  makeError,
  type ErrorCode,
} from '@urumi/contracts';
import type { Config } from './config.js';
import { registerTools, type ToolDefinition } from './tools/index.js';
import type { WooClient } from './woo-client.js';

export const MAX_BODY_BYTES = 1024 * 1024;
const SERVER_INFO = { name: 'urumi-woo-mcp', version: '0.0.0' };

export interface AppDeps {
  client: WooClient;
  /** Defaults to the real tool list; tests pass their own. */
  tools?: ToolDefinition[];
  /** Receives one JSON line per request. Defaults to stdout. */
  log?: (line: string) => void;
}

class BodyTooLarge extends Error {}

function sha256(value: string) {
  return createHash('sha256').update(value).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, code: ErrorCode, message: string, status?: number) {
  sendJson(res, status ?? httpStatusFor(code), makeError(code, message));
}

async function readBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp(config: Config, deps: AppDeps): Server {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const expectedSecret = sha256(config.sharedSecret);

  // Hash both sides so the comparison is constant-time even when lengths differ.
  function authorized(req: IncomingMessage) {
    const given = req.headers[WOO_MCP_SECRET_HEADER];
    return typeof given === 'string' && timingSafeEqual(sha256(given), expectedSecret);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (!(e instanceof BodyTooLarge)) throw e;
      sendError(res, 'VALIDATION_FAILED', 'Request body too large', 413);
      req.resume();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
      return;
    }

    // Stateless: a fresh server + transport per request, as in the SDK's stateless example.
    const server = new McpServer(SERVER_INFO);
    registerTools(server, deps.client, deps.tools);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === '/healthz') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false }, { allow: 'GET' });
      return sendJson(res, 200, { ok: true });
    }
    if (path !== MCP_PATH) return sendError(res, 'NOT_FOUND', 'Not found');
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (!authorized(req)) return sendError(res, 'UNAUTHENTICATED', 'Missing or invalid secret');
    await handleMcp(req, res);
  }

  const server = createServer((req, res) => {
    const started = performance.now();
    // Path only: query strings, headers, and bodies never reach the log.
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.once('close', () => {
      log(
        JSON.stringify({
          method: req.method,
          path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        }),
      );
    });
    route(req, res, path).catch(() => {
      if (!res.headersSent) sendError(res, 'INTERNAL', 'Internal error');
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  return server;
}
