// Kubernetes objects for one store (ADR 015), all in the namespace `store-<slug>`. Pure: the
// provisioner applies what this returns; unit tests assert isolation (default deny, no peer in
// another store namespace), hardening (non-root, no capabilities, RuntimeDefault seccomp, no
// service account token except the bootstrap Job's publish container) and the quota.
//
// The admin chooses only the slug, display name and admin email. Everything else is fixed here or
// comes from the chart (StoreSettings). Generated passwords are NOT part of the applied set: the
// provisioner creates those Secrets once (create-if-absent) and never reads or rewrites them, so a
// restarted gateway cannot rotate a database password under a running MariaDB.
import { createHash, randomBytes } from 'node:crypto';
import type { StoreSettings } from './settings.js';
import {
  ANNOTATION_SPEC_HASH,
  bootstrapJobName,
  LABEL_GENERATION,
  LABEL_STORE,
  LABEL_STORE_ID,
  LABEL_STORE_SLUG,
  MANAGED_BY,
  N,
  storeNamespace,
} from './names.js';

export type StoreKind =
  | 'Namespace'
  | 'ResourceQuota'
  | 'LimitRange'
  | 'NetworkPolicy'
  | 'ServiceAccount'
  | 'RoleBinding'
  | 'ConfigMap'
  | 'Secret'
  | 'Service'
  | 'PersistentVolumeClaim'
  | 'StatefulSet'
  | 'Deployment'
  | 'Job'
  | 'Ingress';

export interface StoreObject {
  apiVersion: string;
  kind: StoreKind;
  metadata: {
    name: string;
    namespace?: string;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
  };
  [k: string]: unknown;
}

export interface StoreSpec {
  id: string;
  slug: string;
  name: string;
  adminEmail: string;
  generation: number;
  /** Plaintext woo-mcp shared secret (from the sealed upstream credential); only in its Secret. */
  sharedSecret: string;
  /** Bootstrap scripts (charts/platform/files/bootstrap), file name -> content. */
  scripts: Record<string, string>;
}

export interface StoreManifests {
  namespace: StoreObject;
  /** Created with POST (roleRef is immutable; the gateway has `create` + `bind` only). */
  roleBindings: StoreObject[];
  /** Server-side applied, in order (each before what depends on it). */
  apply: StoreObject[];
  /** Created only once the bootstrap Job succeeded (it reads the Secret the Job writes). */
  wooMcp: StoreObject;
  /** Created with POST, never re-applied (a Job's template is immutable). */
  job: StoreObject;
  specHash: string;
}

export const storefrontHost = (slug: string, s: Pick<StoreSettings, 'domainSuffix'>) =>
  `${slug}.${s.domainSuffix}`;
export const storefrontUrl = (slug: string, s: Pick<StoreSettings, 'domainSuffix' | 'scheme'>) =>
  `${s.scheme}://${storefrontHost(slug, s)}`;
const wordpressUrl = (slug: string) =>
  `http://${N.wordpress}.${storeNamespace(slug)}.svc.cluster.local`;

export function storeLabels(spec: Pick<StoreSpec, 'id' | 'slug'>): Record<string, string> {
  return {
    'app.kubernetes.io/part-of': 'urumi-store',
    'app.kubernetes.io/managed-by': MANAGED_BY,
    [LABEL_STORE]: 'true',
    [LABEL_STORE_ID]: spec.id,
    [LABEL_STORE_SLUG]: spec.slug,
  };
}

const component = (c: string) => ({ 'app.kubernetes.io/component': c });

/** Pod security of every container (Pod Security `restricted` is enforced on the namespace). */
const containerSecurity = (readOnlyRoot: boolean) => ({
  allowPrivilegeEscalation: false,
  privileged: false,
  ...(readOnlyRoot ? { readOnlyRootFilesystem: true } : {}),
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
});
const podSecurity = (uid: number, extra: Record<string, unknown> = {}) => ({
  runAsNonRoot: true,
  runAsUser: uid,
  runAsGroup: uid,
  fsGroup: uid,
  fsGroupChangePolicy: 'OnRootMismatch',
  seccompProfile: { type: 'RuntimeDefault' },
  ...extra,
});
const podDefaults = {
  automountServiceAccountToken: false,
  enableServiceLinks: false,
  hostNetwork: false,
  hostPID: false,
  hostIPC: false,
};

const secretEnv = (name: string, secret: string, key = name) => ({
  name,
  valueFrom: { secretKeyRef: { name: secret, key } },
});

