// The external MCP endpoint (#15, G2/T2): POST /mcp, stateless Streamable HTTP with JSON responses
// and no Mcp-Session-Id. Every request carries `Authorization: Bearer urk_…`, checked before the
// body is read; anything but a live key of an enabled user gets the same detail-free 401. Each
// authenticated request gets a fresh SDK server + transport bound to that key's user, so
// revocation takes effect on the very next request.
//
// tools/list is the registry's aggregate under qualified names, filtered by the caller's tool
// permissions (listToolsFor, ADR 008); tools/call goes through callTool
// (source 'mcp', the key's id), which writes the audit row. A GatewayError becomes an isError tool
// result carrying the contracts envelope, so clients show it rather than a protocol failure.
// Upstream `instructions` are never forwarded (untrusted).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode as RpcErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  FAILURE_DETAILS,
  httpStatusFor,
  makeError,
  MCP_PATH,
  type ErrorCode,
} from '@urumi/contracts';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateApiKey } from '../auth/api-keys.js';
import type { CallRecord, CallTool } from '../core/call-tool.js';
import type { RegisteredTool } from '../core/registry.js';
import type { ListToolsFor } from '../core/visible-tools.js';
import { isMetaTool, META_TOOLS, type Discovery } from '../discovery/meta-tools.js';
import { HttpError } from '../http/errors.js';
import { checkMcpLimits, type McpRateLimits, type PgTokenBucket } from '../ratelimit/bucket.js';

export const MCP_SERVER_NAME = 'urumi-gateway';
const MCP_SERVER_VERSION = '0.1.0';
/** 1 MB: a JSON-RPC request is a tool call's arguments, never a file upload. */
export const MCP_BODY_LIMIT = 1024 * 1024;

interface McpCaller {
  userId: string;
  keyId: string;
}

/**
 * Tool mode of one /mcp request (ADR 012). `discovery`: tools/list returns only
 * gateway__search_tools + gateway__call_tool. Chosen per request by `?mode=discovery` (works with
 * any client that takes only a URL) or the `x-urumi-tool-mode: discovery` header.
 */
export type ToolMode = 'direct' | 'discovery';
export const TOOL_MODE_HEADER = 'x-urumi-tool-mode';

/** The requested mode, or null if the value is not one we know (→ 400). */
export function toolModeOf(req: Pick<FastifyRequest, 'query' | 'headers'>): ToolMode | null {
  const q = (req.query as Record<string, unknown> | undefined)?.mode;
  const h = req.headers[TOOL_MODE_HEADER];
  const raw = typeof q === 'string' ? q : typeof h === 'string' ? h : undefined;
  if (raw === undefined || raw === '' || raw === 'direct') return 'direct';
  return raw === 'discovery' ? 'discovery' : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    mcpCaller: McpCaller | null;
  }
}

export function toMcpTool(t: RegisteredTool): McpTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: { ...t.inputSchema, type: 'object' },
  };
}

function errorResult(code: ErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(makeError(code, message)) }],
  };
}

/** One request's MCP server: knows only the caller, its visible tools and callTool. */
function createServer(
  caller: McpCaller,
  mode: ToolMode,
  deps: {
    listToolsFor: ListToolsFor;
    callTool: CallTool;
    discovery: Discovery;
    log: FastifyBaseLogger;
  },
): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      if (mode === 'discovery') return { tools: META_TOOLS };
      return { tools: (await deps.listToolsFor(caller.userId)).map(toMcpTool) };
    } catch (err) {
      // The registry only throws when the database is down; its message is not for clients.
      deps.log.error({ err: { message: (err as Error).message } }, 'mcp tools/list failed');
      throw new McpError(RpcErrorCode.InternalError, 'Internal error');
    }
  });
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // MCP lets a client omit arguments for a tool without parameters.
    const args = req.params.arguments ?? {};
    try {
      const opts = { source: 'mcp' as const, apiKeyId: caller.keyId };
      // The meta-tools answer in either mode; gateway__call_tool still goes through callTool.
      if (isMetaTool(req.params.name)) {
        return await deps.discovery.handle(caller.userId, req.params.name, args, opts);
      }
      return await deps.callTool(caller.userId, req.params.name, args, opts);
    } catch (err) {
      if (err instanceof HttpError) return errorResult(err.code, err.message);
      deps.log.error({ err: { message: (err as Error).message } }, 'mcp tools/call failed');
      return errorResult('INTERNAL', 'Internal error');
    }
  });
  return mcp;
}

