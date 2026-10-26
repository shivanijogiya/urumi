// Phase of a store from what Kubernetes and the health loop report (ADR 015). Pure, so the state
// machine is unit-tested without a cluster:
//
//   delete requested ───────────────────────────────────────────────▶ deleting
//   a container that cannot start: ImagePullBackOff / ErrImagePull / CreateContainerConfigError /
//   CrashLoopBackOff (3+ restarts) · bootstrap Job Failed · ReplicaFailure (quota, Pod Security)
//                                                                   ─▶ failed  "<component>: …"
//   no namespace yet ───────────────────────────────────────────────▶ provisioning "Creating …"
//   MariaDB, WordPress, bootstrap Job, woo-mcp, first MCP check not done yet
//                                                                   ─▶ provisioning "<step>"
//   still provisioning after the timeout ───────────────────────────▶ failed  "Timed out …: <step>"
//   woo-mcp registered and its upstream up ─────────────────────────▶ ready
//
// `ready` is sticky (later health is the upstream's status, shown next to it) and `failed` is
// terminal until the admin presses Retry (the provisioner then starts a new bootstrap generation).
import type { StoreRow, UpstreamRow } from '@urumi/contracts/db';
import type { ContainerState, KubeItem } from './kube.js';

export type StorePhase = StoreRow['phase'];
export interface StorePhaseResult {
  phase: StorePhase;
  reason: string | null;
}

/** Container waiting reasons that will not fix themselves. */
export const FATAL_WAITING = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ErrImageNeverPull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);
export const CRASH_RESTARTS = 3;

const MAX_REASON = 300;
export const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

export interface StoreObservation {
  desiredState: StoreRow['desired_state'];
  /** The row's current phase (ready is sticky). */
  current: StorePhase;
  namespace: KubeItem | null;
  mariadb: KubeItem | null;
  wordpress: KubeItem | null;
  job: KubeItem | null;
  wooMcp: KubeItem | null;
  pods: KubeItem[];
  upstream: Pick<UpstreamRow, 'enabled' | 'status' | 'last_error'>;
  provisionStartedAt: Date;
  now: Date;
  timeoutMs: number;
}

const componentOf = (p: KubeItem) => p.metadata.labels?.['app.kubernetes.io/component'] ?? 'pod';

function fatalContainer(pod: KubeItem): string | null {
  const all: ContainerState[] = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  for (const c of all) {
    const w = c.state?.waiting;
    if (w?.reason && FATAL_WAITING.has(w.reason)) {
      const hint =
        w.reason === 'ImagePullBackOff' || w.reason === 'ErrImagePull'
          ? 'the image could not be pulled'
          : (w.message ?? '');
      return `${componentOf(pod)}: ${w.reason}${hint ? `: ${hint}` : ''}`;
    }
    if (w?.reason === 'CrashLoopBackOff' && (c.restartCount ?? 0) >= CRASH_RESTARTS) {
      const t = c.lastState?.terminated;
      return `${componentOf(pod)}: CrashLoopBackOff (container ${c.name}, last exit ${t?.reason ?? 'Error'} code ${t?.exitCode ?? '?'})`;
    }
  }
  return null;
}

function condition(item: KubeItem | null, type: string) {
  return item?.status?.conditions?.find((c) => c.type === type && c.status === 'True');
}

/** Why a component's pod is not running yet (Unschedulable: unbound PVC, quota…), if known. */
function pendingDetail(pods: KubeItem[], comp: string): string | null {
  for (const p of pods) {
    if (componentOf(p) !== comp || p.metadata.deletionTimestamp) continue;
    const unsched = p.status?.conditions?.find(
      (c) => c.type === 'PodScheduled' && c.status === 'False',
    );
    if (unsched) return `${unsched.reason ?? 'Pending'}: ${unsched.message ?? ''}`;
    const w = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])]
      .map((c) => c.state?.waiting?.reason)
      .find(Boolean);
    if (w) return w;
  }
  return null;
}

export function deriveStorePhase(o: StoreObservation): StorePhaseResult {
  if (o.desiredState === 'absent') {
    return {
      phase: 'deleting',
      reason: o.namespace ? 'Deleting the namespace (volumes included)' : 'Removing the upstream',
    };
  }
  if (o.current === 'ready') {
    return {
      phase: 'ready',
      reason:
        o.upstream.status === 'down'
          ? clip(`woo-mcp unreachable: ${o.upstream.last_error ?? 'health check failed'}`)
          : null,
    };
  }

  // Failures that will not fix themselves.
  for (const pod of o.pods) {
    if (pod.metadata.deletionTimestamp) continue;
    const fatal = fatalContainer(pod);
    if (fatal) return { phase: 'failed', reason: clip(fatal) };
  }
  const jobFailed = condition(o.job, 'Failed');
  if (jobFailed) {
    return {
      phase: 'failed',
      reason: clip(
        `Bootstrap job failed (${jobFailed.reason ?? 'Failed'}${jobFailed.message ? `: ${jobFailed.message}` : ''}); see kubectl logs job/${o.job!.metadata.name}`,
      ),
    };
  }
  for (const [name, item] of [
    ['mariadb', o.mariadb],
    ['wordpress', o.wordpress],
    ['woo-mcp', o.wooMcp],
  ] as const) {
    const rf = condition(item, 'ReplicaFailure');
    if (rf) return { phase: 'failed', reason: clip(`${name}: ${rf.reason ?? 'ReplicaFailure'}: ${rf.message ?? ''}`) };
  }

  const step = progress(o);
  if (step === null) return { phase: 'ready', reason: null };
  if (o.now.getTime() - o.provisionStartedAt.getTime() > o.timeoutMs) {
    const min = Math.round(o.timeoutMs / 60_000);
    return { phase: 'failed', reason: clip(`Timed out after ${min} min: ${step}`) };
  }
  return { phase: 'provisioning', reason: clip(step) };
}

/** The current provisioning step, or null when everything is up. */
function progress(o: StoreObservation): string | null {
  const withDetail = (step: string, comp: string) => {
    const d = pendingDetail(o.pods, comp);
    return d ? `${step} (${d})` : step;
  };
  if (!o.namespace) return 'Creating the namespace';
  if (!o.mariadb || (o.mariadb.status?.readyReplicas ?? 0) < 1) {
    return withDetail('Starting MariaDB', 'mariadb');
  }
  if (!o.wordpress || (o.wordpress.status?.availableReplicas ?? 0) < 1) {
    return withDetail('Starting WordPress', 'wordpress');
  }
  if (!o.job || (o.job.status?.succeeded ?? 0) < 1) {
    return withDetail('Installing WordPress and WooCommerce (bootstrap job)', 'bootstrap');
  }
  if (!o.wooMcp || (o.wooMcp.status?.availableReplicas ?? 0) < 1) {
    return withDetail('Starting woo-mcp', 'woo-mcp');
  }
  if (!o.upstream.enabled || o.upstream.status === 'unknown') return 'Registering the upstream';
  if (o.upstream.status === 'down') {
    return `Waiting for woo-mcp to answer MCP (${o.upstream.last_error ?? 'check failed'})`;
  }
  return null;
}
