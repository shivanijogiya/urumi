import { httpStatusFor, makeError } from '@urumi/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

export const READY_TIMEOUT_MS = 1000;

export interface AppDeps {
  pool: pg.Pool;
  /** Fastify logger options; tests pass nothing (silent). */
  logger?: FastifyServerOptions['logger'];
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
  const app = Fastify({ logger: deps.logger ?? false });

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

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(400).send(makeError('VALIDATION_FAILED', 'Invalid request'));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(makeError('INTERNAL', 'Internal error'));
  });

  return app;
}
