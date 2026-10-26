// Pure parts of multi-store (ADR 015): manifest generation (isolation, hardening, quota, no
// cross-store allows), slug validation, the namespace guard of the store Kubernetes client, and the
// phase state machine (progress, failures, timeout, sticky ready, deleting).
import { CreateStoreRequestSchema, RESERVED_STORE_SLUGS, StoreSlugSchema } from '@urumi/contracts';
import { describe, expect, it } from 'vitest';
import { KubeError } from '../src/hosted/kube.js';
import { assertStoreNamespace, checkWritable, collectionPath } from '../src/stores/kube.js';
import {
  buildStoreManifests,
  generatedSecrets,
  type StoreObject,
  type StoreSpec,
} from '../src/stores/manifests.js';
import { storeServiceHost, storeUpstreamUrl } from '../src/stores/names.js';
import { StoreSettingsSchema, type StoreSettings } from '../src/stores/settings.js';
import { deriveStorePhase, type StoreObservation } from '../src/stores/status.js';

export const SETTINGS: StoreSettings = StoreSettingsSchema.parse({
  domainSuffix: 'store.localtest.me',
  scheme: 'http',
  environmentType: 'local',
  woocommerce: { version: '11.0.1', currency: 'INR', defaultCountry: 'IN:DL' },
  apiUser: 'woo-mcp',
  images: {
    wordpress: { image: 'wordpress:6-php8.3-apache' },
    mariadb: { image: 'mariadb:11.4' },
    wpCli: { image: 'wordpress:cli-2.12.0-php8.3' },
    kubectl: { image: 'alpine/k8s:1.35.9' },
    wooMcp: { image: 'k3d-urumi-registry.localhost:5005/urumi-woo-mcp:dev', pullPolicy: 'Always' },
  },
  storageClass: 'local-path',
  storage: { mariadb: '1Gi', wordpress: '1Gi' },
  resources: {
    mariadb: { requests: { cpu: '25m', memory: '128Mi' }, limits: { cpu: '500m', memory: '320Mi' } },
    wordpress: { requests: { cpu: '25m', memory: '96Mi' }, limits: { cpu: '1', memory: '384Mi' } },
    wooMcp: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
    wpCli: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '1', memory: '512Mi' } },
    kubectl: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
  },
  quota: {
    pods: '6',
    'requests.cpu': '300m',
    'requests.memory': '512Mi',
    'limits.cpu': '3',
    'limits.memory': '1536Mi',
    persistentvolumeclaims: '2',
    'requests.storage': '4Gi',
    'services.nodeports': '0',
    'services.loadbalancers': '0',
  },
  network: {
    gatewayNamespace: 'urumi',
    gatewayPodSelector: {
      matchLabels: { 'app.kubernetes.io/instance': 'urumi' },
      matchExpressions: [{ key: 'app.kubernetes.io/component', operator: 'In', values: ['gateway'] }],
    },
    ingressNamespace: 'kube-system',
    ingressPodLabels: { 'app.kubernetes.io/name': 'traefik' },
    dnsNamespace: 'kube-system',
    dnsPodLabels: { 'k8s-app': 'kube-dns' },
    kubeApi: { cidr: '0.0.0.0/0', ports: [443, 6443] },
    internet: {
      ports: [80, 443],
      except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8'],
    },
  },
  clusterRoles: { manager: 'urumi-store-manager', bootstrap: 'urumi-store-bootstrap' },
  gatewayServiceAccount: { name: 'urumi-gateway', namespace: 'urumi' },
});

export const SHARED = 'store-shared-secret-value-5b9d0c1e2f3a4b5c6d7e';
const SPEC: StoreSpec = {
  id: '11111111-2222-4333-8444-555555555555',
  slug: 'shop2',
  name: 'Shop Two',
  adminEmail: 'owner@example.com',
  generation: 1,
  sharedSecret: SHARED,
  scripts: { 'bootstrap.sh': '#!/bin/sh\n', 'wp-cli.yml': 'path: /var/www/html\n' },
};

