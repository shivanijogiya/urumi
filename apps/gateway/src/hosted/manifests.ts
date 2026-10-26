// Kubernetes objects for one hosted MCP server (ADR 014): a Deployment, a ClusterIP Service and, when
// the server has env vars, a Secret. Everything security-relevant is fixed here and is NOT taken
// from the request: the admin chooses only the image (allow-listed), the container port, the
// resource preset (an enum mapped to fixed requests/limits), whether internet egress is allowed (a
// pod label the namespace's NetworkPolicies key on) and env var values (Secret data). Every pod runs
// non-root with a read-only root filesystem, no capabilities, RuntimeDefault seccomp, no service
// account token, no host namespaces and no service links; the namespace's `restricted` Pod Security
// Admission rejects anything weaker even if this code were changed.
import { createHash } from 'node:crypto';

export const MANAGED_BY = 'urumi-gateway';
export const FIELD_MANAGER = 'urumi-gateway';
export const LABEL_ID = 'urumi.io/hosted-id';
export const LABEL_SLUG = 'urumi.io/hosted-slug';
export const LABEL_EGRESS = 'urumi.io/hosted-egress';
export const ANNOTATION_SPEC_HASH = 'urumi.io/spec-hash';
/** uid/gid every hosted container runs as (not root, not the image's choice). */
export const HOSTED_UID = 65532;

export const PRESETS = {
  small: { requests: { cpu: '10m', memory: '48Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
  medium: { requests: { cpu: '25m', memory: '96Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
} as const;
export type Preset = keyof typeof PRESETS;

export interface HostedSpec {
  id: string;
  slug: string;
  /** Pod image reference (`name` or `name@sha256:…`), already allow-listed. */
  imageRef: string;
  port: number;
  preset: Preset;
  egress: boolean;
  /** Plaintext env values; only ever written into the Secret. */
  env: Record<string, string>;
  /** Changes whenever the env values change (the sealed value's IV), without hashing secrets. */
  envVersion: string;
}

export interface ManifestOptions {
  namespace: string;
  /** ServiceAccount the pods run as (chart-created, token automount off). */
  serviceAccountName: string;
}

export type KubeObject = {
  apiVersion: string;
  kind: 'Deployment' | 'Service' | 'Secret';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
  };
  [k: string]: unknown;
};

export interface HostedManifests {
  deployment: KubeObject;
  service: KubeObject;
  /** Null when the server has no env vars (any old Secret is deleted). */
  secret: KubeObject | null;
  specHash: string;
}

/** Deployment and Service name: `mcp-<slug>` (slugs are DNS labels of at most 20 chars). */
export const objectName = (slug: string) => `mcp-${slug}`;
export const secretName = (slug: string) => `mcp-${slug}-env`;
/** The only in-cluster host the SSRF guard lets a hosted upstream row reach. */
export const serviceHost = (slug: string, namespace: string) =>
  `${objectName(slug)}.${namespace}.svc.cluster.local`;
export const hostedUrl = (slug: string, namespace: string, port: number, mcpPath: string) =>
  `http://${serviceHost(slug, namespace)}:${port}${mcpPath}`;

export function specHash(spec: HostedSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify([spec.imageRef, spec.port, spec.preset, spec.egress, spec.envVersion, 2]),
    )
    .digest('hex')
    .slice(0, 16);
}

export function labelsFor(
  spec: Pick<HostedSpec, 'id' | 'slug' | 'egress'>,
): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'hosted-mcp',
    'app.kubernetes.io/instance': objectName(spec.slug),
    'app.kubernetes.io/managed-by': MANAGED_BY,
    [LABEL_ID]: spec.id,
    [LABEL_SLUG]: spec.slug,
    [LABEL_EGRESS]: spec.egress ? 'internet' : 'none',
  };
}

export function buildManifests(spec: HostedSpec, opts: ManifestOptions): HostedManifests {
  const name = objectName(spec.slug);
  const labels = labelsFor(spec);
  const hash = specHash(spec);
  const hasEnv = Object.keys(spec.env).length > 0;
  const meta = (n: string) => ({ name: n, namespace: opts.namespace, labels: { ...labels } });

  const secret: KubeObject | null = hasEnv
    ? {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: meta(secretName(spec.slug)),
        type: 'Opaque',
        immutable: false,
        data: Object.fromEntries(
          Object.entries(spec.env).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]),
        ),
      }
    : null;

  const container = {
    name: 'mcp',
    image: spec.imageRef,
    imagePullPolicy: 'IfNotPresent',
    ports: [{ name: 'mcp', containerPort: spec.port, protocol: 'TCP' }],
    // `env` wins over `envFrom`, so a Secret key named PORT could not override this either.
    env: [{ name: 'PORT', value: String(spec.port) }],
    ...(hasEnv ? { envFrom: [{ secretRef: { name: secretName(spec.slug) } }] } : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: HOSTED_UID,
      runAsGroup: HOSTED_UID,
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    },
    resources: structuredClone(PRESETS[spec.preset]),
    readinessProbe: {
      tcpSocket: { port: spec.port },
      periodSeconds: 5,
      timeoutSeconds: 3,
      failureThreshold: 3,
    },
    livenessProbe: {
      tcpSocket: { port: spec.port },
      initialDelaySeconds: 15,
      periodSeconds: 20,
      timeoutSeconds: 3,
      failureThreshold: 3,
    },
    volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
  };

  const deployment: KubeObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { ...meta(name), annotations: { [ANNOTATION_SPEC_HASH]: hash } },
    spec: {
      replicas: 1,
      revisionHistoryLimit: 2,
      progressDeadlineSeconds: 180,
      // One pod at a time: a rollout never needs room for two under the namespace quota.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { [LABEL_ID]: spec.id } },
      template: {
        metadata: { labels: { ...labels }, annotations: { [ANNOTATION_SPEC_HASH]: hash } },
        spec: {
          serviceAccountName: opts.serviceAccountName,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          terminationGracePeriodSeconds: 10,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: HOSTED_UID,
            runAsGroup: HOSTED_UID,
            fsGroup: HOSTED_UID,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [container],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }],
        },
      },
    },
  };

  const service: KubeObject = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(name),
    spec: {
      type: 'ClusterIP',
      selector: { [LABEL_ID]: spec.id },
      ports: [{ name: 'mcp', port: spec.port, targetPort: spec.port, protocol: 'TCP' }],
    },
  };

  return { deployment, service, secret, specHash: hash };
}
