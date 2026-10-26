// Settings of the multi-store feature (ADR 015), rendered by the chart from `multiStore.*` into one
// JSON env var (MULTI_STORE_CONFIG) and validated here once at startup. Everything a store's
// Kubernetes objects need that is not per-store input: images, sizes, the bootstrap settings shared
// with the built-in store, and the NetworkPolicy peers (gateway, ingress controller, DNS, API).
import { z } from 'zod';

const quantity = z.string().regex(/^[0-9]+(?:\.[0-9]+)?(?:m|Ki|Mi|Gi|Ti|k|M|G)?$/);
const resources = z.strictObject({
  requests: z.strictObject({ cpu: quantity, memory: quantity }),
  limits: z.strictObject({ cpu: quantity, memory: quantity }),
});
const image = z.strictObject({
  image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,511}$/, 'must be an image reference'),
  pullPolicy: z.enum(['Always', 'IfNotPresent', 'Never']).default('IfNotPresent'),
});
const labelMap = z.record(
  z.string().regex(/^[A-Za-z0-9./_-]{1,253}$/),
  z.string().regex(/^[A-Za-z0-9._-]{0,63}$/),
);
const dnsName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const cidr = z.string().regex(/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}\/[0-9]{1,2}$/);
const ports = z.array(z.number().int().min(1).max(65535)).min(1).max(10);

export const StoreSettingsSchema = z.strictObject({
  /** Storefronts are <scheme>://<slug>.<domainSuffix>. */
  domainSuffix: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
  scheme: z.enum(['http', 'https']).default('http'),
  /** Existing wildcard TLS Secret name for https storefronts (copied by nobody: must exist per ns). */
  tlsSecretName: z.string().default(''),
  ingressClassName: dnsName.default('traefik'),
  /** A store not ready after this many minutes is Failed with the last reason. */
  provisionTimeoutMinutes: z.number().int().min(1).max(120).default(10),
  /** WP_ENVIRONMENT_TYPE (Application Passwords need HTTPS unless `local`). */
  environmentType: z.enum(['local', 'development', 'staging', 'production']).default('production'),
  /** WOO_FORWARDED_PROTO for woo-mcp; '' = not sent. */
  forwardedProto: z.enum(['', 'http', 'https']).default(''),
  woocommerce: z.strictObject({
    version: z.string().regex(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    defaultCountry: z.string().regex(/^[A-Z]{2}(?::[A-Z0-9]{1,3})?$/),
  }),
  apiUser: z.string().regex(/^[a-z0-9_-]{3,40}$/),
  images: z.strictObject({
    wordpress: image,
    mariadb: image,
    wpCli: image,
    kubectl: image,
    wooMcp: image,
  }),
  storageClass: z.string().default(''),
  storage: z.strictObject({ mariadb: quantity, wordpress: quantity }),
  resources: z.strictObject({
    mariadb: resources,
    wordpress: resources,
    wooMcp: resources,
    wpCli: resources,
    kubectl: resources,
  }),
  /** ResourceQuota `hard` of every store namespace. */
  quota: z.record(z.string().regex(/^[a-z.]{1,64}$/), quantity),
  wordpressInternetEgress: z.boolean().default(true),
  network: z.strictObject({
    gatewayNamespace: dnsName,
    gatewayPodSelector: z.strictObject({
      matchLabels: labelMap.optional(),
      matchExpressions: z
        .array(
          z.strictObject({
            key: z.string(),
            operator: z.enum(['In', 'NotIn', 'Exists', 'DoesNotExist']),
            values: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    }),
    ingressNamespace: dnsName,
    ingressPodLabels: labelMap,
    dnsNamespace: dnsName,
    dnsPodLabels: labelMap,
    kubeApi: z.strictObject({ cidr, ports }),
    internet: z.strictObject({ ports, except: z.array(cidr) }),
  }),
  /** Pre-existing ClusterRoles (chart) the gateway may bind in store namespaces only. */
  clusterRoles: z.strictObject({ manager: z.string().min(1), bootstrap: z.string().min(1) }),
  gatewayServiceAccount: z.strictObject({ name: dnsName, namespace: dnsName }),
});
export type StoreSettings = z.infer<typeof StoreSettingsSchema>;