/** Env the official image's wp-config.php reads; shared by WordPress and the bootstrap Job. */
function wordpressEnv(spec: StoreSpec, s: StoreSettings) {
  const url = storefrontUrl(spec.slug, s);
  return [
    { name: 'WORDPRESS_DB_HOST', value: `${N.mariadb}:3306` },
    { name: 'WORDPRESS_DB_NAME', value: 'wordpress' },
    { name: 'WORDPRESS_DB_USER', value: 'wordpress' },
    secretEnv('WORDPRESS_DB_PASSWORD', N.dbSecret, 'MARIADB_PASSWORD'),
    {
      name: 'WORDPRESS_CONFIG_EXTRA',
      value: [
        `define('WP_HOME', '${url}');`,
        `define('WP_SITEURL', '${url}');`,
        `define('WP_ENVIRONMENT_TYPE', '${s.environmentType}');`,
        '',
      ].join('\n'),
    },
  ];
}

/** Network peers. Same-namespace peers are bare podSelectors: they can never match another store. */
const peer = (c: string) => ({ podSelector: { matchLabels: component(c) } });
const nsPeer = (ns: string, podSelector: Record<string, unknown>) => ({
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ns } },
  podSelector,
});
const tcp = (...p: number[]) => p.map((port) => ({ protocol: 'TCP', port }));

function networkPolicies(spec: StoreSpec, s: StoreSettings, ns: string, labels: Record<string, string>) {
  const net = s.network;
  const internet = {
    to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [...net.internet.except] } }],
    ports: tcp(...net.internet.ports),
  };
  const np = (name: string, spec_: Record<string, unknown>): StoreObject => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: ns, labels: { ...labels } },
    spec: spec_,
  });
  const sel = (c: string) => ({ matchLabels: component(c) });
  return [
    np('default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
    np('allow-dns', {
      podSelector: {},
      policyTypes: ['Egress'],
      egress: [
        {
          to: [nsPeer(net.dnsNamespace, { matchLabels: { ...net.dnsPodLabels } })],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    }),
    np('wordpress', {
      podSelector: sel('wordpress'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [nsPeer(net.ingressNamespace, { matchLabels: { ...net.ingressPodLabels } })],
          ports: tcp(80),
        },
        { from: [peer('woo-mcp'), peer('bootstrap')], ports: tcp(80) },
      ],
      egress: [
        { to: [peer('mariadb')], ports: tcp(3306) },
        ...(s.wordpressInternetEgress ? [internet] : []),
      ],
    }),
    np('mariadb', {
      podSelector: sel('mariadb'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [peer('wordpress'), peer('bootstrap')], ports: tcp(3306) }],
      egress: [],
    }),
    np('woo-mcp', {
      podSelector: sel('woo-mcp'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [nsPeer(net.gatewayNamespace, structuredClone(net.gatewayPodSelector))],
          ports: tcp(8080),
        },
      ],
      egress: [{ to: [peer('wordpress')], ports: tcp(80) }],
    }),
    np('bootstrap', {
      podSelector: sel('bootstrap'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        { to: [peer('mariadb')], ports: tcp(3306) },
        { to: [peer('wordpress')], ports: tcp(80) },
        // kubectl in the publish container writes the woo-api Secret (its Role allows nothing else).
        { to: [{ ipBlock: { cidr: net.kubeApi.cidr } }], ports: tcp(...net.kubeApi.ports) },
        // WooCommerce download from wordpress.org.
        internet,
      ],
    }),
  ];
}

