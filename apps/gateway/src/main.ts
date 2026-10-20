// Gateway entry point: config -> wait for Postgres -> migrate -> seed admin -> listen.
import { ConfigError, loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { seedAdmin } from './db/seed.js';
import { buildApp, LOGGER_OPTIONS } from './server.js';

const DB_WAIT_MS = 120_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Same JSON shape as the app logs; the message names variables, never values.
      console.error(JSON.stringify({ level: 60, time: Date.now(), msg: err.message }));
      process.exit(1);
    }
    throw err;
  }

  // The pool only logs after startup, by which time `server` exists.
  const pool = createPool(config.db, { error: (obj, msg) => server.log.error(obj, msg) });
  const server = buildApp({
    pool,
    logger: LOGGER_OPTIONS,
    publicOrigin: config.publicOrigin,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    encKey: config.encKey,
    upstreamAllowedHosts: config.upstreamAllowedHosts,
  });

  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'shutting down');
    await server.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await waitForDatabase(pool, server.log);
  await migrate(pool, config.migrationsDir, server.log);
  await seedAdmin(pool, config.seedAdmin, server.log);
  await server.listen({ host: '0.0.0.0', port: config.port });
}

async function waitForDatabase(
  pool: ReturnType<typeof createPool>,
  log: { warn(obj: object, msg: string): void },
): Promise<void> {
  const deadline = Date.now() + DB_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error('Postgres not reachable', { cause: err });
      log.warn({ attempt, err: { message: (err as Error).message } }, 'waiting for Postgres');
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
}

main().catch((err: Error) => {
  console.error(
    JSON.stringify({ level: 60, time: Date.now(), msg: 'startup failed', err: err.message }),
  );
  process.exit(1);
});
