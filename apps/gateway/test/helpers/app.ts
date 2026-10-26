// A real gateway app on a fresh, migrated, seeded database. Only `app.inject` is used: no sockets.
import { randomBytes } from 'node:crypto';
import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import { SESSION_COOKIE } from '@urumi/contracts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { seedAdmin } from '../../src/db/seed.js';
import { buildApp, type AppDeps } from '../../src/server.js';
import { dropDatabase, freshDatabase } from './db.js';

export const ADMIN = { email: 'admin@example.com', password: 'first-admin-password' };
export const PUBLIC_ORIGIN = 'http://app.localtest.me';
/** GATEWAY_ENC_KEY for test apps; random per test run. */
export const ENC_KEY = randomBytes(32);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface TestApp {
  app: FastifyInstance;
  pool: pg.Pool;
  request(
    method: Method,
    url: string,
    opts?: { cookie?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
  /** Logs in and returns the `name=value` cookie pair, failing loudly if login does not work. */
  login(email: string, password: string): Promise<string>;
  /** Creates a user through the admin API; returns its id and one-time password. */
  createUser(
    adminCookie: string,
    user: { email: string; name?: string; role?: 'admin' | 'member' },
  ): Promise<{ id: string; tempPassword: string }>;
  close(): Promise<void>;
}

export interface SetupOptions {
  /**
   * 'seeded' keeps the default tool permissions of 002_tool_permissions.sql (members read-only
   * on woo/everything/gitlab, nothing else). 'open' (default) adds a member `* *` allow rule so
   * suites about aggregation, chat, audit and the MCP endpoint can call their fake upstreams as a
   * member; test/permissions.test.ts covers the policy itself with 'seeded'.
   */
  toolPermissions?: 'open' | 'seeded';
}

export async function setupApp(
  deps: Partial<AppDeps> = {},
  opts: SetupOptions = {},
): Promise<TestApp> {
  const db = await freshDatabase();
  const pool = createPool(db);
  await migrate(pool, MIGRATIONS_DIR);
  await seedAdmin(pool, ADMIN);
  if ((opts.toolPermissions ?? 'open') === 'open') {
    await pool.query(
      `INSERT INTO tool_permissions (role, server_slug, tool, effect) VALUES ('member', '*', '*', 'allow')`,
    );
  }
  const app = buildApp({ pool, publicOrigin: PUBLIC_ORIGIN, encKey: ENC_KEY, ...deps });
  await app.ready();

  const request: TestApp['request'] = (method, url, opts = {}) =>
    app.inject({
      method,
      url,
      headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
      ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    });

  const login: TestApp['login'] = async (email, password) => {
    const res = await request('POST', '/api/auth/login', { body: { email, password } });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
    return sessionCookie(res)!;
  };

  const createUser: TestApp['createUser'] = async (adminCookie, user) => {
    const res = await request('POST', '/api/users', {
      cookie: adminCookie,
      body: { name: 'Test User', role: 'member', ...user },
    });
    if (res.statusCode !== 201) throw new Error(`create user failed: ${res.statusCode}`);
    const body = res.json() as { user: { id: string }; tempPassword: string };
    return { id: body.user.id, tempPassword: body.tempPassword };
  };

  return {
    app,
    pool,
    request,
    login,
    createUser,
    close: async () => {
      await app.close();
      await pool.end();
      await dropDatabase(db);
    },
  };
}

/** The raw Set-Cookie header for the session cookie, if any. */
export function setCookieHeader(res: LightMyRequestResponse): string | undefined {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return all.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

/** `urumi_session=<token>` from a response, for the next request's Cookie header. */
export function sessionCookie(res: LightMyRequestResponse): string | undefined {
  return setCookieHeader(res)?.split(';')[0];
}

export function tokenOf(cookie: string): string {
  return cookie.slice(SESSION_COOKIE.length + 1);
}