function sendUnauthenticated(reply: FastifyReply): FastifyReply {
  return reply
    .code(httpStatusFor('UNAUTHENTICATED'))
    .header('www-authenticate', 'Bearer')
    .send(makeError('UNAUTHENTICATED', 'Invalid or missing API key'));
}

/** audit_log server_slug / tool of a refused /mcp request (the body is never read). */
export const RATE_LIMITED_SLUG = 'gateway';
export const RATE_LIMITED_TOOL = 'mcp';

export interface McpEndpointDeps {
  listToolsFor: ListToolsFor;
  callTool: CallTool;
  discovery: Discovery;
  /** Per-key and per-user limits shared across replicas (ADR 010). Absent: no limit. */
  rateLimit?: { bucket: PgTokenBucket; limits: McpRateLimits } | undefined;
  /** Writes the audit row of a rate-limited request. */
  audit?: ((record: CallRecord) => Promise<void>) | undefined;
  /** Observer of every rate-limited request (metrics). */
  onRateLimited?: ((scope: 'key' | 'user') => void) | undefined;
}

export function registerMcpEndpoint(app: FastifyInstance, deps: McpEndpointDeps): void {
  app.decorateRequest('mcpCaller', null);

  // onRequest: before the body is read, so an unauthenticated or rate-limited client cannot make
  // us parse 1 MB.
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    // Postgres errors propagate to the error handler as a 500: never a 401 for a valid key.
    const auth = await authenticateApiKey(app.pool, req.headers.authorization);
    if (!auth) return sendUnauthenticated(reply);
    req.mcpCaller = { userId: auth.user.id, keyId: auth.keyId };
    if (!deps.rateLimit) return;
    const startedAt = new Date();
    const decision = await checkMcpLimits(deps.rateLimit.bucket, deps.rateLimit.limits, {
      keyId: auth.keyId,
      userId: auth.user.id,
    });
    if (decision.allowed) return;
    req.log.warn(
      { userId: auth.user.id, keyId: auth.keyId, scope: decision.scope },
      'mcp request rate limited',
    );
    deps.onRateLimited?.(decision.scope ?? 'key');
    await deps.audit?.({
      userId: auth.user.id,
      apiKeyId: auth.keyId,
      source: 'mcp',
      serverSlug: RATE_LIMITED_SLUG,
      tool: RATE_LIMITED_TOOL,
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      outcome: 'rate_limited',
      errorCode: 'RATE_LIMITED',
      errorDetail:
        decision.scope === 'user'
          ? FAILURE_DETAILS.rateLimitedUser
          : FAILURE_DETAILS.rateLimitedKey,
      resolved: false,
    });
    const scope = decision.scope === 'user' ? 'this user' : 'this API key';
    return reply
      .code(httpStatusFor('RATE_LIMITED'))
      .header('retry-after', String(decision.retryAfterSeconds))
      .send(
        makeError(
          'RATE_LIMITED',
          `Rate limit exceeded for ${scope}; retry after ${decision.retryAfterSeconds} s`,
        ),
      );
  };

  app.post(MCP_PATH, { onRequest: authenticate, bodyLimit: MCP_BODY_LIMIT }, async (req, reply) => {
    const caller = req.mcpCaller!;
    const mode = toolModeOf(req);
    if (!mode) {
      return reply
        .code(httpStatusFor('VALIDATION_FAILED'))
        .send(makeError('VALIDATION_FAILED', 'Invalid tool mode: use direct or discovery'));
    }
    const mcp = createServer(caller, mode, { ...deps, log: req.log });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err: { message: (err as Error).message } }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify(makeError('INTERNAL', 'Internal error')));
      }
    }
  });

  // Stateless: no SSE stream to resume (GET) and no session to end (DELETE).
  app.route({
    method: ['GET', 'DELETE'],
    url: MCP_PATH,
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send(makeError('VALIDATION_FAILED', 'Method not allowed')),
  });
}
