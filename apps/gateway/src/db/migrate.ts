// Migration runner. Applies `NNN_name.sql` files from a directory in order, each in its own
// transaction, and records `NNN` in schema_migrations. A session advisory lock serialises
// concurrent gateway starts, so every file runs exactly once.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

/** Arbitrary app-wide key for pg_advisory_lock ('uru1'). */
const LOCK_KEY = 0x75727531;
const LOCK_WAIT_MS = 120_000;
/** Per-file limit; overrides the pool's 5 s statement_timeout inside the migration transaction. */
const FILE_TIMEOUT = '120s';
const FILE_PATTERN = /^(\d+)_[\w-]+\.sql$/;

interface Logger {
  info(obj: object, msg: string): void;
}

async function listMigrations(dir: string): Promise<{ version: string; file: string }[]> {
  const found = (await readdir(dir))
    .map((file) => ({ file, m: FILE_PATTERN.exec(file) }))
    .filter((x) => x.m)
    .map(({ file, m }) => ({ version: m![1]!, file }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const seen = new Set<string>();
  for (const { version } of found) {
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version} in ${dir}`);
    seen.add(version);
  }
  return found;
}

/**
 * Waits for the advisory lock with pg_try_advisory_lock polling, so the wait is bounded by
 * LOCK_WAIT_MS rather than cancelled by the pool's statement_timeout.
 */
async function acquireLock(client: pg.PoolClient): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      LOCK_KEY,
    ]);
    if (rows[0]?.ok) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the migration lock');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Applies pending migrations; returns the versions applied by this call (in order). */
export async function migrate(pool: pg.Pool, dir: string, log?: Logger): Promise<string[]> {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await acquireLock(client);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      const done = new Set(rows.map((r) => r.version));
      const applied: string[] = [];
      for (const { version, file } of migrations) {
        if (done.has(version)) continue;
        const sql = await readFile(join(dir, file), 'utf8');
        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL statement_timeout = '${FILE_TIMEOUT}'`);
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
        log?.info({ version, file }, 'migration applied');
        applied.push(version);
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } catch (err) {
    broken = err as Error;
    throw err;
  } finally {
    // On any error, discard the connection: that also drops a lock we might still hold.
    client.release(broken);
  }
}