const all = (m: ReturnType<typeof buildStoreManifests>): StoreObject[] => [
  m.namespace,
  ...m.roleBindings,
  ...m.apply,
  m.wooMcp,
  m.job,
];
const byKind = (objs: StoreObject[], kind: string) => objs.filter((o) => o.kind === kind);
type PodSpec = {
  automountServiceAccountToken?: boolean;
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  securityContext: { runAsNonRoot: boolean; runAsUser: number; seccompProfile: { type: string } };
  containers: Container[];
  initContainers?: Container[];
  volumes?: { projected?: unknown; hostPath?: unknown }[];
};
type Container = {
  name: string;
  securityContext: {
    allowPrivilegeEscalation: boolean;
    privileged?: boolean;
    capabilities: { drop: string[]; add?: string[] };
  };
  resources: { requests: Record<string, string>; limits: Record<string, string> };
  volumeMounts?: { name: string }[];
};
const podSpecOf = (o: StoreObject) =>
  (o.spec as { template: { spec: PodSpec } }).template.spec;

describe('store manifests', () => {
  const m = buildStoreManifests(SPEC, SETTINGS);
  const objs = all(m);

  it('puts every namespaced object in store-<slug>, labelled with the store', () => {
    expect(m.namespace.metadata.name).toBe('store-shop2');
    for (const o of objs.filter((x) => x.kind !== 'Namespace')) {
      expect(o.metadata.namespace, `${o.kind}/${o.metadata.name}`).toBe('store-shop2');
      expect(o.metadata.labels['urumi.io/store-id']).toBe(SPEC.id);
      expect(o.metadata.labels['app.kubernetes.io/managed-by']).toBe('urumi-gateway');
    }
  });

  it('enforces Pod Security restricted on the namespace', () => {
    const l = m.namespace.metadata.labels;
    expect(l['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(l['urumi.io/store']).toBe('true');
  });

  it('has a default deny for ingress and egress', () => {
    const deny = byKind(objs, 'NetworkPolicy').find((n) => n.metadata.name === 'default-deny')!;
    expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
  });

  it('allows exactly the store flows and no other namespace except gateway, ingress and DNS', () => {
    type Peer = {
      podSelector?: { matchLabels?: Record<string, string> };
      namespaceSelector?: { matchLabels: Record<string, string> };
      ipBlock?: { cidr: string; except?: string[] };
    };
    type Rule = { from?: Peer[]; to?: Peer[]; ports?: { port: number }[] };
    const flows: string[] = [];
    for (const np of byKind(objs, 'NetworkPolicy')) {
      const spec = np.spec as { podSelector: { matchLabels?: Record<string, string> }; ingress?: Rule[]; egress?: Rule[] };
      const self = spec.podSelector.matchLabels?.['app.kubernetes.io/component'] ?? '*';
      for (const [dir, rules] of [
        ['in', spec.ingress ?? []],
        ['out', spec.egress ?? []],
      ] as const) {
        for (const r of rules) {
          for (const p of (dir === 'in' ? r.from : r.to) ?? []) {
            const ns = p.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'];
            if (p.namespaceSelector) {
              // Never a selector that could match another store namespace (e.g. by the store label).
              expect(Object.keys(p.namespaceSelector.matchLabels)).toEqual(['kubernetes.io/metadata.name']);
              expect(['urumi', 'kube-system']).toContain(ns);
            }
            if (p.ipBlock) {
              // Internet allows always exclude private ranges; only bootstrap gets the API CIDR.
              if (!p.ipBlock.except) expect(self).toBe('bootstrap');
              else expect(p.ipBlock.except).toContain('10.0.0.0/8');
            }
            const other = p.ipBlock
              ? p.ipBlock.except
                ? 'internet'
                : 'kube-api'
              : ns
                ? `${ns}/${JSON.stringify(p.podSelector)}`
                : p.podSelector?.matchLabels?.['app.kubernetes.io/component'];
            const ports = (r.ports ?? []).map((x) => x.port).join('+');
            flows.push(dir === 'in' ? `${other} -> ${self}:${ports}` : `${self} -> ${other}:${ports}`);
          }
        }
      }
    }
    expect(flows.sort()).toEqual(
      [
        '* -> kube-system/{"matchLabels":{"k8s-app":"kube-dns"}}:53+53',
        'kube-system/{"matchLabels":{"app.kubernetes.io/name":"traefik"}} -> wordpress:80',
        'woo-mcp -> wordpress:80',
        'bootstrap -> wordpress:80',
        'wordpress -> mariadb:3306',
        'wordpress -> internet:80+443',
        'wordpress -> mariadb:3306',
        'bootstrap -> mariadb:3306',
        'urumi/{"matchLabels":{"app.kubernetes.io/instance":"urumi"},"matchExpressions":[{"key":"app.kubernetes.io/component","operator":"In","values":["gateway"]}]} -> woo-mcp:8080',
        'woo-mcp -> wordpress:80',
        'bootstrap -> mariadb:3306',
        'bootstrap -> wordpress:80',
        'bootstrap -> kube-api:443+6443',
        'bootstrap -> internet:80+443',
      ].sort(),
    );
  });

  it('drops WordPress internet egress when the chart turns it off', () => {
    const off = buildStoreManifests(SPEC, { ...SETTINGS, wordpressInternetEgress: false });
    const wp = byKind(all(off), 'NetworkPolicy').find((n) => n.metadata.name === 'wordpress')!;
    expect(JSON.stringify(wp.spec)).not.toContain('0.0.0.0/0');
  });

  it('two stores never reference each other', () => {
    const other = all(buildStoreManifests({ ...SPEC, id: '99999999-2222-4333-8444-555555555555', slug: 'shop3' }, SETTINGS));
    expect(JSON.stringify(other)).not.toContain('shop2');
    expect(JSON.stringify(objs)).not.toContain('shop3');
  });

  it('hardens every pod: non-root, no capabilities, seccomp, no host namespaces, resources set', () => {
    const workloads = [...byKind(objs, 'StatefulSet'), ...byKind(objs, 'Deployment'), ...byKind(objs, 'Job')];
    expect(workloads.map((w) => w.metadata.name).sort()).toEqual(['bootstrap-g1', 'mariadb', 'woo-mcp', 'wordpress']);
    for (const w of workloads) {
      const pod = podSpecOf(w);
      expect(pod.automountServiceAccountToken, w.metadata.name).toBe(false);
      expect(pod.hostNetwork || pod.hostPID || pod.hostIPC).toBe(false);
      expect(pod.securityContext.runAsNonRoot).toBe(true);
      expect(pod.securityContext.runAsUser).toBeGreaterThan(0);
      expect(pod.securityContext.seccompProfile.type).toBe('RuntimeDefault');
      for (const c of [...pod.containers, ...(pod.initContainers ?? [])]) {
        expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
        expect(c.securityContext.privileged ?? false).toBe(false);
        expect(c.securityContext.capabilities).toEqual({ drop: ['ALL'] });
        expect(c.resources.requests.memory).toBeTruthy();
        expect(c.resources.limits.memory).toBeTruthy();
      }
      expect(JSON.stringify(pod.volumes ?? [])).not.toContain('hostPath');
    }
  });

  it('gives an API token only to the bootstrap Job publish container', () => {
    const job = podSpecOf(m.job);
    expect(JSON.stringify(job.initContainers)).not.toContain('kube-api-access');
    expect(job.containers[0]!.volumeMounts!.map((v) => v.name)).toContain('kube-api-access');
    for (const w of [...byKind(objs, 'StatefulSet'), ...byKind(objs, 'Deployment')]) {
      expect(JSON.stringify(podSpecOf(w))).not.toContain('serviceAccountToken');
    }
  });

  it('binds only the two pre-existing ClusterRoles, to the gateway SA and the bootstrap SA', () => {
    expect(m.roleBindings).toHaveLength(2);
    const [gw, boot] = m.roleBindings as (StoreObject & {
      roleRef: { kind: string; name: string };
      subjects: { kind: string; name: string; namespace: string }[];
    })[];
    expect(gw!.roleRef).toMatchObject({ kind: 'ClusterRole', name: 'urumi-store-manager' });
    expect(gw!.subjects).toEqual([{ kind: 'ServiceAccount', name: 'urumi-gateway', namespace: 'urumi' }]);
    expect(boot!.roleRef).toMatchObject({ kind: 'ClusterRole', name: 'urumi-store-bootstrap' });
    expect(boot!.subjects).toEqual([{ kind: 'ServiceAccount', name: 'store-bootstrap', namespace: 'store-shop2' }]);
  });

  it('caps the namespace with a ResourceQuota and a LimitRange', () => {
    const q = byKind(objs, 'ResourceQuota')[0]!;
    expect((q.spec as { hard: Record<string, string> }).hard).toMatchObject({
      pods: '6',
      'requests.memory': '512Mi',
      'limits.memory': '1536Mi',
      persistentvolumeclaims: '2',
      'services.loadbalancers': '0',
      'services.nodeports': '0',
    });
    expect(byKind(objs, 'LimitRange')).toHaveLength(1);
  });

  it('the requests of all store pods fit in the quota', () => {
    const mi = (v: string) => (v.endsWith('Gi') ? parseFloat(v) * 1024 : parseFloat(v));
    const r = SETTINGS.resources;
    const steady = [r.mariadb, r.wordpress, r.wooMcp].reduce((a, x) => a + mi(x.requests.memory), 0);
    const job = Math.max(mi(r.wpCli.requests.memory), mi(r.kubectl.requests.memory));
    expect(steady + job).toBeLessThanOrEqual(mi(SETTINGS.quota['requests.memory']!));
    const lim = [r.mariadb, r.wordpress, r.wooMcp].reduce((a, x) => a + mi(x.limits.memory), 0);
    expect(lim + mi(r.wpCli.limits.memory)).toBeLessThanOrEqual(mi(SETTINGS.quota['limits.memory']!));
  });

  it('exposes the storefront on <slug>.<suffix> and wires WordPress to it', () => {
    const ing = byKind(objs, 'Ingress')[0]!;
    expect(JSON.stringify(ing.spec)).toContain('"host":"shop2.store.localtest.me"');
    expect(JSON.stringify(podSpecOf(byKind(objs, 'Deployment').find((d) => d.metadata.name === 'wordpress')!)))
      .toContain("define('WP_HOME', 'http://shop2.store.localtest.me');");
  });

  it('keeps secrets out of everything but the shared-secret Secret, and out of the hash', () => {
    const secrets = byKind(objs, 'Secret');
    expect(secrets.map((s) => s.metadata.name)).toEqual(['woo-mcp-shared']);
    const nonSecret = objs.filter((o) => o.kind !== 'Secret');
    expect(JSON.stringify(nonSecret)).not.toContain(SHARED);
    expect(JSON.stringify(nonSecret)).not.toContain(Buffer.from(SHARED).toString('base64'));
    const rotated = buildStoreManifests({ ...SPEC, sharedSecret: 'another-secret-value-0000000000000000' }, SETTINGS);
    expect(rotated.specHash).toBe(m.specHash);
    const renamed = buildStoreManifests({ ...SPEC, generation: 2 }, SETTINGS);
    expect(renamed.specHash).not.toBe(m.specHash);
    expect(renamed.job.metadata.name).toBe('bootstrap-g2');
  });

  it('generates random passwords into create-once Secrets', () => {
    const a = generatedSecrets(SPEC);
    const b = generatedSecrets(SPEC);
    expect(a.map((s) => s.metadata.name)).toEqual(['store-db', 'store-admin']);
    expect(JSON.stringify(a[0]!.data)).not.toBe(JSON.stringify(b[0]!.data));
    const pw = Buffer.from((a[0]!.data as Record<string, string>).MARIADB_PASSWORD!, 'base64').toString();
    expect(pw.length).toBeGreaterThanOrEqual(24);
  });

  it('names the only host the SSRF guard lets a store row reach', () => {
    expect(storeServiceHost('shop2')).toBe('woo-mcp.store-shop2.svc.cluster.local');
    expect(storeUpstreamUrl('shop2')).toBe('http://woo-mcp.store-shop2.svc.cluster.local/mcp');
  });
});

describe('store slug validation', () => {
  it.each(['shop2', 'ab', 'my-shop', 'a1234567890123456789'])('accepts %s', (s) => {
    expect(StoreSlugSchema.safeParse(s).success).toBe(true);
  });
  it.each([
    'a',
    '2shop',
    'Shop',
    'shop_2',
    'shop-',
    '-shop',
    'shop.two',
    'a12345678901234567890',
    '',
    'gateway',
    'woo',
    'everything',
    'default',
    'store',
    'kube',
  ])('rejects %s', (s) => {
    expect(StoreSlugSchema.safeParse(s).success).toBe(false);
  });
  it('reserves the built-in upstreams and platform names', () => {
    for (const s of ['gateway', 'woo', 'everything', 'default']) expect(RESERVED_STORE_SLUGS).toContain(s);
  });
  it('requires a name and an admin email, nothing else', () => {
    const ok = { slug: 'shop2', name: 'Shop', adminEmail: 'A@Example.com' };
    expect(CreateStoreRequestSchema.parse(ok).adminEmail).toBe('a@example.com');
    expect(CreateStoreRequestSchema.safeParse({ ...ok, adminEmail: 'nope' }).success).toBe(false);
    expect(CreateStoreRequestSchema.safeParse({ ...ok, password: 'x' }).success).toBe(false);
  });
});

describe('store Kubernetes client guard', () => {
  it('refuses any namespace that is not a store namespace', () => {
    for (const ns of ['urumi', 'kube-system', 'default', 'urumi-hosted', 'store-', 'store-UP', 'xstore-a1']) {
      expect(() => assertStoreNamespace(ns)).toThrow(KubeError);
    }
    expect(assertStoreNamespace('store-shop2')).toBe('store-shop2');
    expect(() => collectionPath('Secret', 'urumi')).toThrow(KubeError);
    expect(collectionPath('Secret', 'store-shop2')).toBe('/api/v1/namespaces/store-shop2/secrets');
  });
  it('refuses to write an unlabelled or foreign Namespace', () => {
    const m = buildStoreManifests(SPEC, SETTINGS);
    expect(() => checkWritable(m.namespace)).not.toThrow();
    expect(() =>
      checkWritable({ ...m.namespace, metadata: { ...m.namespace.metadata, labels: {} } }),
    ).toThrow(/store label/);
    expect(() =>
      checkWritable({ ...m.namespace, metadata: { ...m.namespace.metadata, name: 'kube-system' } }),
    ).toThrow(KubeError);
    expect(() =>
      checkWritable({ ...m.apply[0]!, metadata: { ...m.apply[0]!.metadata, namespace: 'urumi' } }),
    ).toThrow(KubeError);
  });
});

describe('store phase state machine', () => {
  const t0 = new Date('2026-10-26T10:00:00Z');
  const ready = { status: { readyReplicas: 1, availableReplicas: 1 } };
  const ok = (name: string) => ({ metadata: { name }, ...ready });
  const base: StoreObservation = {
    desiredState: 'present',
    current: 'provisioning',
    namespace: { metadata: { name: 'store-shop2' } },
    mariadb: ok('mariadb'),
    wordpress: ok('wordpress'),
    job: { metadata: { name: 'bootstrap-g1' }, status: { succeeded: 1 } },
    wooMcp: ok('woo-mcp'),
    pods: [],
    upstream: { enabled: true, status: 'up', last_error: null },
    provisionStartedAt: t0,
    now: new Date(t0.getTime() + 60_000),
    timeoutMs: 10 * 60_000,
  };
  const pod = (component: string, status: object) => ({
    metadata: { name: `${component}-x`, labels: { 'app.kubernetes.io/component': component } },
    status,
  });

  it('walks the provisioning steps in order', () => {
    const steps = [
      { namespace: null },
      { mariadb: null },
      { wordpress: { metadata: { name: 'wordpress' }, status: { availableReplicas: 0 } } },
      { job: { metadata: { name: 'bootstrap-g1' }, status: { active: 1 } } },
      { wooMcp: null },
      { upstream: { enabled: false, status: 'unknown' as const, last_error: null } },
      { upstream: { enabled: true, status: 'down' as const, last_error: 'HTTP 401' } },
    ];
    const reasons = steps.map((s) => deriveStorePhase({ ...base, ...s }));
    expect(reasons.map((r) => r.phase)).toEqual(Array(7).fill('provisioning'));
    expect(reasons.map((r) => r.reason)).toEqual([
      'Creating the namespace',
      'Starting MariaDB',
      'Starting WordPress',
      'Installing WordPress and WooCommerce (bootstrap job)',
      'Starting woo-mcp',
      'Registering the upstream',
      'Waiting for woo-mcp to answer MCP (HTTP 401)',
    ]);
    expect(deriveStorePhase(base)).toEqual({ phase: 'ready', reason: null });
  });

  it('shows why a pod is pending (e.g. an unbound PVC)', () => {
    const r = deriveStorePhase({
      ...base,
      mariadb: { metadata: { name: 'mariadb' }, status: { readyReplicas: 0 } },
      pods: [
        pod('mariadb', {
          conditions: [
            { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'pod has unbound immediate PersistentVolumeClaims' },
          ],
        }),
      ],
    });
    expect(r).toEqual({
      phase: 'provisioning',
      reason: 'Starting MariaDB (Unschedulable: pod has unbound immediate PersistentVolumeClaims)',
    });
  });

  it('fails at once on ImagePullBackOff, a failed bootstrap Job or a ReplicaFailure', () => {
    expect(
      deriveStorePhase({
        ...base,
        wooMcp: null,
        pods: [pod('woo-mcp', { containerStatuses: [{ name: 'woo-mcp', state: { waiting: { reason: 'ImagePullBackOff' } } }] })],
      }),
    ).toEqual({ phase: 'failed', reason: 'woo-mcp: ImagePullBackOff: the image could not be pulled' });
    const jobFailed = deriveStorePhase({
      ...base,
      job: {
        metadata: { name: 'bootstrap-g1' },
        status: { failed: 3, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] },
      },
    });
    expect(jobFailed.phase).toBe('failed');
    expect(jobFailed.reason).toMatch(/^Bootstrap job failed \(BackoffLimitExceeded: .*kubectl logs job\/bootstrap-g1$/);
    const quota = deriveStorePhase({
      ...base,
      wordpress: {
        metadata: { name: 'wordpress' },
        status: { conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'exceeded quota: store-quota' }] },
      },
    });
    expect(quota).toEqual({ phase: 'failed', reason: 'wordpress: FailedCreate: exceeded quota: store-quota' });
  });

  it('tolerates a few crash restarts, fails after three', () => {
    const crash = (restartCount: number) =>
      deriveStorePhase({
        ...base,
        mariadb: { metadata: { name: 'mariadb' }, status: { readyReplicas: 0 } },
        pods: [
          pod('mariadb', {
            containerStatuses: [{ name: 'mariadb', restartCount, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error', exitCode: 1 } } }],
          }),
        ],
      });
    expect(crash(1).phase).toBe('provisioning');
    expect(crash(3)).toEqual({
      phase: 'failed',
      reason: 'mariadb: CrashLoopBackOff (container mariadb, last exit Error code 1)',
    });
  });

  it('times out a stuck store with the step it was stuck on', () => {
    const r = deriveStorePhase({
      ...base,
      job: { metadata: { name: 'bootstrap-g1' }, status: { active: 1 } },
      now: new Date(t0.getTime() + 11 * 60_000),
    });
    expect(r).toEqual({
      phase: 'failed',
      reason: 'Timed out after 10 min: Installing WordPress and WooCommerce (bootstrap job)',
    });
  });

  it('keeps ready sticky (later trouble is the upstream status) and reports deleting', () => {
    expect(
      deriveStorePhase({ ...base, current: 'ready', wooMcp: null, upstream: { enabled: true, status: 'down', last_error: 'Connection refused' } }),
    ).toEqual({ phase: 'ready', reason: 'woo-mcp unreachable: Connection refused' });
    expect(deriveStorePhase({ ...base, desiredState: 'absent' }).phase).toBe('deleting');
    expect(deriveStorePhase({ ...base, desiredState: 'absent', namespace: null }).reason).toBe('Removing the upstream');
  });

  it('ignores pods that are being deleted', () => {
    const r = deriveStorePhase({
      ...base,
      pods: [
        {
          metadata: { name: 'old', deletionTimestamp: t0.toISOString(), labels: { 'app.kubernetes.io/component': 'woo-mcp' } },
          status: { containerStatuses: [{ name: 'woo-mcp', state: { waiting: { reason: 'ErrImagePull' } } }] },
        },
      ],
    });
    expect(r.phase).toBe('ready');
  });
});
