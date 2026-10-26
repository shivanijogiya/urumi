// Observability (ADR 011): Prometheus metrics per call (bounded labels), upstream gauges read from
// Postgres, the internal /metrics listener, failure details in audit rows and error messages, and
// GET /api/metrics/summary (per-server calls, error rate, p50/p95, classified last error).
import { MetricsSummaryResponseSchema } from '@urumi/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthMonitor } from '../src/core/health.js';
import { HEALTH_LEASE, Lease } from '../src/core/leader.js';
import { GatewayMetrics, UNRESOLVED } from '../src/metrics/metrics.js';
import { startMetricsServer } from '../src/metrics/server.js';
import { ADMIN, setupApp, type TestApp } from './helpers/app.js';
import {
  deadUrl,
  startFakeUpstream,
  type FakeUpstream,
  type FakeUpstreamOptions,
} from './helpers/fake-upstream.js';

const CALL_MS = 300;
let t: TestApp;
let metrics: GatewayMetrics;
let admin: string;
let adminId: string;
const fakes: FakeUpstream[] = [];

beforeEach(async () => {
  metrics = new GatewayMetrics({ defaultMetrics: false });
  t = await setupApp({
    upstreamAllowedHosts: ['localhost'],
    mcpTimeouts: { callMs: CALL_MS },
    metrics,
  });
  admin = await t.login(ADMIN.email, ADMIN.password);
  const { rows } = await t.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    ADMIN.email,
  ]);
  adminId = rows[0]!.id;
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.stop()));
  await t.close();
});

