// Health loop: every 15 s, ping each enabled upstream with tools/list (3 s timeout) and store
// status / last_error / last_checked_at. A successful ping also refreshes the tool cache. A result
// is written only if the row's URL and credential are unchanged since the check began, so an admin
// edit mid-check is never overwritten with a result about the old target. Down upstreams' tools
// disappear from listTools at once (it skips status 'down'); going down also drops the cache.
import { MCP_TIMEOUTS } from '@urumi/contracts';
import type { UpstreamRow } from '@urumi/contracts/db';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { UpstreamError } from '../mcp-client/upstream-client.js';
import { listUpstreamRows, setUpstreamHealth } from '../upstreams/repo.js';
import { DEFAULT_LIST_TIMEOUT_MS, type ToolRegistry } from './registry.js';

const MAX_LAST_ERROR = 200;

export interface HealthMonitorDeps {
  pool: pg.Pool;
  registry: ToolRegistry;
  log: FastifyBaseLogger;
  /** Between the end of one tick and the start of the next. Default 15 s. */
  intervalMs?: number;
  /** Per-upstream ping timeout. Default 3 s. */
  timeoutMs?: number;
}

export class HealthMonitor {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly deps: HealthMonitorDeps) {
    this.intervalMs = deps.intervalMs ?? MCP_TIMEOUTS.healthIntervalMs;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  }

  /** First tick right away, then every intervalMs after the previous tick ends. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops the loop and waits for a tick in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One pass over every enabled upstream, in parallel. */
  async tick(): Promise<void> {
    const rows = (await listUpstreamRows(this.deps.pool)).filter((r) => r.enabled);
    await Promise.allSettled(rows.map((row) => this.check(row)));
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((err: Error) => {
          this.deps.log.error({ err: { message: err.message } }, 'health check pass failed');
        })
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.intervalMs);
        });
    }, ms);
    this.timer.unref();
  }

  private async check(row: UpstreamRow): Promise<void> {
    let status: 'up' | 'down' = 'up';
    let lastError: string | null = null;
    try {
      await this.deps.registry.refresh(row, this.timeoutMs);
    } catch (err) {
      status = 'down';
      lastError = (err instanceof UpstreamError ? err.detail : 'Check failed').slice(
        0,
        MAX_LAST_ERROR,
      );
    }
    const written = await setUpstreamHealth(this.deps.pool, row, { status, lastError });
    if (!written || status === row.status) return;
    // Going up, the successful ping has already replaced the cached list.
    if (status === 'down') this.deps.registry.invalidate(row.id);
    const log = status === 'down' ? this.deps.log.warn : this.deps.log.info;
    log.call(
      this.deps.log,
      { upstream: row.slug, from: row.status, to: status, reason: lastError },
      'upstream health changed',
    );
  }
}
