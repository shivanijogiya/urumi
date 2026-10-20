// Creates the initial admin from SEED_ADMIN_* when no admin exists. Never updates an existing user,
// so restarts (or a changed Secret) neither duplicate the admin nor reset its password.
import type pg from 'pg';
import { hashPassword } from '../auth/password.js';

/** Transaction-scoped advisory lock key ('uru2'), separate from the migration lock. */
const SEED_LOCK_KEY = 0x75727532;

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export type SeedResult = 'created' | 'exists' | 'email-taken';

async function adminExists(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
  return (rowCount ?? 0) > 0;
}

export async function seedAdmin(
  pool: pg.Pool,
  admin: { email: string; password: string },
  log?: Logger,
): Promise<SeedResult> {
  if (await adminExists(pool)) return 'exists';

  // Hash outside the transaction so the lock is held only for the check + insert.
  const passwordHash = await hashPassword(admin.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_KEY]);
    if (await adminExists(client)) {
      await client.query('ROLLBACK');
      return 'exists';
    }
    const { rowCount } = await client.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)
       ON CONFLICT (email) DO NOTHING`,
      [admin.email.toLowerCase(), passwordHash],
    );
    await client.query('COMMIT');
    if (!rowCount) {
      log?.warn({}, 'SEED_ADMIN_EMAIL belongs to an existing non-admin user; no admin created');
      return 'email-taken';
    }
    log?.info({}, 'initial admin created');
    return 'created';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
