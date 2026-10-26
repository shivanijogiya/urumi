// Phase of a hosted server from what Kubernetes and the health loop report (ADR 014). Pure, so the
// state machine is unit-tested without a cluster:
//
//   (no Deployment yet) ─────────────────────────────▶ deploying  "Creating Kubernetes objects"
//   pod waiting: ImagePullBackOff / ErrImagePull / CrashLoopBackOff / CreateContainerConfigError …
//   Deployment ReplicaFailure (e.g. Pod Security, quota) or ProgressDeadlineExceeded ─▶ failed
//   pod not ready yet ───────────────────────────────▶ deploying  "<waiting reason>"
//   pod ready, upstream not checked yet ─────────────▶ deploying  "Waiting for the first MCP check"
//   pod ready, upstream up ──────────────────────────▶ connected
//   pod ready, upstream down ────────────────────────▶ unreachable "<health check detail>"
//   delete requested ────────────────────────────────▶ deleting
//
// Failure beats readiness: a pod in CrashLoopBackOff is failed even if an older pod is still up.
import type { HostedServerRow, UpstreamRow } from '@urumi/contracts/db';
import type { DeploymentStatus, PodStatus } from './kube.js';

export type Phase = HostedServerRow['phase'];
export interface PhaseResult {
  phase: Phase;
  reason: string | null;
}

/** Container waiting reasons that will not fix themselves. */
export const FAILED_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ErrImageNeverPull',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

const MAX_REASON = 300;
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

function describeWaiting(c: NonNullable<PodStatus['status']>['containerStatuses']): string | null {
  for (const s of c ?? []) {
    const w = s.state?.waiting?.reason;
    if (w && FAILED_WAITING_REASONS.has(w)) {
      if (w === 'CrashLoopBackOff') {
        const t = s.lastState?.terminated;
        const last = t ? ` (last exit: ${t.reason ?? 'Error'}, code ${t.exitCode ?? '?'})` : '';
        return `CrashLoopBackOff: the container keeps exiting${last}`;
      }
      if (w === 'ImagePullBackOff' || w === 'ErrImagePull') {
        return `${w}: the image could not be pulled (missing, private or wrong tag)`;
      }
      return w;
    }
  }
  return null;
}

export function derivePhase(input: {
  desiredState: HostedServerRow['desired_state'];
  deployment: DeploymentStatus | null;
  pods: PodStatus[];
  upstream: Pick<UpstreamRow, 'enabled' | 'status' | 'last_error'>;
}): PhaseResult {
  if (input.desiredState === 'absent') return { phase: 'deleting', reason: null };
  const dep = input.deployment;
  if (!dep) return { phase: 'deploying', reason: 'Creating Kubernetes objects' };

  const live = input.pods.filter((p) => !p.metadata.deletionTimestamp);
  for (const pod of live) {
    const failed = describeWaiting(pod.status?.containerStatuses);
    if (failed) return { phase: 'failed', reason: clip(failed) };
  }
  for (const c of dep.status?.conditions ?? []) {
    if (c.type === 'ReplicaFailure' && c.status === 'True') {
      return {
        phase: 'failed',
        reason: clip(`${c.reason ?? 'ReplicaFailure'}: ${c.message ?? ''}`),
      };
    }
    if (
      c.type === 'Progressing' &&
      c.status === 'False' &&
      c.reason === 'ProgressDeadlineExceeded'
    ) {
      return {
        phase: 'failed',
        reason: 'ProgressDeadlineExceeded: the pod did not become ready in 180 s',
      };
    }
  }

  const ready = (dep.status?.availableReplicas ?? 0) >= 1;
  if (!ready) {
    for (const pod of live) {
      const unsched = pod.status?.conditions?.find(
        (c) => c.type === 'PodScheduled' && c.status === 'False',
      );
      if (unsched)
        return {
          phase: 'deploying',
          reason: clip(`${unsched.reason ?? 'Pending'}: ${unsched.message ?? ''}`),
        };
      const waiting = pod.status?.containerStatuses?.find((s) => s.state?.waiting?.reason)?.state
        ?.waiting?.reason;
      if (waiting) return { phase: 'deploying', reason: waiting };
    }
    return { phase: 'deploying', reason: 'Waiting for the pod to become ready' };
  }
  if (!input.upstream.enabled || input.upstream.status === 'unknown') {
    return { phase: 'deploying', reason: 'Waiting for the first MCP check' };
  }
  if (input.upstream.status === 'down') {
    return {
      phase: 'unreachable',
      reason: clip(input.upstream.last_error ?? 'Health check failed'),
    };
  }
  return { phase: 'connected', reason: null };
}
