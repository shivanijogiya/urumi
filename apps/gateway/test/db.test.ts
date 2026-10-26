// Integration tests against a real Postgres (see global-setup.ts). Each test uses its own database.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import { ErrorEnvelopeSchema } from '@urumi/contracts';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import type { DbConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { seedAdmin } from '../src/db/seed.js';
import { buildApp } from '../src/server.js';
import { freshDatabase } from './helpers/db.js';

const TABLES = [
  'api_keys',
  'audit_log',
  'gateway_leases',
  'rate_limit_buckets',
  'sessions',
  'tool_permissions',
  'upstreams',
  'users',
];
const ADMIN = { email: 'admin@example.com', password: 'first-admin-password' };
const encKey = randomBytes(32);

const pools: pg.Pool[] = [];
function pool(db: DbConfig): pg.Pool {
  const p = createPool(db);
  pools.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

async function versions(p: pg.Pool): Promise<string[]> {
  const { rows } = await p.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return rows.map((r) => r.version);
}

async function tables(p: pg.Pool): Promise<string[]> {
  const { rows } = await p.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

describe('migrate', () => {
  it('applies the contracts migrations and records each version', async () => {
    const p = pool(await freshDatabase());
    expect(await migrate(p, MIGRATIONS_DIR)).toEqual(['001', '002', '003', '004']);
    expect(await versions(p)).toEqual(['001', '002', '003', '004']);
    expect(await tables(p)).toEqual(TABLES);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const p = pool(await freshDatabase());
    await migrate(p, MIGRATIONS_DIR);
    expect(await migrate(p, MIGRATIONS_DIR)).toEqual([]);
    expect(await versions(p)).toEqual(['001', '002', '003', '004']);
  });

  it('is safe when two instances start at once (advisory lock)', async () => {
    const db = await freshDatabase();
    const results = await Promise.all([
      migrate(pool(db), MIGRATIONS_DIR),
      migrate(pool(db), MIGRATIONS_DIR),
    ]);
    expect(results.flat()).toEqual(['001', '002', '003', '004']);
    expect(await versions(pool(db))).toEqual(['001', '002', '003', '004']);
  });

  it('rolls back a failing file completely and does not record it', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '001_ok.sql'), 'CREATE TABLE a (id int);');
    await writeFile(join(dir, '002_bad.sql'), 'CREATE TABLE b (id int); SELECT broken_syntax(;');
    await writeFile(join(dir, 'README.md'), 'not a migration');

    const p = pool(await freshDatabase());
    await expect(migrate(p, dir)).rejects.toThrow(/002_bad\.sql/);
    expect(await versions(p)).toEqual(['001']);
    expect(await tables(p)).toEqual(['a']);
  });
});

describe('seedAdmin', () => {
  async function admins(p: pg.Pool) {
    const { rows } = await p.query<{ email: string; password_hash: string; role: string }>(
      "SELECT email, password_hash, role FROM users WHERE role = 'admin'",
    );
    return rows;
  }

  it('creates one admin with a scrypt hash, and a second run changes nothing', async () => {
    const p = pool(await freshDatabase());
    await migrate(p, MIGRATIONS_DIR);

    expect(await seedAdmin(p, ADMIN)).toBe('created');
    const first = await admins(p);
    expect(first).toHaveLength(1);
    expect(first[0]!.email).toBe(ADMIN.email);
    expect(first[0]!.password_hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword(ADMIN.password, first[0]!.password_hash)).toBe(true);

    expect(await seedAdmin(p, ADMIN)).toBe('exists');
    expect(await admins(p)).toEqual(first);
  });

  it('does not overwrite an existing admin password (Secret changed after first start)', async () => {
    const p = pool(await freshDatabase());
    await migrate(p, MIGRATIONS_DIR);
    await seedAdmin(p, ADMIN);
    const before = await admins(p);

    expect(await seedAdmin(p, { ...ADMIN, password: 'a-different-password' })).toBe('exists');
    expect(await seedAdmin(p, { email: 'other@example.com', password: 'another-password' })).toBe(
      'exists',
    );
    const after = await admins(p);
    expect(after).toEqual(before);
    expect(await verifyPassword(ADMIN.password, after[0]!.password_hash)).toBe(true);
  });

  it('creates only one admin when two instances seed at once', async () => {
    const db = await freshDatabase();
    await migrate(pool(db), MIGRATIONS_DIR);
    const results = await Promise.all([seedAdmin(pool(db), ADMIN), seedAdmin(pool(db), ADMIN)]);
    expect(results.sort()).toEqual(['created', 'exists']);
    expect(await admins(pool(db))).toHaveLength(1);
  });
});

describe('health endpoints', () => {
  async function closedPort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as { port: number };
    await new Promise((r) => srv.close(r));
    return port;
  }

  it('/healthz is 200 and /readyz is 200 when the database answers', async () => {
    const app = buildApp({ pool: pool(await freshDatabase()), encKey });
    try {
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
      const ready = await app.inject({ url: '/readyz' });
      expect(ready.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('/readyz is 503 with the error envelope when the database is unreachable', async () => {
    const app = buildApp({
      pool: pool({
        host: '127.0.0.1',
        port: await closedPort(),
        user: 'x',
        password: 'y',
        database: 'z',
      }),
      encKey,
    });
    try {
      const started = Date.now();
      const res = await app.inject({ url: '/readyz' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.statusCode).toBe(503);
      const body = ErrorEnvelopeSchema.parse(res.json());
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
      // Liveness does not depend on the database.
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('unknown routes get the error envelope', async () => {
    const app = buildApp({ pool: pool(await freshDatabase()), encKey });
    try {
      const res = await app.inject({ url: '/nope' });
      expect(res.statusCode).toBe(404);
      expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});
