import pg from 'pg';
import type { DbConfig } from '../config.js';

export const STATEMENT_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 3000;

interface Logger {
  error(obj: object, msg: string): void;
}

export function createPool(db: DbConfig, log?: Logger): pg.Pool {
  const pool = new pg.Pool({
    ...db,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'urumi-gateway',
  });
  // An idle client losing its connection (e.g. Postgres restart) emits 'error' on the pool;
  // without a listener that would crash the process. The pool replaces the client on next use.
  pool.on('error', (err) =>
    log?.error({ err: { message: err.message } }, 'idle Postgres client error'),
  );
  return pool;
}
