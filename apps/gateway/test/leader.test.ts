// Several replicas (ADR 010): the health loop runs only on the holder of the `health` lease, so
// two monitors (two replicas) ping each upstream once per tick, not twice, and the lease moves to
// the other replica when the holder stops or its lease expires.
import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthMonitor } from '../src/core/health.js';
import { HEALTH_LEASE, Lease } from '../src/core/leader.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import { freshDatabase } from './helpers/db.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';

describe('Lease', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    pool = createPool(await freshDatabase());
    await migrate(pool, MIGRATIONS_DIR);
  });
  afterEach(async () => {
    await pool.end();
  });

  it('has one holder at a time; the holder renews; release hands it over', async () => {
    const a = new Lease(pool, 'health', 'pod-a', 10_000);
    const b = new Lease(pool, 'health', 'pod-b', 10_000);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(await a.tryAcquire()).toBe(true); // renew
    expect((await Lease.current(pool, 'health'))?.holder).toBe('pod-a');
    await a.release();
    expect(await Lease.current(pool, 'health')).toBeNull();
    expect(await b.tryAcquire()).toBe(true);
    expect(await a.tryAcquire()).toBe(false);
  });

  it('an expired lease is taken over (holder crashed without releasing)', async () => {
    const a = new Lease(pool, 'health', 'pod-a', 200);
    const b = new Lease(pool, 'health', 'pod-b', 200);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect(await b.tryAcquire()).toBe(true);
    expect((await Lease.current(pool, 'health'))?.holder).toBe('pod-b');
  });

  it('concurrent acquires from many replicas: exactly one wins', async () => {
    const leases = Array.from({ length: 8 }, (_, i) => new Lease(pool, 'health', `pod-${i}`));
    const won = await Promise.all(leases.map((l) => l.tryAcquire()));
    expect(won.filter(Boolean)).toHaveLength(1);
  });
});

describe('HealthMonitor with a lease (two replicas)', () => {
  let t: TestApp;
  let fake: FakeUpstream;
  const monitors: HealthMonitor[] = [];

  beforeEach(async () => {
    t = await setupApp({ upstreamAllowedHosts: ['localhost'] });
    fake = await startFakeUpstream({ identity: 'a' });
    const admin = await t.login(ADMIN.email, ADMIN.password);
    const res = await t.request('POST', '/api/upstreams', {
      cookie: admin,
      body: { slug: 'a', name: 'a', url: fake.url },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  afterEach(async () => {
    await Promise.all(monitors.splice(0).map((m) => m.stop()));
    await fake.stop();
    await t.close();
  });

  const replica = (name: string, ttlMs = 10_000) => {
    const m = new HealthMonitor({
      pool: t.pool,
      registry: t.app.tools.registry,
      log: t.app.log,
      intervalMs: 60_000,
      lease: new Lease(t.pool, HEALTH_LEASE, name, ttlMs),
    });
    monitors.push(m);
    return m;
  };

  it('only the lease holder ticks and writes status; stop() hands over to the other', async () => {
    const one = replica('pod-1');
    const two = replica('pod-2');
    expect(await one.tick()).toBe(true);
    expect(await two.tick()).toBe(false);
    expect([one.leader, two.leader]).toEqual([true, false]);
    const { rows } = await t.pool.query<{ status: string; last_checked_at: Date }>(
      `SELECT status, last_checked_at FROM upstreams WHERE slug = 'a'`,
    );
    expect(rows[0]!.status).toBe('up');
    const checkedAt = rows[0]!.last_checked_at.getTime();

    // pod-2's tick wrote nothing.
    await two.tick();
    const after = await t.pool.query<{ last_checked_at: Date }>(
      `SELECT last_checked_at FROM upstreams WHERE slug = 'a'`,
    );
    expect(after.rows[0]!.last_checked_at.getTime()).toBe(checkedAt);

    await one.stop(); // clean shutdown releases the lease
    expect(await two.tick()).toBe(true);
    expect(two.leader).toBe(true);
  });

  it('without a lease every monitor ticks (single replica, as before)', async () => {
    const m = new HealthMonitor({ pool: t.pool, registry: t.app.tools.registry, log: t.app.log });
    monitors.push(m);
    expect(await m.tick()).toBe(true);
    expect(m.leader).toBe(true);
  });
});
