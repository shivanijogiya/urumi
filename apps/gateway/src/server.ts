import { httpStatusFor, makeError } from '@urumi/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { createAuditWriter } from './audit/hook.js';
import { registerAuditRoutes } from './audit/routes.js';
import { IP_MAX_FAILURES, LoginLimiter } from './auth/login-limiter.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { AnthropicLike } from './chat/anthropic.js';
import { ChatRateLimiter } from './chat/rate-limit.js';
import { registerChatRoutes } from './chat/routes.js';
import { createChatService } from './chat/service.js';
import { createCallTool, type CallRecord, type CallTool } from './core/call-tool.js';
import { ToolRegistry } from './core/registry.js';
import { registerCsrfGuard } from './http/csrf.js';
import { HttpError } from './http/errors.js';
import { registerKeyRoutes } from './keys/routes.js';
import { registerMcpEndpoint } from './mcp/endpoint.js';
import { UpstreamClient } from './mcp-client/upstream-client.js';
import { registerToolRoutes } from './tools/routes.js';
import { registerUpstreamRoutes } from './upstreams/routes.js';
import type { LookupFn } from './upstreams/ssrf.js';
import { registerUserRoutes } from './users/routes.js';

export const READY_TIMEOUT_MS = 1000;

/** Aggregation and the one call path, shared by routes, the MCP endpoint (#15) and chat (#19). */
export interface ToolService {
  registry: ToolRegistry;
  callTool: CallTool;
}

declare module 'fastify' {
  interface FastifyInstance {
    tools: ToolService;
  }
}

export interface AppDeps {
  pool: pg.Pool;
  /** Fastify logger options; tests pass nothing (silent). */
  logger?: FastifyServerOptions['logger'];
  /** Dashboard origin for the CSRF Origin check. Default http://app.localtest.me. */
  publicOrigin?: string;
  /** Adds `Secure` to the session cookie. Default false (plain HTTP locally). */
  cookieSecure?: boolean;
  /**
   * Fastify trustProxy: take the client IP (per-IP login throttle) from X-Forwarded-For. Default
   * false (direct connections, tests); main.ts passes TRUST_PROXY.
   */
  trustProxy?: boolean | number;
  /** GATEWAY_ENC_KEY: AES-256-GCM key for upstream credentials. */
  encKey: Buffer;
  /** UPSTREAM_ALLOWED_HOSTS (normalised): hosts exempt from the SSRF address check. Default none. */
  upstreamAllowedHosts?: readonly string[];
  /** DNS resolver for the SSRF guard; tests inject a stub. Default: the system resolver. */
  lookup?: LookupFn;
  /** Upstream timeouts; default MCP_TIMEOUTS (list 3 s, call 15 s). Tests shorten them. */
  mcpTimeouts?: { listMs?: number; callMs?: number };
  /** Extra observer of every finished callTool, after its audit_log row is written. */
  onCallFinished?: (record: CallRecord) => void | Promise<void>;
  /**
   * Chat agent (#19). `anthropic` is null (or `chat` absent) when ANTHROPIC_API_KEY is unset:
   * /api/chat then answers 503. Tests inject a scripted client.
   */
  chat?: { anthropic: AnthropicLike | null; model?: string };
}

/**
 * JSON logs; credentials in headers are never written. Request bodies are not logged; an upstream
 * `credential` is censored anyway should one ever end up in a log object.
 */
export const LOGGER_OPTIONS = {
  level: 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
      'credential',
      '*.credential',
      'req.body.credential',
    ],
    censor: '[redacted]',
  },
} satisfies FastifyServerOptions['logger'];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const options: FastifyServerOptions = {
    logger: deps.logger ?? false,
    trustProxy: toTrustProxy(deps.trustProxy),
  };
  const app = Fastify(options);
  app.decorate('pool', deps.pool);
  app.decorate('cookieSecure', deps.cookieSecure ?? false);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  // Probes run every few seconds; keep them out of the info log.
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel: 'warn' }, async (req, reply) => {
    try {
      await withTimeout(deps.pool.query('SELECT 1'), READY_TIMEOUT_MS);
      return { status: 'ok' };
    } catch (err) {
      req.log.warn({ err: { message: (err as Error).message } }, 'readiness check failed');
      // No 503 code in the contracts table: INTERNAL is the closest, with 503 so the pod is unready.
      return reply.code(503).send(makeError('INTERNAL', 'Database is not reachable'));
    }
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(httpStatusFor('NOT_FOUND')).send(makeError('NOT_FOUND', 'Route not found')),
  );

  // The one error handler: everything leaves as the contracts envelope. SQL errors, stack traces
  // and Fastify internals are logged, never sent.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send(makeError(err.code, err.message));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      // Fastify's own client errors: malformed JSON, body too large, bad content type.
      return reply.code(400).send(makeError('VALIDATION_FAILED', 'Invalid request'));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(makeError('INTERNAL', 'Internal error'));
  });

  registerCsrfGuard(app, deps.publicOrigin ?? 'http://app.localtest.me');
  registerAuthRoutes(app, {
    email: new LoginLimiter(),
    ip: new LoginLimiter({ maxFailures: IP_MAX_FAILURES }),
  });
  const allowedHosts = deps.upstreamAllowedHosts ?? [];
  const lookup = deps.lookup ? { lookup: deps.lookup } : {};
  const client = new UpstreamClient({
    encKey: deps.encKey,
    allowedHosts,
    ...lookup,
    log: app.log,
  });
  const registry = new ToolRegistry({
    pool: deps.pool,
    client,
    log: app.log,
    ...(deps.mcpTimeouts?.listMs ? { listTimeoutMs: deps.mcpTimeouts.listMs } : {}),
  });
  const writeAudit = createAuditWriter(deps.pool, app.log);
  const callTool = createCallTool({
    pool: deps.pool,
    registry,
    client,
    log: app.log,
    ...(deps.mcpTimeouts?.callMs ? { callTimeoutMs: deps.mcpTimeouts.callMs } : {}),
    onCallFinished: async (record) => {
      await writeAudit(record);
      await deps.onCallFinished?.(record);
    },
  });
  app.decorate('tools', { registry, callTool });

  registerUserRoutes(app);
  registerKeyRoutes(app);
  registerUpstreamRoutes(app, { encKey: deps.encKey, allowedHosts, ...lookup, registry });
  registerToolRoutes(app, registry);
  registerAuditRoutes(app);
  registerMcpEndpoint(app, { registry, callTool });
  const anthropic = deps.chat?.anthropic;
  registerChatRoutes(app, {
    service: anthropic
      ? createChatService({
          anthropic,
          listTools: () => registry.listTools(),
          callTool,
          ...(deps.chat?.model ? { model: deps.chat.model } : {}),
        })
      : null,
    limiter: new ChatRateLimiter(),
  });

  return app;
}

/** Fastify's types reject a hop count; express it as the equivalent function (trust the first n hops). */
function toTrustProxy(
  v: boolean | number | undefined,
): boolean | ((addr: string, hop: number) => boolean) {
  if (typeof v === 'number') return (_addr, hop) => hop < v;
  return v ?? false;
}
