// Hosted-server reconciler (ADR 014). Every few seconds, on the replica holding the `hosted` lease
// (core/leader.ts, as for the health loop), it drives each hosted server toward its row:
//
//   desired 'present': apply Secret/Service/Deployment (server-side apply) when they are missing or
//     the spec hash changed; read the Deployment and its pods; once the pod is ready, enable
//     (= register) the upstream and run one MCP check at once; store phase + reason (status.ts).
//   desired 'absent': delete Deployment, Service and Secret (404 = already gone), then the upstream
//     row (cascades to hosted_servers). Tools disappeared already: deleting disables the upstream.
//   garbage: a Deployment labelled managed-by=urumi-gateway whose id has no row is deleted with its
//     Service and Secret (e.g. a row removed while the API was down).
//
// API handlers call applyNow()/deleteNow() directly so a create or delete takes effect without
// waiting for a tick; both are idempotent, so a non-leader replica doing it races harmlessly with
// the leader. Phase and reason are written by the lease holder only.
import type { UpstreamRow } from '@urumi/contracts/db';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Lease } from '../core/leader.js';
import type { ToolRegistry } from '../core/registry.js';
import { UpstreamError } from '../mcp-client/upstream-client.js';
import { findUpstreamRow, setUpstreamHealth } from '../upstreams/repo.js';
import { KubeError, type KubeApi } from './kube.js';
import {
  ANNOTATION_SPEC_HASH,
  buildManifests,
  LABEL_ID,
  LABEL_SLUG,
  MANAGED_BY,
  objectName,
  secretName,
  type HostedManifests,
  type ManifestOptions,
} from './manifests.js';
import {
  deleteHostedRows,
  enableHostedUpstream,
  listHosted,
  openEnv,
  setHostedPhase,
  type HostedWithUpstream,
} from './repo.js';
import { derivePhase } from './status.js';

export const HOSTED_LEASE = 'hosted';
export const RECONCILE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;

export interface ReconcilerDeps extends ManifestOptions {
  pool: pg.Pool;
  kube: KubeApi;
  registry: ToolRegistry;
  encKey: Buffer;
  log: FastifyBaseLogger;
  lease?: Lease;
  intervalMs?: number;
}

