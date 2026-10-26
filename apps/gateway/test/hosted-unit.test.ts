// Hosted MCP servers (ADR 014), pure parts: manifest hardening, image allow-list, phase state
// machine, Kubernetes API error details.
import { CreateHostedServerRequestSchema } from '@urumi/contracts';
import { describe, expect, it } from 'vitest';
import { checkImage, normaliseAllowList, parseImageRef } from '../src/hosted/images.js';
import { statusDetail, type DeploymentStatus, type PodStatus } from '../src/hosted/kube.js';
import {
  buildManifests,
  HOSTED_UID,
  hostedUrl,
  PRESETS,
  serviceHost,
  type HostedSpec,
} from '../src/hosted/manifests.js';
import { derivePhase } from '../src/hosted/status.js';

const ID = '5f0c6a8e-1b2d-4c3e-9f4a-7b6c5d4e3f21';
const OPTS = { namespace: 'urumi-hosted', serviceAccountName: 'hosted-mcp' };
const base: HostedSpec = {
  id: ID,
  slug: 'demo',
  imageRef: 'k3d-urumi-registry.localhost:5005/urumi-everything:dev',
  port: 3001,
  preset: 'small',
  egress: false,
  env: {},
  envVersion: 'none',
};

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function podSpec(spec: HostedSpec): AnyObj {
  return (buildManifests(spec, OPTS).deployment as AnyObj).spec.template.spec;
}

/** Every security-relevant field of the pod, which no admin input may change. */
function hardening(spec: HostedSpec) {
  const pod = podSpec(spec);
  const c = pod.containers[0];
  return {
    pod: {
      automountServiceAccountToken: pod.automountServiceAccountToken,
      serviceAccountName: pod.serviceAccountName,
      enableServiceLinks: pod.enableServiceLinks,
      hostNetwork: pod.hostNetwork,
      hostPID: pod.hostPID,
      hostIPC: pod.hostIPC,
      securityContext: pod.securityContext,
      volumes: pod.volumes,
      containerCount: pod.containers.length,
      initContainers: pod.initContainers,
    },
    container: {
      securityContext: c.securityContext,
      volumeMounts: c.volumeMounts,
      command: c.command,
      args: c.args,
      probes: [c.readinessProbe.tcpSocket, c.livenessProbe.tcpSocket],
      envNames: c.env.map((e: AnyObj) => e.name),
      portEnv: c.env.find((e: AnyObj) => e.name === 'PORT')?.value,
    },
  };
}

describe('buildManifests: the hardened pod template', () => {
  it('runs non-root, read-only root fs (+ /tmp emptyDir), no caps, RuntimeDefault, no token', () => {
    const pod = podSpec(base);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.hostNetwork).toBe(false);
    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: HOSTED_UID,
      runAsGroup: HOSTED_UID,
      fsGroup: HOSTED_UID,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    const c = pod.containers[0];
    expect(c.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: HOSTED_UID,
      runAsGroup: HOSTED_UID,
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(c.volumeMounts).toEqual([{ name: 'tmp', mountPath: '/tmp' }]);
    expect(pod.volumes).toEqual([{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }]);
    expect(c.readinessProbe.tcpSocket).toEqual({ port: 3001 });
    expect(c.livenessProbe.tcpSocket).toEqual({ port: 3001 });
    expect(c.resources).toEqual(PRESETS.small);
    expect(c.command).toBeUndefined();
    expect(c.args).toBeUndefined();
  });

  it('no admin input (image, port, preset, egress, env) changes any hardening field', () => {
    const reference = hardening(base);
    const hostile: Partial<HostedSpec>[] = [
      { imageRef: 'docker.io/mcp/other@sha256:' + 'a'.repeat(64) },
      { preset: 'medium' },
      { egress: true },
      // A Secret key named like a security knob is just an env var; PORT is never overridden.
      {
        env: {
          PORT: '1',
          securityContext: 'privileged',
          KUBERNETES_SERVICE_HOST: 'x',
          runAsUser: '0',
        },
        envVersion: 'v2',
      },
    ];
    for (const h of hostile) {
      expect(hardening({ ...base, ...h })).toEqual(reference);
    }
    // The port changes only the probes' port and PORT, which are derived from it.
    const other = hardening({ ...base, port: 8080 });
    expect({ ...other.container, probes: undefined, portEnv: undefined }).toEqual({
      ...reference.container,
      probes: undefined,
      portEnv: undefined,
    });
    expect(other.pod).toEqual(reference.pod);
  });

  it('env values go only into the Secret (base64), referenced by envFrom; PORT stays in env', () => {
    const m = buildManifests({ ...base, env: { API_TOKEN: 'tok-123' }, envVersion: 'v1' }, OPTS);
    expect(m.secret).not.toBeNull();
    expect((m.secret as AnyObj).data).toEqual({
      API_TOKEN: Buffer.from('tok-123').toString('base64'),
    });
    expect(JSON.stringify(m.deployment)).not.toContain('tok-123');
    expect(JSON.stringify(m.deployment)).not.toContain(Buffer.from('tok-123').toString('base64'));
    const c = podSpec({ ...base, env: { API_TOKEN: 'tok-123' }, envVersion: 'v1' }).containers[0];
    expect(c.envFrom).toEqual([{ secretRef: { name: 'mcp-demo-env' } }]);
    expect(c.env).toEqual([{ name: 'PORT', value: '3001' }]);
    expect(buildManifests(base, OPTS).secret).toBeNull();
  });

  it('labels select the server and carry the egress choice for the NetworkPolicies', () => {
    const m = buildManifests({ ...base, egress: true }, OPTS);
    const labels = (m.deployment as AnyObj).spec.template.metadata.labels;
    expect(labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'urumi-gateway',
      'urumi.io/hosted-id': ID,
      'urumi.io/hosted-slug': 'demo',
      'urumi.io/hosted-egress': 'internet',
    });
    expect(buildManifests(base, OPTS).deployment.metadata.labels['urumi.io/hosted-egress']).toBe(
      'none',
    );
    for (const o of [m.deployment, m.service]) expect(o.metadata.namespace).toBe('urumi-hosted');
    expect((m.service as AnyObj).spec).toEqual({
      type: 'ClusterIP',
      selector: { 'urumi.io/hosted-id': ID },
      ports: [{ name: 'mcp', port: 3001, targetPort: 3001, protocol: 'TCP' }],
    });
  });

  it('the spec hash changes with the spec and the env version, not otherwise', () => {
    const h = (s: Partial<HostedSpec>) => buildManifests({ ...base, ...s }, OPTS).specHash;
    expect(h({})).toBe(h({}));
    expect(h({ envVersion: 'v2' })).not.toBe(h({}));
    expect(h({ preset: 'medium' })).not.toBe(h({}));
    expect(h({ egress: true })).not.toBe(h({}));
    const pod = (buildManifests(base, OPTS).deployment as AnyObj).spec.template.metadata;
    expect(pod.annotations['urumi.io/spec-hash']).toBe(h({}));
  });

  it('the upstream URL is the generated Service host', () => {
    expect(serviceHost('demo', 'urumi-hosted')).toBe('mcp-demo.urumi-hosted.svc.cluster.local');
    expect(hostedUrl('demo', 'urumi-hosted', 3001, '/mcp')).toBe(
      'http://mcp-demo.urumi-hosted.svc.cluster.local:3001/mcp',
    );
  });
});

