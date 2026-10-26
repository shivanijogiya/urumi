// Health loop: every 15 s, ping each enabled upstream with tools/list (3 s timeout) and store
// status / last_error / last_checked_at. A successful ping also refreshes the tool cache. A result
// is written only if the row's URL and credential are unchanged since the check began, so an admin
// edit mid-check is never overwritten with a result about the old target. Down upstreams' tools
// disappear from listTools at once (it skips status 'down'); going down also drops the cache.
//
// Several replicas (ADR 010): with a `lease`, a tick runs only on the replica holding the `health`
// lease (core/leader.ts), so upstream status has exactly one writer and upstreams get one ping per
// interval, not one per replica. Other replicas read status from Postgres (the source of truth) and
// fill their own tool caches on demand (registry TTL); a 'down' row hides its tools on every
// replica at once because listTools and callTool check the row, not the cache.
import { MCP_TIMEOUTS } from '@urumi/contracts';
import type { UpstreamRow } from '@urumi/contracts/db';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { UpstreamError } from '../mcp-client/upstream-client.js';
import { listUpstreamRows, setUpstreamHealth } from '../upstreams/repo.js';
import type { Lease } from './leader.js';
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
  /** Run ticks only while holding this lease (several replicas). Absent: every tick runs. */
  lease?: Lease;
  /**
   * A failed ping is retried once after this delay, within the same tick, before the upstream is
   * marked down: a sub-second network blip (pod churn, NetworkPolicy resync) must not hide an
   * upstream's tools for a whole interval. Default 1 s; 0 = no retry.
   */
  retryDelayMs?: number;
}

export class HealthMonitor {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;
  /** Whether the last tick held the lease (always true without a lease). */
  leader = false;
  /** Set by stop(): a tick in progress skips its retries. */
  private shuttingDown = false;

  constructor(private readonly deps: HealthMonitorDeps) {
    this.intervalMs = deps.intervalMs ?? MCP_TIMEOUTS.healthIntervalMs;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.retryDelayMs = deps.retryDelayMs ?? 1000;
  }

  /** First tick right away, then every intervalMs after the previous tick ends. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.shuttingDown = false;
    this.schedule(0);
  }

  /** Stops the loop and waits for a tick in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.shuttingDown = true;
    clearTimeout(this.timer);
    await this.running;
    if (this.deps.lease && this.leader) {
      this.leader = false;
      await this.deps.lease.release().catch(() => undefined);
    }
  }

  /**
   * One pass over every enabled upstream, in parallel — if this replica holds the lease (or there
   * is none). Returns whether the pass ran.
   */
  async tick(): Promise<boolean> {
    if (this.deps.lease) {
      const leader = await this.deps.lease.tryAcquire();
      if (leader !== this.leader) {
        this.deps.log.info(
          { lease: this.deps.lease.name, holder: this.deps.lease.holder, leader },
          leader ? 'health lease acquired: this replica runs the health loop' : 'health lease lost',
        );
      }
      this.leader = leader;
      if (!leader) return false;
    } else {
      this.leader = true;
    }
    const rows = (await listUpstreamRows(this.deps.pool)).filter((r) => r.enabled);
    await Promise.allSettled(rows.map((row) => this.check(row)));
    return true;
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
      try {
        await this.deps.registry.refresh(row, this.timeoutMs);
      } catch (first) {
        // Already down: no second chance needed. Otherwise retry once before marking it down.
        if (row.status === 'down' || this.retryDelayMs <= 0 || this.shuttingDown) throw first;
        this.deps.log.info(
          { upstream: row.slug, reason: first instanceof UpstreamError ? first.detail : 'error' },
          'health check failed; retrying once',
        );
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
        await this.deps.registry.refresh(row, this.timeoutMs);
      }
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