export function buildStoreManifests(spec: StoreSpec, s: StoreSettings): StoreManifests {
  const ns = storeNamespace(spec.slug);
  const labels = storeLabels(spec);
  const meta = (name: string, c?: string, extra: Record<string, string> = {}) => ({
    name,
    namespace: ns,
    labels: { ...labels, ...(c ? component(c) : {}), ...extra },
  });
  const url = storefrontUrl(spec.slug, s);
  const host = storefrontHost(spec.slug, s);
  const r = s.resources;

  const namespace: StoreObject = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: ns,
      labels: {
        ...labels,
        // Enforced by the API server for every pod, whoever creates it.
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/audit': 'restricted',
        'pod-security.kubernetes.io/warn': 'restricted',
      },
      annotations: { 'urumi.io/store-name': spec.name.slice(0, 100) },
    },
  };

  const roleBindings: StoreObject[] = [
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta(N.gatewayBinding),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: s.clusterRoles.manager },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: s.gatewayServiceAccount.name,
          namespace: s.gatewayServiceAccount.namespace,
        },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta(N.bootstrapBinding, 'bootstrap'),
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: s.clusterRoles.bootstrap,
      },
      subjects: [{ kind: 'ServiceAccount', name: N.bootstrapSa, namespace: ns }],
    },
  ];

  const quota: StoreObject = {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: meta(N.quota),
    spec: { hard: { ...s.quota } },
  };
  const limitRange: StoreObject = {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: meta(N.limits),
    spec: {
      limits: [
        {
          type: 'Container',
          default: { cpu: '200m', memory: '128Mi' },
          defaultRequest: { cpu: '10m', memory: '32Mi' },
          max: { cpu: '1', memory: '768Mi' },
        },
        { type: 'PersistentVolumeClaim', max: { storage: '5Gi' } },
      ],
    },
  };

  const bootstrapSa: StoreObject = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: meta(N.bootstrapSa, 'bootstrap'),
    automountServiceAccountToken: false,
  };
  const scripts: StoreObject = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: meta(N.bootstrapScripts, 'bootstrap'),
    data: { ...spec.scripts },
  };
  const shared: StoreObject = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: meta(N.sharedSecret, 'woo-mcp'),
    type: 'Opaque',
    data: { WOO_MCP_SHARED_SECRET: Buffer.from(spec.sharedSecret, 'utf8').toString('base64') },
  };

  const service = (name: string, c: string, port: number, targetPort: number | string) => ({
    apiVersion: 'v1',
    kind: 'Service' as const,
    metadata: meta(name, c),
    spec: {
      type: 'ClusterIP',
      selector: component(c),
      ports: [{ name: 'tcp', port, targetPort, protocol: 'TCP' }],
    },
  });

  const pvc = (name: string, size: string) => ({
    accessModes: ['ReadWriteOnce'],
    ...(s.storageClass ? { storageClassName: s.storageClass } : {}),
    resources: { requests: { storage: size } },
  });

  const healthcheck = ['healthcheck.sh', '--connect', '--innodb_initialized'];
  const mariadb: StoreObject = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta(N.mariadb, 'mariadb'),
    spec: {
      replicas: 1,
      serviceName: N.mariadb,
      selector: { matchLabels: component('mariadb') },
      template: {
        metadata: { labels: { ...labels, ...component('mariadb') } },
        spec: {
          ...podDefaults,
          terminationGracePeriodSeconds: 30,
          securityContext: podSecurity(999),
          containers: [
            {
              name: 'mariadb',
              image: s.images.mariadb.image,
              imagePullPolicy: s.images.mariadb.pullPolicy,
              // Small footprint: one small store per namespace on an 8 GB laptop.
              args: [
                '--innodb-buffer-pool-size=32M',
                '--performance-schema=OFF',
                '--max-connections=40',
              ],
              securityContext: containerSecurity(false),
              ports: [{ name: 'mysql', containerPort: 3306 }],
              env: [
                { name: 'MARIADB_DATABASE', value: 'wordpress' },
                { name: 'MARIADB_USER', value: 'wordpress' },
                secretEnv('MARIADB_PASSWORD', N.dbSecret),
                secretEnv('MARIADB_ROOT_PASSWORD', N.dbSecret),
                { name: 'MARIADB_AUTO_UPGRADE', value: '1' },
              ],
              startupProbe: {
                exec: { command: healthcheck },
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 60,
              },
              readinessProbe: {
                exec: { command: healthcheck },
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              livenessProbe: {
                exec: { command: healthcheck },
                periodSeconds: 20,
                timeoutSeconds: 5,
                failureThreshold: 6,
              },
              resources: structuredClone(r.mariadb),
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/mysql' }],
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: 'data', labels: { ...labels, ...component('mariadb') } },
          spec: pvc('data', s.storage.mariadb),
        },
      ],
    },
  };

  const docroot: StoreObject = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: meta(N.docroot, 'wordpress'),
    spec: pvc(N.docroot, s.storage.wordpress),
  };

  const blank = { httpGet: { path: '/wp-includes/images/blank.gif', port: 'http' } };
  const wordpress: StoreObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(N.wordpress, 'wordpress'),
    spec: {
      replicas: 1,
      revisionHistoryLimit: 2,
      // ReadWriteOnce docroot: the old pod must stop before the new one mounts it.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: component('wordpress') },
      template: {
        metadata: { labels: { ...labels, ...component('wordpress') } },
        spec: {
          ...podDefaults,
          // Apache as www-data (33) from the start; port 80 via the namespaced "safe" sysctl.
          securityContext: podSecurity(33, {
            sysctls: [{ name: 'net.ipv4.ip_unprivileged_port_start', value: '0' }],
          }),
          containers: [
            {
              name: 'wordpress',
              image: s.images.wordpress.image,
              imagePullPolicy: s.images.wordpress.pullPolicy,
              securityContext: containerSecurity(false),
              ports: [{ name: 'http', containerPort: 80 }],
              env: wordpressEnv(spec, s),
              startupProbe: { ...blank, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
              readinessProbe: { ...blank, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
              livenessProbe: { ...blank, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
              resources: structuredClone(r.wordpress),
              volumeMounts: [{ name: 'docroot', mountPath: '/var/www/html' }],
            },
          ],
          volumes: [{ name: 'docroot', persistentVolumeClaim: { claimName: N.docroot } }],
        },
      },
    },
  };

  const jobName = bootstrapJobName(spec.generation);
  const gen = { [LABEL_GENERATION]: String(spec.generation) };
  const job: StoreObject = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: meta(jobName, 'bootstrap', gen),
    spec: {
      backoffLimit: 2,
      activeDeadlineSeconds: 900,
      template: {
        metadata: { labels: { ...labels, ...component('bootstrap'), ...gen } },
        spec: {
          ...podDefaults,
          restartPolicy: 'Never',
          serviceAccountName: N.bootstrapSa,
          securityContext: podSecurity(33),
          initContainers: [
            {
              name: 'wp',
              image: s.images.wpCli.image,
              imagePullPolicy: s.images.wpCli.pullPolicy,
              command: ['bash', '/scripts/bootstrap.sh'],
              securityContext: containerSecurity(true),
              env: [
                ...wordpressEnv(spec, s),
                { name: 'HOME', value: '/tmp' },
                { name: 'WP_CLI_CONFIG_PATH', value: '/scripts/wp-cli.yml' },
                { name: 'WP_CLI_CACHE_DIR', value: '/tmp/wp-cli-cache' },
                { name: 'STORE_URL', value: url },
                { name: 'STORE_TITLE', value: spec.name },
                { name: 'WOO_VERSION', value: s.woocommerce.version },
                { name: 'WOO_CURRENCY', value: s.woocommerce.currency },
                { name: 'WOO_DEFAULT_COUNTRY', value: s.woocommerce.defaultCountry },
                { name: 'WOO_URL', value: wordpressUrl(spec.slug) },
                { name: 'WOO_USER', value: s.apiUser },
                { name: 'WOO_USER_EMAIL', value: `${s.apiUser}@${host}` },
                { name: 'WP_ENVIRONMENT_TYPE', value: s.environmentType },
                secretEnv('WP_ADMIN_USER', N.adminSecret),
                secretEnv('WP_ADMIN_PASSWORD', N.adminSecret),
                secretEnv('WP_ADMIN_EMAIL', N.adminSecret),
              ],
              resources: structuredClone(r.wpCli),
              volumeMounts: [
                { name: 'docroot', mountPath: '/var/www/html' },
                { name: 'scripts', mountPath: '/scripts', readOnly: true },
                { name: 'existing', mountPath: '/existing', readOnly: true },
                { name: 'shared', mountPath: '/shared' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          containers: [
            {
              name: 'publish',
              image: s.images.kubectl.image,
              imagePullPolicy: s.images.kubectl.pullPolicy,
              command: ['bash', '/scripts/publish-secret.sh'],
              securityContext: containerSecurity(true),
              env: [
                { name: 'HOME', value: '/tmp' },
                { name: 'SECRET_NAME', value: N.apiSecret },
                { name: 'WOO_URL', value: wordpressUrl(spec.slug) },
                { name: 'WOO_USER', value: s.apiUser },
                { name: 'WP_ENVIRONMENT_TYPE', value: s.environmentType },
                {
                  name: 'SECRET_LABELS',
                  value: `app.kubernetes.io/part-of=urumi-store,${LABEL_STORE_SLUG}=${spec.slug},app.kubernetes.io/component=woo-api`,
                },
              ],
              resources: structuredClone(r.kubectl),
              volumeMounts: [
                { name: 'scripts', mountPath: '/scripts', readOnly: true },
                { name: 'existing', mountPath: '/existing', readOnly: true },
                { name: 'shared', mountPath: '/shared', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
                {
                  name: 'kube-api-access',
                  mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            { name: 'docroot', persistentVolumeClaim: { claimName: N.docroot } },
            { name: 'scripts', configMap: { name: N.bootstrapScripts } },
            {
              name: 'existing',
              secret: { secretName: N.apiSecret, optional: true, defaultMode: 0o440 },
            },
            { name: 'shared', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
            // The token only in the publish container (the WP-CLI one downloads code).
            {
              name: 'kube-api-access',
              projected: {
                defaultMode: 0o440,
                sources: [
                  { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
                  { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
                  {
                    downwardAPI: {
                      items: [{ path: 'namespace', fieldRef: { fieldPath: 'metadata.namespace' } }],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };

  const health = { httpGet: { path: '/healthz', port: 'http' } };
  const wooMcp: StoreObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(N.wooMcp, 'woo-mcp'),
    spec: {
      replicas: 1,
      revisionHistoryLimit: 2,
      selector: { matchLabels: component('woo-mcp') },
      template: {
        metadata: {
          labels: { ...labels, ...component('woo-mcp') },
          // A Retry (new generation) may have made a new Application Password: restart.
          annotations: { [LABEL_GENERATION]: String(spec.generation) },
        },
        spec: {
          ...podDefaults,
          securityContext: podSecurity(1000),
          containers: [
            {
              name: 'woo-mcp',
              image: s.images.wooMcp.image,
              imagePullPolicy: s.images.wooMcp.pullPolicy,
              securityContext: containerSecurity(true),
              ports: [{ name: 'http', containerPort: 8080 }],
              env: [
                { name: 'PORT', value: '8080' },
                secretEnv('WOO_MCP_SHARED_SECRET', N.sharedSecret),
                secretEnv('WOO_URL', N.apiSecret),
                secretEnv('WOO_USER', N.apiSecret),
                secretEnv('WOO_APP_PASSWORD', N.apiSecret),
                ...(s.forwardedProto ? [{ name: 'WOO_FORWARDED_PROTO', value: s.forwardedProto }] : []),
              ],
              readinessProbe: { ...health, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
              livenessProbe: { ...health, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 3 },
              resources: structuredClone(r.wooMcp),
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '16Mi' } }],
        },
      },
    },
  };

  const tls = s.scheme === 'https' && s.tlsSecretName;
  const ingress: StoreObject = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: meta(N.ingress, 'wordpress'),
    spec: {
      ingressClassName: s.ingressClassName,
      ...(tls ? { tls: [{ hosts: [host], secretName: s.tlsSecretName }] } : {}),
      rules: [
        {
          host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: N.wordpress, port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  };

  const apply: StoreObject[] = [
    quota,
    limitRange,
    ...networkPolicies(spec, s, ns, labels),
    bootstrapSa,
    scripts,
    shared,
    service(N.mariadb, 'mariadb', 3306, 'mysql'),
    service(N.wordpress, 'wordpress', 80, 'http'),
    service(N.wooMcp, 'woo-mcp', 80, 'http'),
    mariadb,
    docroot,
    wordpress,
    ingress,
  ];

  // The hash covers every object except Secret data (no secret is ever hashed or logged).
  const hashed = [namespace, ...roleBindings, ...apply, wooMcp, job].map((o) =>
    o.kind === 'Secret' ? { ...o, data: Object.keys((o.data as object) ?? {}) } : o,
  );
  const specHash = createHash('sha256').update(JSON.stringify(hashed)).digest('hex').slice(0, 16);
  namespace.metadata.annotations = { ...namespace.metadata.annotations, [ANNOTATION_SPEC_HASH]: specHash };
  return { namespace, roleBindings, apply, wooMcp, job, specHash };
}

/** Random secret material: URL-safe, no shell/SQL metacharacters. */
export const randomSecret = (bytes = 24) => randomBytes(bytes).toString('base64url');

/**
 * Secrets with generated passwords, created ONCE (POST; an existing one is kept as is). The gateway
 * has no `get` on Secrets: these values are never read back, returned or stored anywhere else.
 */
export function generatedSecrets(
  spec: Pick<StoreSpec, 'id' | 'slug' | 'adminEmail'>,
  rand: () => string = randomSecret,
): StoreObject[] {
  const ns = storeNamespace(spec.slug);
  const labels = storeLabels(spec);
  const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: N.dbSecret, namespace: ns, labels: { ...labels, ...component('mariadb') } },
      type: 'Opaque',
      data: { MARIADB_PASSWORD: b64(rand()), MARIADB_ROOT_PASSWORD: b64(rand()) },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: N.adminSecret, namespace: ns, labels: { ...labels, ...component('bootstrap') } },
      type: 'Opaque',
      data: {
        WP_ADMIN_USER: b64('admin'),
        WP_ADMIN_PASSWORD: b64(rand()),
        WP_ADMIN_EMAIL: b64(spec.adminEmail),
      },
    },
  ];
}
