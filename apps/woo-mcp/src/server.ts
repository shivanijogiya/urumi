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
const LINGER_MS = 2000;
const SERVER_INFO = { name: 'urumi-woo-mcp', version: '0.0.0' };

export interface AppDeps {
  client: WooClient;
  /** Defaults to the real tool list; tests pass their own. */
  tools?: ToolDefinition[];
  /** Receives one JSON line per request. Defaults to stdout. */
  log?: (line: string) => void;
}

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

/**
 * Answers 413 and closes the connection. Closing while the client is still uploading makes it see
 * EPIPE/reset instead of the 413, so the full response is written at once but ended only when the
 * upload stops (or after LINGER_MS), like nginx's lingering close. The request is destroyed only
 * after the response has finished.
 */
function rejectTooLarge(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.stringify(makeError('VALIDATION_FAILED', 'Request body too large'));
  res.writeHead(413, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.write(body);
  const end = () => {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  };
  const timer = setTimeout(end, LINGER_MS);
  res.once('finish', () => req.destroy());
  req.once('end', end);
  req.once('error', end);
  req.resume(); // discard the rest of the upload while lingering
}

/** Reads the body up to MAX_BODY_BYTES. Resolves `undefined` after answering 413 itself. */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      rejectTooLarge(req, res);
      return resolve(undefined);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // keep draining so the socket stays readable until we close it
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      tooLarge = true;
      chunks.length = 0;
      rejectTooLarge(req, res);
      resolve(undefined);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Path of the request target without URL parsing, which throws on targets like `//[`. */
function pathOf(target: string | undefined) {
  const raw = target ?? '/';
  const end = raw.search(/[?#]/);
  return (end === -1 ? raw : raw.slice(0, end)).slice(0, 256);
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
    const raw = await readBody(req, res);
    if (raw === undefined) return;
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
    const fail = () => {
      if (!res.headersSent) sendError(res, 'INTERNAL', 'Internal error');
      else res.destroy();
    };
    // Nothing thrown here, sync or async, may escape and crash the process.
    try {
      const started = performance.now();
      // Path only: query strings, headers, and bodies never reach the log.
      const path = pathOf(req.url);
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
      route(req, res, path).catch(fail);
    } catch {
      fail();
    }
  });
  server.requestTimeout = 30_000;
  return server;
}
