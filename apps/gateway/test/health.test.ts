// Health loop (#13): a dead upstream is marked down in the database and its tools hidden; it comes
// back up when it is reachable again. Real fake MCP upstreams, real Postgres.
import type { UpstreamRow } from '@urumi/contracts/db';
import { MCP_TIMEOUTS } from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayError } from '../src/core/call-tool.js';
import { HealthMonitor } from '../src/core/health.js';
import { TERMINATE_TIMEOUT_MS } from '../src/mcp-client/upstream-client.js';
import { findUpstreamRow } from '../src/upstreams/repo.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import { deadUrl, startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';

let t: TestApp;
let admin: string;
let adminId: string;
let monitor: HealthMonitor;
const fakes: FakeUpstream[] = [];

beforeEach(async () => {
  t = await setupApp({ upstreamAllowedHosts: ['localhost'] });
  admin = await t.login(ADMIN.email, ADMIN.password);
  const { rows } = await t.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    ADMIN.email,
  ]);
  adminId = rows[0]!.id;
  // A long interval: tests drive tick() themselves unless they say otherwise.
  monitor = new HealthMonitor({
    pool: t.pool,
    registry: t.app.tools.registry,
    log: t.app.log,
    intervalMs: 60_000,
  });
});

afterEach(async () => {
  await monitor.stop();
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await t.close();
});

async function addUpstream(slug: string, url: string, enabled = true): Promise<string> {
  const res = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug, name: slug, url, enabled },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { upstream: { id: string } }).upstream.id;
}

async function row(id: string): Promise<UpstreamRow> {
  return (await findUpstreamRow(t.pool, id))!;
}

async function toolNames(): Promise<string[]> {
  const res = await t.request('GET', '/api/tools', { cookie: admin });
  return (res.json() as { tools: { name: string }[] }).tools.map((x) => x.name);
}

it('checks every 15 s by default', () => {
  expect(MCP_TIMEOUTS.healthIntervalMs).toBe(15_000);
  const m = new HealthMonitor({ pool: t.pool, registry: t.app.tools.registry, log: t.app.log });
  expect(m.intervalMs).toBe(15_000);
  expect(m.timeoutMs).toBe(3000);
});

describe('dead upstream', () => {
  it('is marked down with last_error, hidden, and comes back up on the same port', async () => {
    const a = await startFakeUpstream({ identity: 'server-a' });
    fakes.push(a);
    const b = await startFakeUpstream({ identity: 'server-b' });
    fakes.push(b);
    const id = await addUpstream('a', a.url);
    await addUpstream('b', b.url);

    await monitor.tick();
    expect(await row(id)).toMatchObject({ status: 'up', last_error: null });
    expect(await toolNames()).toEqual(['a__search', 'b__search']);

    await a.stop();
    await monitor.tick();
    const down = await row(id);
    expect(down.status).toBe('down');
    expect(down.last_error).toBeTruthy();
    expect(down.last_error!.length).toBeLessThanOrEqual(200);
    expect(down.last_error).not.toMatch(/localhost|127\.0\.0\.1|http|:\d{2,5}/);
    expect(down.last_checked_at).toBeInstanceOf(Date);
    // Hidden immediately, even though a's list was cached seconds ago.
    expect(await toolNames()).toEqual(['b__search']);
    const err = await t.app.tools
      .callTool(adminId, 'a__search', {}, { source: 'chat' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe('UPSTREAM_UNREACHABLE');

    await a.start(); // same port
    await monitor.tick();
    const up = await row(id);
    expect(up).toMatchObject({ status: 'up', last_error: null });
    expect(up.last_checked_at!.getTime()).toBeGreaterThan(down.last_checked_at!.getTime());
    expect(await toolNames()).toEqual(['a__search', 'b__search']);
  });

  it('marks an upstream that was never reachable as down', async () => {
    const id = await addUpstream('gone', await deadUrl());
    await monitor.tick();
    expect(await row(id)).toMatchObject({ status: 'down' });
    expect((await row(id)).last_error).toBeTruthy();
  });

  it('marks a slow upstream down after the ping timeout', async () => {
    const slow = await startFakeUpstream({ identity: 'slow', listDelayMs: 5000 });
    fakes.push(slow);
    const id = await addUpstream('slow', slow.url);
    const fast = new HealthMonitor({
      pool: t.pool,
      registry: t.app.tools.registry,
      log: t.app.log,
      timeoutMs: 300,
    });
    const started = Date.now();
    await fast.tick();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await row(id)).toMatchObject({ status: 'down', last_error: 'Timed out' });
  });

  it('does not check disabled upstreams', async () => {
    const a = await startFakeUpstream({ identity: 'server-a' });
    fakes.push(a);
    const id = await addUpstream('a', a.url, false);
    await monitor.tick();
    expect(a.requests).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: 'unknown', last_checked_at: null });
  });

  it('does not overwrite the status of an upstream whose URL changed during the check', async () => {
    const slow = await startFakeUpstream({ identity: 'slow', listDelayMs: 600 });
    fakes.push(slow);
    const other = await startFakeUpstream({ identity: 'other' });
    fakes.push(other);
    const id = await addUpstream('a', slow.url);

    const tick = monitor.tick();
    await new Promise((r) => setTimeout(r, 100)); // the check is now waiting on `slow`
    const res = await t.request('PATCH', `/api/upstreams/${id}`, {
      cookie: admin,
      body: { url: other.url },
    });
    expect(res.statusCode, res.body).toBe(200);
    await tick;
    // The result described the old URL; the edit reset status to unknown and it stays so.
    expect(await row(id)).toMatchObject({ status: 'unknown', last_checked_at: null });
  });
});