async function addUpstream(slug: string, opts: Partial<FakeUpstreamOptions> = {}, url?: string) {
  let target = url;
  if (!target) {
    const f = await startFakeUpstream({ identity: slug, ...opts });
    fakes.push(f);
    target = f.url;
  }
  const res = await t.request('POST', '/api/upstreams', {
    cookie: admin,
    body: { slug, name: `Upstream ${slug}`, url: target },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { upstream: { id: string } }).upstream.id;
}

const call = (name: string) =>
  t.app.tools.callTool(adminId, name, { q: 'x' }, { source: 'mcp' }).catch((e: Error) => e);

async function auditRows() {
  const { rows } = await t.pool.query<{
    server_slug: string;
    outcome: string;
    error_code: string | null;
    error_detail: string | null;
  }>('SELECT server_slug, outcome, error_code, error_detail FROM audit_log ORDER BY id');
  return rows;
}

describe('Prometheus metrics', () => {
  it('counts calls by server/tool/outcome/source and records latency per server', async () => {
    await addUpstream('a');
    await call('a__search');
    await call('a__search');
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'tool_calls_total{server="a",tool="search",outcome="ok",source="mcp"} 2',
    );
    expect(text).toMatch(/tool_call_duration_seconds_count\{server="a"\} 2/);
    expect(text).toContain('# TYPE tool_call_duration_seconds histogram');
  });

  it('never turns caller input into label values (unknown tools are _unresolved)', async () => {
    await addUpstream('a');
    for (const name of ['a__nope-1', 'a__nope-2', 'zzz__x', 'garbage']) await call(name);
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      `tool_calls_total{server="${UNRESOLVED}",tool="${UNRESOLVED}",outcome="denied",source="mcp"} 4`,
    );
    expect(text).not.toMatch(/nope|zzz|garbage/);
  });

  it('upstream_up / last check / last success come from Postgres (same on every replica)', async () => {
    const up = await addUpstream('a');
    await addUpstream('gone', {}, await deadUrl());
    const monitor = new HealthMonitor({
      pool: t.pool,
      registry: t.app.tools.registry,
      log: t.app.log,
      retryDelayMs: 0,
    });
    await monitor.tick();
    // A second "replica" that never ran the health loop reports the same values.
    const other = new GatewayMetrics({ pool: t.pool, defaultMetrics: false });
    const text = await other.registry.metrics();
    expect(text).toContain('upstream_up{server="a"} 1');
    expect(text).toContain('upstream_up{server="gone"} 0');
    expect(text).toMatch(/upstream_last_check_timestamp_seconds\{server="a"\} 1\d{9}/);
    expect(text).toMatch(/upstream_last_success_timestamp_seconds\{server="a"\} 1\d{9}/);
    expect(text).toContain('upstream_last_success_timestamp_seconds{server="gone"} 0');
    expect(up).toBeTruthy();
  });

  it('rate_limited_total counts refusals by scope', async () => {
    metrics.observeRateLimited('key');
    metrics.observeRateLimited('key');
    metrics.observeRateLimited('user');
    const text = await metrics.registry.metrics();
    expect(text).toContain('rate_limited_total{scope="key"} 2');
    expect(text).toContain('rate_limited_total{scope="user"} 1');
  });

  it('the internal listener serves /metrics (Prometheus text) and nothing else', async () => {
    const withDefaults = new GatewayMetrics({ pool: t.pool });
    const server = await startMetricsServer(withDefaults, { port: 0, host: '127.0.0.1' });
    try {
      const { port } = server.server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const body = await res.text();
      expect(body).toContain('process_cpu_user_seconds_total');
      expect(body).toContain('# TYPE tool_calls_total counter');
      expect((await fetch(`http://127.0.0.1:${port}/api/auth/me`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('failure reasons in audit and errors', () => {
  it('timeout, connection refused, upstream error and isError each carry a precise detail', async () => {
    await addUpstream('slow', { callDelayMs: 2000 });
    await addUpstream('boom', { callFails: 'throw' });
    await addUpstream('iserr', { callFails: 'isError' });
    const timeout = await call('slow__search');
    const thrown = await call('boom__search');
    await call('iserr__search');
    expect((timeout as Error).message).toMatch(/did not respond within 0.3 s/);
    expect((thrown as Error).message).toMatch(/returned an error: MCP protocol error: MCP error/);
    expect(await auditRows()).toMatchObject([
      { server_slug: 'slow', outcome: 'timeout', error_detail: 'Timed out' },
      {
        server_slug: 'boom',
        outcome: 'error',
        error_detail: expect.stringMatching(/^MCP error -?\d+$/),
      },
      { server_slug: 'iserr', outcome: 'error', error_detail: 'Tool returned an error' },
    ]);
  });

  it('a down upstream says why it is down; unknown tools and FORBIDDEN get fixed details', async () => {
    const id = await addUpstream('a');
    await t.pool.query(
      `UPDATE upstreams SET status = 'down', last_error = 'Connection failed (ECONNREFUSED)' WHERE id = $1`,
      [id],
    );
    const err = (await call('a__search')) as Error;
    expect(err.message).toBe(
      "Server 'a' is unreachable (marked down by the health check: connection refused)",
    );
    await t.pool.query(`UPDATE upstreams SET status = 'up', last_error = NULL WHERE id = $1`, [id]);
    await call('a__nope');
    const rows = await auditRows();
    expect(rows.map((r) => r.error_detail)).toEqual([
      'Server marked down by the health check',
      'Unknown tool',
    ]);
    // The audit API exposes the detail and its classification.
    const res = await t.request('GET', '/api/audit?limit=10', { cookie: admin });
    const items = (res.json() as { items: { errorDetail: string; errorReason: string }[] }).items;
    expect(items.map((i) => i.errorReason)).toEqual(['unknown_tool', 'server_down']);
  });
});

describe('GET /api/metrics/summary', () => {
  it('per-server calls, error rate, p50/p95, top errors and upstream health; admin only', async () => {
    const id = await addUpstream('a');
    await addUpstream('slow', { callDelayMs: 2000 });
    for (let i = 0; i < 4; i++) await call('a__search');
    await call('slow__search');
    await call('a__nope');
    const monitor = new HealthMonitor({
      pool: t.pool,
      registry: t.app.tools.registry,
      log: t.app.log,
      lease: new Lease(t.pool, HEALTH_LEASE, 'pod-x'),
    });
    await monitor.tick();

    const res = await t.request('GET', '/api/metrics/summary?windowMinutes=15', { cookie: admin });
    expect(res.statusCode, res.body).toBe(200);
    const body = MetricsSummaryResponseSchema.parse(res.json());
    expect(body.windowMinutes).toBe(15);
    expect(body.healthLeader).toBe('pod-x');
    const a = body.servers.find((s) => s.serverSlug === 'a')!;
    expect(a).toMatchObject({ calls: 5, errors: 1, errorRate: 0.2 });
    expect(a.byOutcome).toEqual({ ok: 4, denied: 1 });
    expect(a.p50Ms).not.toBeNull();
    expect(a.p95Ms!).toBeGreaterThanOrEqual(a.p50Ms!);
    expect(a.topErrors).toMatchObject([
      {
        errorCode: 'TOOL_NOT_FOUND',
        errorDetail: 'Unknown tool',
        reason: 'unknown_tool',
        count: 1,
      },
    ]);
    expect(a.upstream).toMatchObject({ id, status: 'up', lastError: null });
    expect(a.upstream!.lastOkAt).not.toBeNull();
    const slow = body.servers.find((s) => s.serverSlug === 'slow')!;
    expect(slow).toMatchObject({ calls: 1, errors: 1, errorRate: 1 });
    expect(slow.p50Ms!).toBeGreaterThanOrEqual(CALL_MS - 5);
    expect(slow.topErrors[0]).toMatchObject({ errorDetail: 'Timed out', reason: 'timeout' });
    expect(body.totals).toMatchObject({ calls: 6, errors: 2 });

    const member = await t.createUser(admin, { email: 'm@example.com' });
    const cookie = await t.login('m@example.com', member.tempPassword);
    expect((await t.request('GET', '/api/metrics/summary', { cookie })).statusCode).toBe(403);
    expect(
      (await t.request('GET', '/api/metrics/summary?windowMinutes=0', { cookie: admin }))
        .statusCode,
    ).toBe(400);
  });

  it('a down upstream reports the classified reason and keeps its last success time', async () => {
    const id = await addUpstream('a');
    const monitor = new HealthMonitor({
      pool: t.pool,
      registry: t.app.tools.registry,
      log: t.app.log,
      retryDelayMs: 0,
    });
    await monitor.tick();
    await fakes[0]!.stop();
    fakes.splice(0);
    await monitor.tick();
    const res = await t.request('GET', '/api/upstreams', { cookie: admin });
    const u = (res.json() as { upstreams: Record<string, unknown>[] }).upstreams.find(
      (x) => x.id === id,
    )!;
    expect(u.status).toBe('down');
    expect(u.lastErrorReason).toMatch(/connection_refused|connection_failed|timeout/);
    expect(u.lastOkAt).not.toBeNull();
    expect(Date.parse(u.lastCheckedAt as string)).toBeGreaterThan(Date.parse(u.lastOkAt as string));
  });
});
