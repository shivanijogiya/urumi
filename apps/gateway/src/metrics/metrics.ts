// Prometheus metrics (ADR 011), served on a separate internal port (metrics/server.ts) that the
// Ingress never routes. Per pod: each replica counts what it served; Prometheus sums over pods
// (`sum by (server) (rate(tool_calls_total[5m]))`). The upstream gauges are read from Postgres at
// scrape time, so every replica reports the health-lease holder's view (one source of truth).
//
// Label cardinality is bounded: `server`/`tool` come from the registry only for calls that resolved
// to a real upstream tool; anything else (unknown names, refused before resolution) is labelled
// server="_unresolved", tool="_unresolved" — caller input never becomes a label value.
import client from 'prom-client';
import type pg from 'pg';
import type { CallRecord } from '../core/call-tool.js';

export const UNRESOLVED = '_unresolved';
/** Seconds; covers fast cache hits up to the 15 s call timeout. */
const DURATION_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];

interface UpstreamGaugeRow {
  slug: string;
  status: 'unknown' | 'up' | 'down';
  enabled: boolean;
  last_checked_at: Date | null;
  last_ok_at: Date | null;
}

export class GatewayMetrics {
  readonly registry = new client.Registry();
  readonly toolCalls: client.Counter<'server' | 'tool' | 'outcome' | 'source'>;
  readonly toolCallDuration: client.Histogram<'server'>;
  readonly rateLimited: client.Counter<'scope'>;

  constructor(opts: { pool?: Pick<pg.Pool, 'query'>; defaultMetrics?: boolean } = {}) {
    if (opts.defaultMetrics ?? true) client.collectDefaultMetrics({ register: this.registry });
    this.toolCalls = new client.Counter({
      name: 'tool_calls_total',
      help: 'Tool calls through callTool on this replica, by upstream, tool, outcome and source',
      labelNames: ['server', 'tool', 'outcome', 'source'],
      registers: [this.registry],
    });
    this.toolCallDuration = new client.Histogram({
      name: 'tool_call_duration_seconds',
      help: 'callTool latency on this replica (resolution + upstream call), by upstream',
      labelNames: ['server'],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.rateLimited = new client.Counter({
      name: 'rate_limited_total',
      help: '/mcp requests refused with 429 on this replica, by the limit that refused them',
      labelNames: ['scope'],
      registers: [this.registry],
    });
    const pool = opts.pool;
    if (pool) {
      // Gauges filled from the upstreams table on every scrape (all replicas agree).
      let rows: UpstreamGaugeRow[] = [];
      const load = async () => {
        rows = (
          await pool.query<UpstreamGaugeRow>(
            'SELECT slug, status, enabled, last_checked_at, last_ok_at FROM upstreams',
          )
        ).rows;
      };
      new client.Gauge({
        name: 'upstream_up',
        help: '1 if the upstream is enabled and its last health check succeeded, else 0',
        labelNames: ['server'],
        registers: [this.registry],
        async collect() {
          await load();
          this.reset();
          for (const r of rows)
            this.set({ server: r.slug }, r.enabled && r.status === 'up' ? 1 : 0);
        },
      });
      new client.Gauge({
        name: 'upstream_last_check_timestamp_seconds',
        help: 'Unix time of the last health check of the upstream (0 = never)',
        labelNames: ['server'],
        registers: [this.registry],
        collect() {
          this.reset();
          for (const r of rows) {
            this.set({ server: r.slug }, (r.last_checked_at?.getTime() ?? 0) / 1000);
          }
        },
      });
      new client.Gauge({
        name: 'upstream_last_success_timestamp_seconds',
        help: 'Unix time of the last successful health check of the upstream (0 = never)',
        labelNames: ['server'],
        registers: [this.registry],
        collect() {
          this.reset();
          for (const r of rows) this.set({ server: r.slug }, (r.last_ok_at?.getTime() ?? 0) / 1000);
        },
      });
    }
  }

  /** callTool's onCallFinished observer. */
  observeCall(r: CallRecord): void {
    const server = r.resolved ? r.serverSlug : UNRESOLVED;
    const tool = r.resolved ? r.tool : UNRESOLVED;
    this.toolCalls.inc({ server, tool, outcome: r.outcome, source: r.source });
    this.toolCallDuration.observe({ server }, Math.max(0, r.durationMs) / 1000);
  }

  observeRateLimited(scope: 'key' | 'user'): void {
    this.rateLimited.inc({ scope });
  }

  /** Prometheus text exposition. */
  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
