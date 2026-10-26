// Store provisioner (ADR 015). Level-triggered and idempotent, like the hosted reconciler
// (hosted/reconciler.ts): every few seconds, on the replica holding the Postgres lease `stores`, it
// drives each store toward its row:
//
//   desired 'present' (provisioning, or ready with a changed spec):
//     Namespace (labels: store, Pod Security restricted) -> RoleBindings (gateway: the chart's
//     store-manager ClusterRole; bootstrap SA: store-bootstrap) -> quota, limits, NetworkPolicies,
//     ServiceAccount, scripts ConfigMap, shared-secret Secret, Services, MariaDB, docroot PVC,
//     WordPress, Ingress (server-side apply) -> generated-password Secrets and the bootstrap Job
//     (create once) -> woo-mcp, once the Job succeeded -> register (enable) the upstream and run
//     one MCP check -> ready. Each step is re-done on the next pass if a gateway died half-way.
//   failed: nothing is applied until the admin presses Retry (new bootstrap generation).
//   desired 'absent': delete the namespace (everything in it, PVCs included); when the API says
//     it is gone, delete the store's permission rules and its upstream row (cascades to stores).
//   garbage: a store namespace whose id has no row is deleted (row removed while the API was down).
//
// API handlers call kickNow() so a create/delete starts without waiting for the tick; both paths are
// idempotent, so a non-leader replica doing it races harmlessly with the leader. Phase and reason are
// written by the lease holder only.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpstreamRow } from '@urumi/contracts/db';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Lease } from '../core/leader.js';
import type { ToolRegistry } from '../core/registry.js';
import { KubeError } from '../hosted/kube.js';
import { UpstreamError } from '../mcp-client/upstream-client.js';
import { credentialHeaders } from '../upstreams/decrypt-for-call.js';
import { findUpstreamRow, setUpstreamHealth } from '../upstreams/repo.js';
import type { KubeItem, StoreKubeApi } from './kube.js';
import { buildStoreManifests, generatedSecrets, type StoreManifests } from './manifests.js';
import {
  ANNOTATION_SPEC_HASH,
  bootstrapJobName,
  LABEL_GENERATION,
  LABEL_STORE_ID,
  LABEL_STORE_SLUG,
  MANAGED_BY,
  N,
  SHARED_SECRET_HEADER,
  storeNamespace,
} from './names.js';
import {
  deleteStoreRows,
  enableStoreUpstream,
  listStores,
  setStorePhase,
  type StoreWithUpstream,
} from './repo.js';
import type { StoreSettings } from './settings.js';
import { clip, deriveStorePhase } from './status.js';

export const STORES_LEASE = 'stores';
export const STORE_RECONCILE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
/** Bootstrap script files read from the chart's ConfigMap mount (charts/platform/files/bootstrap). */
export const BOOTSTRAP_SCRIPT_FILES = [
  'bootstrap.sh',
  'check-app-password.php',
  'publish-secret.sh',
  'wp-cli.yml',
] as const;

export interface ProvisionerDeps {
  pool: pg.Pool;
  kube: StoreKubeApi;
  registry: ToolRegistry;
  encKey: Buffer;
  log: FastifyBaseLogger;
  settings: StoreSettings;
  /** File name -> content of the bootstrap scripts. */
  scripts: Record<string, string>;
  lease?: Lease;
  intervalMs?: number;
  now?: () => Date;
  /** Generated password source (tests make it deterministic). */
  random?: () => string;
}

/** Reads the bootstrap scripts the chart mounts into the gateway pod. */
export async function loadBootstrapScripts(dir: string): Promise<Record<string, string>> {
  const present = new Set(await readdir(dir));
  const out: Record<string, string> = {};
  for (const f of BOOTSTRAP_SCRIPT_FILES) {
    if (!present.has(f)) throw new Error(`bootstrap script ${f} is missing in ${dir}`);
    out[f] = await readFile(join(dir, f), 'utf8');
  }
  return out;
}

export class StoreProvisioner {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;
  leader = false;