describe('image allow-list', () => {
  const allow = normaliseAllowList(['k3d-urumi-registry.localhost:5005/', 'docker.io/mcp']);
  const ok = (image: string, requireDigest = false) => checkImage(image, { allow, requireDigest });

  it('normalises Docker Hub short names', () => {
    expect(parseImageRef('mcp/fetch:1.0').name).toBe('docker.io/mcp/fetch:1.0');
    expect(parseImageRef('localhost:5000/x').name).toBe('localhost:5000/x');
    expect(allow).toEqual(['k3d-urumi-registry.localhost:5005/', 'docker.io/mcp/']);
  });

  it('accepts images under an allowed prefix and records a digest', () => {
    expect(ok('k3d-urumi-registry.localhost:5005/urumi-everything:dev').ref).toBe(
      'k3d-urumi-registry.localhost:5005/urumi-everything:dev',
    );
    const pinned = ok('mcp/fetch@sha256:' + 'b'.repeat(64));
    expect(pinned).toEqual({
      name: 'docker.io/mcp/fetch',
      digest: 'sha256:' + 'b'.repeat(64),
      ref: 'docker.io/mcp/fetch@sha256:' + 'b'.repeat(64),
    });
  });

  it.each([
    'ghcr.io/evil/server:latest',
    'docker.io/mcpevil/x:1', // prefix must end at a path boundary
    'k3d-urumi-registry.localhost:5005.evil.com/x:1', // not even a valid reference
    'docker.io/library/alpine:3',
    'evil/mcp:1', // docker.io/evil/mcp
  ])('rejects %s with a clear error', (image) => {
    expect(() => ok(image)).toThrow(/not allowed|Invalid image reference/);
  });

  it('rejects malformed references', () => {
    for (const bad of ['UPPER/case:1', 'a b/c', 'x/y@sha256:short', '../x/y', 'docker.io/mcp/']) {
      expect(() => ok(bad)).toThrow(/Invalid image reference|not allowed/);
    }
  });

  it('requireDigest refuses tag-only references', () => {
    expect(() => ok('mcp/fetch:1', true)).toThrow(/pinned by digest/);
    expect(ok('mcp/fetch@sha256:' + 'c'.repeat(64), true).digest).toMatch(/^sha256:/);
  });

  it('the request schema rejects platform env names and too many variables', () => {
    const req = (env: Record<string, string>) =>
      CreateHostedServerRequestSchema.safeParse({
        slug: 'demo',
        name: 'Demo',
        image: 'mcp/x:1',
        port: 3001,
        env,
      }).success;
    expect(req({ API_TOKEN: 'x' })).toBe(true);
    expect(req({ PORT: '1' })).toBe(false);
    expect(req({ KUBERNETES_SERVICE_HOST: '1' })).toBe(false);
    expect(req({ 'bad-name': '1' })).toBe(false);
    expect(req(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, 'x'])))).toBe(
      false,
    );
    expect(
      CreateHostedServerRequestSchema.safeParse({
        slug: 'd',
        name: 'D',
        image: 'mcp/x:1',
        port: 80,
      }).success,
    ).toBe(false); // privileged port
  });
});