describe('loop', () => {
  it('runs on its interval after start() and stops on stop()', async () => {
    const a = await startFakeUpstream({ identity: 'server-a' });
    fakes.push(a);
    const id = await addUpstream('a', a.url);
    const loop = new HealthMonitor({
      pool: t.pool,
      registry: t.app.tools.registry,
      log: t.app.log,
      intervalMs: 50,
    });
    loop.start();
    try {
      const deadline = Date.now() + 5000;
      while ((await row(id)).status !== 'up' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect((await row(id)).status).toBe('up');
    } finally {
      await loop.stop();
    }
    const checkedAt = (await row(id)).last_checked_at!.getTime();
    await new Promise((r) => setTimeout(r, 200));
    expect((await row(id)).last_checked_at!.getTime()).toBe(checkedAt);
  });
});

describe('stateful upstream sessions', () => {
  it('terminates the MCP session after every health check (no sessions pile up)', async () => {
    const a = await startFakeUpstream({ identity: 'server-a', stateful: true });
    fakes.push(a);
    const id = await addUpstream('a', a.url);
    const N = 5;
    for (let i = 1; i <= N; i++) {
      await monitor.tick();
      expect(a.liveSessions(), `after check ${i}`).toBe(0);
    }
    expect((await row(id)).status).toBe('up');
    const deletes = a.requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(N);
    expect(new Set(deletes.map((r) => r.headers['mcp-session-id'])).size).toBe(N);
  });

  it('terminates the session after a tool call too', async () => {
    const a = await startFakeUpstream({ identity: 'server-a', stateful: true });
    fakes.push(a);
    await addUpstream('a', a.url);
    await monitor.tick();
    await t.app.tools.callTool(adminId, 'a__search', { q: 'x' }, { source: 'chat' });
    expect(a.calls).toHaveLength(1);
    expect(a.liveSessions()).toBe(0);
  });

  it('bounds the DELETE: an upstream that never answers it delays a check by about 1 s', async () => {
    const a = await startFakeUpstream({ identity: 'server-a', stateful: true, deleteHangs: true });
    fakes.push(a);
    const id = await addUpstream('a', a.url);
    const started = Date.now();
    await monitor.tick();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TERMINATE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(TERMINATE_TIMEOUT_MS + 1500);
    expect(await row(id)).toMatchObject({ status: 'up', last_error: null });
    expect(a.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('sends no DELETE to a stateless upstream (it has no session id)', async () => {
    const a = await startFakeUpstream({ identity: 'server-a' });
    fakes.push(a);
    await addUpstream('a', a.url);
    await monitor.tick();
    expect(a.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });
});
