import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import type { DbConfig } from '../../src/config.js';

/** Creates an empty database on the test server and returns a DbConfig pointing at it. */
export async function freshDatabase(): Promise<DbConfig> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // FILE_COPY: the default WAL_LOG strategy writes the whole template into the WAL for every
    // test database, which made a full run hold GBs of WAL on the test server's volume.
    await admin.query(`CREATE DATABASE ${name} STRATEGY = FILE_COPY`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { connectionString: url.toString() };
}

/** Drops a database made by freshDatabase (best effort), so a run does not keep every test's data. */
export async function dropDatabase(db: DbConfig): Promise<void> {
  if (!('connectionString' in db)) return;
  const name = new URL(db.connectionString).pathname.slice(1);
  if (!/^t_[0-9a-f]{12}$/.test(name)) return;
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  try {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } catch {
    // Teardown removes the whole server anyway.
  } finally {
    await admin.end().catch(() => undefined);
  }
}