  constructor(private readonly deps: ProvisionerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  manifestsFor(row: StoreWithUpstream): StoreManifests {
    const headers = credentialHeaders(row.upstream, this.deps.encKey);
    const sharedSecret = headers[SHARED_SECRET_HEADER];
    if (!sharedSecret) throw new Error('store upstream has no shared secret');
    return buildStoreManifests(
      {
        id: row.id,
        slug: row.upstream.slug,
        name: row.upstream.name,
        adminEmail: row.admin_email,
        generation: row.generation,
        sharedSecret,
        scripts: this.deps.scripts,
      },
      this.deps.settings,
    );
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
          this.deps.log.error({ err: { message: err.message } }, 'store provisioner pass failed'),
        )
        .finally(() => {
          this.running = undefined;
          if (!this.stopped) this.schedule(this.deps.intervalMs ?? STORE_RECONCILE_INTERVAL_MS);
        });
    }, ms);
    this.timer.unref();
  }

  /** One pass, if this replica holds the lease (or there is none). Returns whether it ran. */
  async tick(): Promise<boolean> {
    if (this.deps.lease) {
      const leader = await this.deps.lease.tryAcquire();
      if (leader !== this.leader) {
        this.deps.log.info({ lease: STORES_LEASE, leader }, 'store provisioner lease changed');
      }
      this.leader = leader;
      if (!leader) return false;
    } else {
      this.leader = true;
    }
    const rows = await listStores(this.deps.pool);
    // One store at a time: each pass is a few dozen API calls, and stores are few.
    for (const row of rows) await this.reconcileOne(row);
    await this.collectGarbage(rows).catch((err: Error) =>
      this.deps.log.warn({ err: { message: err.message } }, 'store garbage collection failed'),
    );
    return true;
  }

  /**
   * Best effort from an API handler (create, retry, delete): the same steps as a tick for this one
   * row, without the phase write (the lease holder owns that). Errors are left to the next tick.
   */
  async kickNow(row: StoreWithUpstream): Promise<void> {
    if (row.desired_state === 'absent') {
      await this.deps.kube.delete('Namespace', '', storeNamespace(row.upstream.slug));
      return;
    }
    await this.applyAll(row, this.manifestsFor(row));
  }

  /** Namespace, RoleBindings, the applied set, generated Secrets and the bootstrap Job. */
  private async applyAll(row: StoreWithUpstream, m: StoreManifests): Promise<void> {
    const k = this.deps.kube;
    await k.apply(m.namespace);
    // The RoleBinding to the store-manager ClusterRole first: every namespaced write below needs it.
    for (const rb of m.roleBindings) await k.createIfAbsent(rb);
    for (const obj of m.apply) await k.apply(obj);
    for (const s of generatedSecrets(
      { id: row.id, slug: row.upstream.slug, adminEmail: row.admin_email },
      this.deps.random,
    )) {
      await k.createIfAbsent(s);
    }
    await k.createIfAbsent(m.job);
  }

  async reconcileOne(row: StoreWithUpstream): Promise<void> {
    const slug = row.upstream.slug;
    const ns = storeNamespace(slug);
    const k = this.deps.kube;
    try {
      if (row.desired_state === 'absent') {
        await this.reconcileDelete(row);
        return;
      }
      if (row.phase === 'failed') return; // terminal until Retry

      const m = this.manifestsFor(row);
      let namespace = await k.get('Namespace', '', ns);
      if (namespace?.metadata.deletionTimestamp) {
        await this.setPhase(row, 'provisioning', 'Waiting for an old namespace to finish deleting');
        return;
      }
      const drifted = namespace?.metadata.annotations?.[ANNOTATION_SPEC_HASH] !== m.specHash;
      if (!namespace || row.phase === 'provisioning' || drifted) {
        await this.applyAll(row, m);
        namespace = await k.get('Namespace', '', ns);
      }
      // Bootstrap Jobs of older generations (before a Retry) are removed with their pods.
      const jobs = await k.list('Job', ns, `${LABEL_STORE_ID}=${row.id}`);
      for (const j of jobs) {
        if (j.metadata.name !== bootstrapJobName(row.generation)) {
          await k.delete('Job', ns, j.metadata.name);
        }
      }
      const job = jobs.find((j) => j.metadata.name === bootstrapJobName(row.generation)) ?? null;
      let wooMcp = await k.get('Deployment', ns, N.wooMcp);
      // woo-mcp reads the Secret the Job writes: create (or restart, on a new generation) it after.
      if ((job?.status?.succeeded ?? 0) >= 1 && (!wooMcp || drifted || row.phase === 'provisioning')) {
        await k.apply(m.wooMcp);
        wooMcp = await k.get('Deployment', ns, N.wooMcp);
      }
      const [mariadb, wordpress, pods] = await Promise.all([
        k.get('StatefulSet', ns, N.mariadb),
        k.get('Deployment', ns, N.wordpress),
        k.list('Pod', ns),
      ]);
      // Pods of older bootstrap generations are on their way out: ignore them.
      const live = pods.filter(
        (p) =>
          p.metadata.labels?.['app.kubernetes.io/component'] !== 'bootstrap' ||
          p.metadata.labels?.[LABEL_GENERATION] === String(row.generation),
      );

      let upstream: Pick<UpstreamRow, 'enabled' | 'status' | 'last_error'> = row.upstream;
      const mcpReady = (wooMcp?.status?.availableReplicas ?? 0) >= 1;
      if (mcpReady && (!row.upstream.enabled || row.upstream.status !== 'up')) {
        if (!row.upstream.enabled && (await enableStoreUpstream(this.deps.pool, row.id))) {
          this.deps.log.info({ store: slug }, 'store woo-mcp ready: upstream registered');
        }
        if (row.phase !== 'ready') upstream = await this.probe(row.id);
      }
      const { phase, reason } = deriveStorePhase({
        desiredState: row.desired_state,
        current: row.phase,
        namespace,
        mariadb,
        wordpress,
        job,
        wooMcp,
        pods: live,
        upstream,
        provisionStartedAt: row.provision_started_at,
        now: this.now(),
        timeoutMs: this.deps.settings.provisionTimeoutMinutes * 60_000,
      });
      await this.setPhase(row, phase, reason);
    } catch (err) {
      const detail =
        err instanceof KubeError ? err.detail : clip(`Provisioning error: ${(err as Error).message}`);
      this.deps.log.warn({ store: slug, reason: detail }, 'store reconcile failed');
      if (row.desired_state === 'present' && row.phase === 'provisioning') {
        // A rejected write (admission policy, quota, Pod Security, RBAC) is a failure the admin must
        // see; a transient error (API unreachable, 5xx, conflict) is retried on the next pass.
        const permanent =
          err instanceof KubeError && err.status >= 400 && err.status < 500 && err.status !== 409;
        await this.setPhase(row, permanent ? 'failed' : 'provisioning', detail).catch(
          () => undefined,
        );
      }
    }
  }

  private async reconcileDelete(row: StoreWithUpstream): Promise<void> {
    const slug = row.upstream.slug;
    const ns = storeNamespace(slug);
    const namespace = await this.deps.kube.get('Namespace', '', ns);
    if (namespace) {
      if (!namespace.metadata.deletionTimestamp) {
        await this.deps.kube.delete('Namespace', '', ns);
        this.deps.log.info({ store: slug }, 'store namespace delete requested');
      }
      await this.setPhase(row, 'deleting', 'Deleting the namespace (volumes included)');
      return;
    }
    await deleteStoreRows(this.deps.pool, row.id, slug);
    this.deps.registry.invalidate(row.id);
    this.deps.log.info({ store: slug }, 'store deleted: namespace gone, upstream and rules removed');
  }

  private async setPhase(row: StoreWithUpstream, phase: StoreWithUpstream['phase'], reason: string | null) {
    if (phase !== row.phase || reason !== row.reason) {
      this.deps.log.info({ store: row.upstream.slug, from: row.phase, to: phase, reason }, 'store phase');
    }
    await setStorePhase(this.deps.pool, row.id, phase, reason);
  }

  /** One MCP tools/list now (instead of waiting for the health loop); stores the result. */
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

  private async collectGarbage(rows: StoreWithUpstream[]): Promise<void> {
    const ids = new Set(rows.map((r) => r.id));
    const namespaces: KubeItem[] = await this.deps.kube.listNamespaces(
      `app.kubernetes.io/managed-by=${MANAGED_BY}`,
    );
    for (const n of namespaces) {
      const id = n.metadata.labels?.[LABEL_STORE_ID];
      const slug = n.metadata.labels?.[LABEL_STORE_SLUG];
      if (!id || !slug || ids.has(id) || n.metadata.deletionTimestamp) continue;
      if (n.metadata.name !== storeNamespace(slug)) continue;
      // Created after this pass listed the rows (an API create racing the tick)? Then keep it.
      const { rowCount } = await this.deps.pool.query(`SELECT 1 FROM stores WHERE id = $1`, [id]);
      if (rowCount) continue;
      this.deps.log.warn({ store: slug }, 'deleting orphaned store namespace');
      await this.deps.kube.delete('Namespace', '', n.metadata.name);
    }
  }
}
