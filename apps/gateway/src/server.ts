import { httpStatusFor, makeError } from '@urumi/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { IP_MAX_FAILURES, LoginLimiter } from './auth/login-limiter.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerCsrfGuard } from './http/csrf.js';
import { HttpError } from './http/errors.js';
import { registerKeyRoutes } from './keys/routes.js';
import { registerUserRoutes } from './users/routes.js';

export const READY_TIMEOUT_MS = 1000;

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
}

/** JSON logs; credentials in headers are never written. */
export const LOGGER_OPTIONS = {
  level: 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
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
  registerUserRoutes(app);
  registerKeyRoutes(app);

  return app;
}

/** Fastify's types reject a hop count; express it as the equivalent function (trust the first n hops). */
function toTrustProxy(
  v: boolean | number | undefined,
): boolean | ((addr: string, hop: number) => boolean) {
  if (typeof v === 'number') return (_addr, hop) => hop < v;
  return v ?? false;
}
