// Rate limits (ADR 010): the Postgres token bucket shared by replicas — pure refill / Retry-After
// math, the bucket against real Postgres (including two pools acting as two replicas), and /mcp
// answering 429 + Retry-After with an audit row `rate_limited` once a key's burst is spent.
import type { AddressInfo } from 'node:net';
import { MCP_PATH } from '@urumi/contracts';
import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { RATE_LIMITED_SLUG, RATE_LIMITED_TOOL } from '../src/mcp/endpoint.js';
import {
  checkMcpLimits,
  PgTokenBucket,
  refill,
  retryAfterSeconds,
} from '../src/ratelimit/bucket.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import { freshDatabase } from './helpers/db.js';

describe('bucket math', () => {
  it('refills at perMinute/60 per second, capped at the burst', () => {
    const limit = { perMinute: 60, burst: 10 };
    expect(refill(0, 1, limit)).toBe(1);
    expect(refill(2.5, 3, limit)).toBe(5.5);
    expect(refill(9, 60, limit)).toBe(10);
    expect(refill(4, -5, limit)).toBe(4); // clock skew never drains a bucket
  });

  it('Retry-After is the whole seconds until one token is back, at least 1', () => {
    expect(retryAfterSeconds(0, 60)).toBe(1);
    expect(retryAfterSeconds(0, 30)).toBe(2);
    expect(retryAfterSeconds(0.5, 6)).toBe(5);
    expect(retryAfterSeconds(0.99, 6000)).toBe(1);
    expect(retryAfterSeconds(0, 0)).toBe(60);
  });
});

describe('PgTokenBucket (real Postgres)', () => {
  let pools: pg.Pool[] = [];

  beforeEach(async () => {
    const db = await freshDatabase();
    // Two pools on one database: two gateway replicas.
    pools = [createPool(db), createPool(db)];
    await migrate(pools[0]!, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await Promise.all(pools.map((p) => p.end()));
  });

  it('allows `burst` requests back to back, then refuses with a Retry-After', async () => {
    const bucket = new PgTokenBucket(pools[0]!);
    const limit = { perMinute: 6, burst: 3 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await bucket.take('key:a', limit));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    // 6/min = one token per 10 s.
    expect(results[3]!.retryAfterSeconds).toBeGreaterThanOrEqual(5);
    expect(results[3]!.retryAfterSeconds).toBeLessThanOrEqual(10);
    // A refusal takes nothing: the stored count is unchanged (≈ 0, plus refill).
    const { rows } = await pools[0]!.query<{ tokens: number }>(
      `SELECT tokens FROM rate_limit_buckets WHERE key = 'key:a'`,
    );
    expect(Number(rows[0]!.tokens)).toBeLessThan(0.5);
  });

  it('is shared by replicas: 40 concurrent requests from two pools pass exactly `burst`', async () => {
    const limit = { perMinute: 1, burst: 10 };
    const buckets = pools.map((p) => new PgTokenBucket(p));
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => buckets[i % 2]!.take('user:u', limit)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('refills over time (Postgres clock)', async () => {
    const bucket = new PgTokenBucket(pools[0]!);
    const limit = { perMinute: 60, burst: 1 }; // one token per second
    expect((await bucket.take('key:t', limit)).allowed).toBe(true);
    expect((await bucket.take('key:t', limit)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await bucket.take('key:t', limit)).allowed).toBe(true);
  });

  it('keeps buckets apart and treats burst 0 as unlimited', async () => {
    const bucket = new PgTokenBucket(pools[0]!);
    const one = { perMinute: 1, burst: 1 };
    expect((await bucket.take('key:x', one)).allowed).toBe(true);
    expect((await bucket.take('key:y', one)).allowed).toBe(true);
    expect((await bucket.take('key:x', one)).allowed).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect((await bucket.take('key:z', { perMinute: 0, burst: 0 })).allowed).toBe(true);
    }
    const { rows } = await pools[0]!.query(`SELECT 1 FROM rate_limit_buckets WHERE key = 'key:z'`);
    expect(rows).toHaveLength(0);
  });

  it("checkMcpLimits: the user budget is shared by all of a user's keys", async () => {
    const bucket = new PgTokenBucket(pools[0]!);
    const limits = { perKey: { perMinute: 1, burst: 5 }, perUser: { perMinute: 1, burst: 3 } };
    const k1 = { keyId: 'k1', userId: 'u1' };
    const k2 = { keyId: 'k2', userId: 'u1' };
    expect((await checkMcpLimits(bucket, limits, k1)).allowed).toBe(true);
    expect((await checkMcpLimits(bucket, limits, k2)).allowed).toBe(true);
    expect((await checkMcpLimits(bucket, limits, k1)).allowed).toBe(true);
    const fourth = await checkMcpLimits(bucket, limits, k2);
    expect(fourth).toMatchObject({ allowed: false, scope: 'user' });
    // Another user is unaffected; a key over its own burst is refused with scope 'key'.
    const solo = { perKey: { perMinute: 1, burst: 1 }, perUser: { perMinute: 1, burst: 9 } };
    expect((await checkMcpLimits(bucket, solo, { keyId: 'k3', userId: 'u2' })).allowed).toBe(true);
    expect(await checkMcpLimits(bucket, solo, { keyId: 'k3', userId: 'u2' })).toMatchObject({
      allowed: false,
      scope: 'key',
    });
  });
});

describe('/mcp rate limit', () => {
  let t: TestApp;
  let base: string;

  beforeEach(async () => {
    t = await setupApp({
      mcpRateLimits: {
        perKey: { perMinute: 6, burst: 3 },
        perUser: { perMinute: 600, burst: 100 },
      },
    });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await t.close();
  });

  const ping = (secret: string) =>
    fetch(`${base}${MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

  it('answers 429 + Retry-After + RATE_LIMITED once the key burst is spent, and audits it', async () => {
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const res = await t.request('POST', '/api/keys', { cookie: admin, body: { name: 'burst' } });
    const { secret, key } = res.json() as { secret: string; key: { id: string } };

    const statuses: number[] = [];
    let refused: Response | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await ping(secret);
      statuses.push(r.status);
      if (r.status === 429) refused ??= r;
      else await r.text();
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(Number(refused!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = (await refused!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toMatch(/this API key/);
    expect(body.error.message).not.toContain(secret);

    const { rows } = await t.pool.query(
      `SELECT api_key_id, source, server_slug, tool, outcome, error_code FROM audit_log
       WHERE outcome = 'rate_limited'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      api_key_id: key.id,
      source: 'mcp',
      server_slug: RATE_LIMITED_SLUG,
      tool: RATE_LIMITED_TOOL,
      outcome: 'rate_limited',
      error_code: 'RATE_LIMITED',
    });
    // The audit API (and dashboard filter) accept the new outcome.
    const audit = await t.request('GET', '/api/audit?outcome=rate_limited', { cookie: admin });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it('checks the key before the limit: a bad key is a 401 and takes no token', async () => {
    const r = await ping('not-a-key');
    expect(r.status).toBe(401);
    const { rows } = await t.pool.query('SELECT 1 FROM rate_limit_buckets');
    expect(rows).toHaveLength(0);
  });
});
