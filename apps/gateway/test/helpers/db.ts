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
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { connectionString: url.toString() };
}
