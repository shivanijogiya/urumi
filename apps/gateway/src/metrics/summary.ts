// GET /api/metrics/summary (admin, ADR 011): per-server calls, error rate and p50/p95 latency over
// a window, computed in Postgres from audit_log — every replica writes its calls there, so the
// numbers cover the whole deployment without Prometheus. Joined with the upstreams table for the
// health status, the classified last error and when the upstream last worked.
import {
  classifyFailure,
  MetricsSummaryQuerySchema,
  MetricsSummaryResponseSchema,
  ROUTES,
  type MetricsSummaryResponse,
  type ServerMetrics,
} from '@urumi/contracts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin } from '../auth/session.js';
import { HEALTH_LEASE, Lease } from '../core/leader.js';
import { parse } from '../http/errors.js';

type Db = Pick<pg.Pool, 'query'>;
const TOP_ERRORS = 5;

export async function metricsSummary(
  db: Db,
  windowMinutes: number,
): Promise<MetricsSummaryResponse> {
  const since = `now() - make_interval(mins => $1)`;
  const [stats, outcomes, errors, upstreams, leader] = await Promise.all([
    db.query<{
      server_slug: string;
      calls: string;
      errors: string;
      p50: number | null;
      p95: number | null;
    }>(
      `SELECT server_slug, count(*) AS calls, count(*) FILTER (WHERE outcome <> 'ok') AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
       FROM audit_log WHERE started_at >= ${since} GROUP BY server_slug`,
      [windowMinutes],
    ),
    db.query<{ server_slug: string; outcome: string; n: string }>(
      `SELECT server_slug, outcome, count(*) AS n FROM audit_log
       WHERE started_at >= ${since} GROUP BY server_slug, outcome`,
      [windowMinutes],
    ),
    db.query<{
      server_slug: string;
      error_code: string | null;
      error_detail: string | null;
      n: string;
      last_at: Date;
      rk: string;
    }>(
      `SELECT * FROM (
         SELECT server_slug, error_code, error_detail, count(*) AS n, max(started_at) AS last_at,
                row_number() OVER (PARTITION BY server_slug ORDER BY count(*) DESC, max(started_at) DESC) AS rk
         FROM audit_log WHERE started_at >= ${since} AND outcome <> 'ok'
         GROUP BY server_slug, error_code, error_detail) e
       WHERE rk <= ${TOP_ERRORS}`,
      [windowMinutes],
    ),
    db.query<{
      id: string;
      slug: string;
      name: string;
      enabled: boolean;
      status: 'unknown' | 'up' | 'down';
      last_error: string | null;
      last_checked_at: Date | null;
      last_ok_at: Date | null;
    }>(
      `SELECT id, slug, name, enabled, status, last_error, last_checked_at, last_ok_at
       FROM upstreams ORDER BY slug`,
    ),
    Lease.current(db, HEALTH_LEASE),
  ]);

  const servers = new Map<string, ServerMetrics>();
  const entry = (slug: string): ServerMetrics => {
    let s = servers.get(slug);
    if (!s) {
      s = {
        serverSlug: slug,
        calls: 0,
        errors: 0,
        errorRate: 0,
        p50Ms: null,
        p95Ms: null,
        byOutcome: {},
        topErrors: [],
        upstream: null,
      };
      servers.set(slug, s);
    }
    return s;
  };
  for (const u of upstreams.rows) {
    entry(u.slug).upstream = {
      id: u.id,
      name: u.name,
      enabled: u.enabled,
      status: u.status,
      lastError: u.last_error,
      lastErrorReason: classifyFailure(u.last_error),
      lastCheckedAt: u.last_checked_at?.toISOString() ?? null,
      lastOkAt: u.last_ok_at?.toISOString() ?? null,
    };
  }
  let calls = 0;
  let failed = 0;
  for (const r of stats.rows) {
    const s = entry(r.server_slug);
    s.calls = Number(r.calls);
    s.errors = Number(r.errors);
    s.errorRate = s.calls ? s.errors / s.calls : 0;
    s.p50Ms = r.p50 === null ? null : Math.round(Number(r.p50));
    s.p95Ms = r.p95 === null ? null : Math.round(Number(r.p95));
    calls += s.calls;
    failed += s.errors;
  }
  let rateLimited = 0;
  for (const r of outcomes.rows) {
    entry(r.server_slug).byOutcome[r.outcome] = Number(r.n);
    if (r.outcome === 'rate_limited') rateLimited += Number(r.n);
  }
  for (const r of errors.rows) {
    entry(r.server_slug).topErrors.push({
      errorCode: r.error_code,
      errorDetail: r.error_detail,
      reason: classifyFailure(r.error_detail),
      count: Number(r.n),
      lastAt: r.last_at.toISOString(),
    });
  }
  return MetricsSummaryResponseSchema.parse({
    windowMinutes,
    generatedAt: new Date().toISOString(),
    healthLeader: leader?.holder ?? null,
    totals: { calls, errors: failed, errorRate: calls ? failed / calls : 0, rateLimited },
    servers: [...servers.values()].sort((a, b) => a.serverSlug.localeCompare(b.serverSlug)),
  });
}

export function registerMetricsRoutes(app: FastifyInstance): void {
  app.get(ROUTES.metricsSummary.path, { preHandler: requireAdmin }, async (req) => {
    const { windowMinutes } = parse(MetricsSummaryQuerySchema, req.query);
    return metricsSummary(app.pool, windowMinutes);
  });
}