export class HostedReconciler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;
  leader = false;

  constructor(private readonly deps: ReconcilerDeps) {}

  manifestsFor(row: HostedWithUpstream): HostedManifests {
    return buildManifests(
      {
        id: row.id,
        slug: row.upstream.slug,
        imageRef: row.image_digest ? `${row.image}@${row.image_digest}` : row.image,
        port: row.port,
        preset: row.preset,
        egress: row.egress,
        env: openEnv(this.deps.encKey, row),
        envVersion: row.env_iv ? Buffer.from(row.env_iv).toString('hex') : 'none',
      },
      { namespace: this.deps.namespace, serviceAccountName: this.deps.serviceAccountName },
    );
  }

  /** Applies the server's objects (Secret first: the pod references it). */
  async applyNow(row: HostedWithUpstream): Promise<void> {
    const m = this.manifestsFor(row);
    if (m.secret) await this.deps.kube.apply(m.secret);
    else await this.deps.kube.delete('Secret', secretName(row.upstream.slug));
    await this.deps.kube.apply(m.service);
    await this.deps.kube.apply(m.deployment);
  }

  /** Deletes the server's objects (any that exist), then its rows. */
  async deleteNow(id: string, slug: string): Promise<void> {
    await this.deleteObjects(slug);
    await deleteHostedRows(this.deps.pool, id);
    this.deps.registry.invalidate(id);
  }

  private async deleteObjects(slug: string): Promise<void> {
    await this.deps.kube.delete('Deployment', objectName(slug));
    await this.deps.kube.delete('Service', objectName(slug));
    await this.deps.kube.delete('Secret', secretName(slug));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    if (this.deps.lease && this.leader) {
      this.leader = false;
      await this.deps.lease.release().catch(() => undefined);
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((err: Error) =>
          this.deps.log.error({ err: { message: err.message } }, 'hosted reconcile pass failed'),
        )
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.deps.intervalMs ?? RECONCILE_INTERVAL_MS);
        });
    }, ms);
    this.timer.unref();
  }

  /** One pass, if this replica holds the lease (or there is none). Returns whether it ran. */
  async tick(): Promise<boolean> {
    if (this.deps.lease) {
      const leader = await this.deps.lease.tryAcquire();
      if (leader !== this.leader) {
        this.deps.log.info({ lease: HOSTED_LEASE, leader }, 'hosted reconciler lease changed');
      }
      this.leader = leader;
      if (!leader) return false;
    } else {
      this.leader = true;
    }
    const rows = await listHosted(this.deps.pool);
    await Promise.allSettled(rows.map((row) => this.reconcileOne(row)));
    await this.collectGarbage(rows).catch((err: Error) =>
      this.deps.log.warn({ err: { message: err.message } }, 'hosted garbage collection failed'),
    );
    return true;
  }

  async reconcileOne(row: HostedWithUpstream): Promise<void> {
    const slug = row.upstream.slug;
    try {
      if (row.desired_state === 'absent') {
        await this.deleteNow(row.id, slug);
        this.deps.log.info({ hosted: slug }, 'hosted server deleted');
        return;
      }
      const m = this.manifestsFor(row);
      let dep = await this.deps.kube.getDeployment(objectName(slug));
      if (!dep || dep.metadata.annotations?.[ANNOTATION_SPEC_HASH] !== m.specHash) {
        await this.applyNow(row);
        dep = await this.deps.kube.getDeployment(objectName(slug));
      }
      const pods = await this.deps.kube.listPods(`${LABEL_ID}=${row.id}`);
      let upstream: Pick<UpstreamRow, 'enabled' | 'status' | 'last_error'> = row.upstream;
      const ready = (dep?.status?.availableReplicas ?? 0) >= 1;
      if (ready && (!row.upstream.enabled || row.upstream.status === 'unknown')) {
        if (!row.upstream.enabled && (await enableHostedUpstream(this.deps.pool, row.id))) {
          this.deps.log.info({ hosted: slug }, 'hosted server ready: upstream registered');
        }
        upstream = await this.probe(row.id);
      }
      const { phase, reason } = derivePhase({
        desiredState: row.desired_state,
        deployment: dep,
        pods,
        upstream,
      });
      if (phase !== row.phase || reason !== row.reason) {
        this.deps.log.info({ hosted: slug, from: row.phase, to: phase, reason }, 'hosted phase');
      }
      await setHostedPhase(this.deps.pool, row.id, phase, reason);
    } catch (err) {
      const detail = err instanceof KubeError ? err.detail : 'Reconcile failed';
      this.deps.log.warn({ hosted: slug, reason: detail }, 'hosted reconcile failed');
      if (row.desired_state === 'present') {
        // A rejected apply (e.g. Pod Security, quota) is a failure the admin must see.
        const phase =
          err instanceof KubeError && err.status >= 400 && err.status < 500 ? 'failed' : row.phase;
        await setHostedPhase(this.deps.pool, row.id, phase, detail.slice(0, 300)).catch(
          () => undefined,
        );
      }
    }
  }

  /** One MCP tools/list now (instead of waiting up to 15 s for the health loop); stores the result. */
  private async probe(id: string): Promise<Pick<UpstreamRow, 'enabled' | 'status' | 'last_error'>> {
    const row = await findUpstreamRow(this.deps.pool, id);
    if (!row) return { enabled: false, status: 'unknown', last_error: null };
    let status: 'up' | 'down' = 'up';
    let lastError: string | null = null;
    try {
      await this.deps.registry.refresh(row, PROBE_TIMEOUT_MS);
    } catch (err) {
      status = 'down';
      lastError = err instanceof UpstreamError ? err.detail : 'Check failed';
    }
    await setUpstreamHealth(this.deps.pool, row, { status, lastError });
    return { enabled: row.enabled, status, last_error: lastError };
  }

  private async collectGarbage(rows: HostedWithUpstream[]): Promise<void> {
    const ids = new Set(rows.map((r) => r.id));
    const slugs = new Set(rows.map((r) => r.upstream.slug));
    const deps = await this.deps.kube.listDeployments(`app.kubernetes.io/managed-by=${MANAGED_BY}`);
    for (const d of deps) {
      const id = d.metadata.labels?.[LABEL_ID];
      const slug = d.metadata.labels?.[LABEL_SLUG];
      if (!id || !slug || ids.has(id) || slugs.has(slug) || d.metadata.name !== objectName(slug)) {
        continue;
      }
      // Created after this pass listed the rows (an API create racing the tick)? Then keep it.
      const { rowCount } = await this.deps.pool.query(
        `SELECT 1 FROM upstreams WHERE id = $1 OR slug = $2`,
        [id, slug],
      );
      if (rowCount) continue;
      this.deps.log.warn({ hosted: slug }, 'deleting orphaned hosted server objects');
      await this.deleteObjects(slug);
    }
  }
}
