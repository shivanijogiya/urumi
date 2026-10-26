// Names shared by the store provisioner, its manifests, the SSRF guard and the chart (ADR 015).
// Everything a store owns lives in ONE namespace, `store-<slug>`, so deleting the namespace deletes
// the store (PVCs included) and nothing else.

export const STORE_NAMESPACE_PREFIX = 'store-';
/** Namespace labels: the chart's NetworkPolicies and the admission policy key on these. */
export const LABEL_STORE = 'urumi.io/store';
export const LABEL_STORE_ID = 'urumi.io/store-id';
export const LABEL_STORE_SLUG = 'urumi.io/store-slug';
export const LABEL_GENERATION = 'urumi.io/store-generation';
export const ANNOTATION_SPEC_HASH = 'urumi.io/spec-hash';
export const MANAGED_BY = 'urumi-gateway';
export const FIELD_MANAGER = 'urumi-gateway';

/** Object names inside a store namespace (fixed: the namespace is the store). */
export const N = {
  mariadb: 'mariadb',
  wordpress: 'wordpress',
  wooMcp: 'woo-mcp',
  docroot: 'wordpress-docroot',
  bootstrapSa: 'store-bootstrap',
  bootstrapScripts: 'store-bootstrap-scripts',
  dbSecret: 'store-db',
  adminSecret: 'store-admin',
  sharedSecret: 'woo-mcp-shared',
  /** Written by the bootstrap Job (WOO_URL, WOO_USER, WOO_APP_PASSWORD); never by the gateway. */
  apiSecret: 'woo-api',
  ingress: 'storefront',
  quota: 'store-quota',
  limits: 'store-limits',
  gatewayBinding: 'urumi-gateway',
  bootstrapBinding: 'store-bootstrap',
} as const;

export const bootstrapJobName = (generation: number) => `bootstrap-g${generation}`;
export const storeNamespace = (slug: string) => `${STORE_NAMESPACE_PREFIX}${slug}`;
/** The only in-cluster host the SSRF guard lets a store's upstream row reach. */
export const storeServiceHost = (slug: string) =>
  `${N.wooMcp}.${storeNamespace(slug)}.svc.cluster.local`;
export const storeUpstreamUrl = (slug: string) => `http://${storeServiceHost(slug)}/mcp`;
/** Header the gateway sends to woo-mcp (same as the built-in store). */
export const SHARED_SECRET_HEADER = 'x-woo-mcp-secret';
/** Store namespaces only: what the client and the admission policy both enforce. */
export const STORE_NAMESPACE_RE = /^store-[a-z](?:[a-z0-9-]{0,18}[a-z0-9])$/;