describe('derivePhase (reconciler state machine)', () => {
  const upUnknown = { enabled: false, status: 'unknown' as const, last_error: null };
  const dep = (available: number, conditions: AnyObj[] = []): DeploymentStatus => ({
    metadata: { name: 'mcp-demo' },
    status: { availableReplicas: available, conditions: conditions as never },
  });
  const pod = (waiting?: string, extra: AnyObj = {}): PodStatus => ({
    metadata: { name: 'mcp-demo-abc' },
    status: {
      containerStatuses: [
        {
          name: 'mcp',
          state: waiting ? { waiting: { reason: waiting } } : { running: {} },
          ...extra,
        },
      ],
    },
  });
  const phase = (
    deployment: DeploymentStatus | null,
    pods: PodStatus[],
    upstream: AnyObj = upUnknown,
  ) => derivePhase({ desiredState: 'present', deployment, pods, upstream: upstream as never });

  it('deploying until the Deployment exists and the pod is ready', () => {
    expect(phase(null, [])).toEqual({ phase: 'deploying', reason: 'Creating Kubernetes objects' });
    expect(phase(dep(0), [pod('ContainerCreating')])).toEqual({
      phase: 'deploying',
      reason: 'ContainerCreating',
    });
    expect(phase(dep(0), [])).toEqual({
      phase: 'deploying',
      reason: 'Waiting for the pod to become ready',
    });
  });

  it('ready but not yet checked -> deploying; up -> connected; down -> unreachable with detail', () => {
    expect(phase(dep(1), [pod()]).phase).toBe('deploying');
    expect(phase(dep(1), [pod()], { enabled: true, status: 'up', last_error: null })).toEqual({
      phase: 'connected',
      reason: null,
    });
    expect(
      phase(dep(1), [pod()], { enabled: true, status: 'down', last_error: 'HTTP 404' }),
    ).toEqual({ phase: 'unreachable', reason: 'HTTP 404' });
  });

  it.each(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'CreateContainerConfigError'])(
    '%s -> failed with that reason',
    (reason) => {
      const r = phase(dep(0), [pod(reason)]);
      expect(r.phase).toBe('failed');
      expect(r.reason).toMatch(new RegExp(`^${reason}`));
    },
  );

  it('CrashLoopBackOff reports the last exit, and beats an older ready replica', () => {
    const r = phase(
      dep(1),
      [pod('CrashLoopBackOff', { lastState: { terminated: { reason: 'Error', exitCode: 1 } } })],
      { enabled: true, status: 'up', last_error: null },
    );
    expect(r).toEqual({
      phase: 'failed',
      reason: 'CrashLoopBackOff: the container keeps exiting (last exit: Error, code 1)',
    });
  });

  it('ReplicaFailure (Pod Security / quota) and ProgressDeadlineExceeded -> failed', () => {
    const psa = phase(
      dep(0, [
        {
          type: 'ReplicaFailure',
          status: 'True',
          reason: 'FailedCreate',
          message: 'pods "x" is forbidden: exceeded quota',
        },
      ]),
      [],
    );
    expect(psa.phase).toBe('failed');
    expect(psa.reason).toContain('exceeded quota');
    expect(
      phase(
        dep(0, [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }]),
        [],
      ).phase,
    ).toBe('failed');
  });

  it('terminating pods are ignored; unschedulable pods say why; delete -> deleting', () => {
    const old = { ...pod('ImagePullBackOff'), metadata: { name: 'old', deletionTimestamp: 'x' } };
    expect(phase(dep(1), [old], { enabled: true, status: 'up', last_error: null }).phase).toBe(
      'connected',
    );
    const pending: PodStatus = {
      metadata: { name: 'p' },
      status: {
        conditions: [
          { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes' },
        ],
      },
    };
    expect(phase(dep(0), [pending])).toEqual({
      phase: 'deploying',
      reason: 'Unschedulable: 0/1 nodes',
    });
    expect(
      derivePhase({ desiredState: 'absent', deployment: dep(1), pods: [], upstream: upUnknown }),
    ).toEqual({ phase: 'deleting', reason: null });
  });
});

describe('statusDetail', () => {
  it('keeps the API reason and a bounded message, nothing else', () => {
    expect(
      statusDetail(403, { reason: 'Forbidden', message: 'deployments.apps is forbidden' }),
    ).toBe('Kubernetes API HTTP 403 Forbidden: deployments.apps is forbidden');
    expect(statusDetail(500, null)).toBe('Kubernetes API HTTP 500');
    expect(statusDetail(422, { message: 'x'.repeat(500) }).length).toBeLessThan(260);
  });
});
