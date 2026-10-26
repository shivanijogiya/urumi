// Environment config, validated once at startup. Errors name the variable, never its value.
import { hostname } from 'node:os';
import { MIGRATIONS_DIR } from '@urumi/contracts/db';
import { z } from 'zod';
import { DEFAULT_CHAT_MODEL } from './chat/service.js';
import { parseRedirectSchemes } from './oauth/redirect.js';
import { StoreSettingsSchema, type StoreSettings } from './stores/settings.js';

/** Optional string; an empty value counts as unset. */
const optional = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ALLOWED_HOST_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\*\\.${LABEL}(?:\\.${LABEL})+)$`);

const count = (fallback: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(1_000_000).default(fallback),
  );

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const EnvSchema = z.object({
  PORT: port(8080),
  DATABASE_URL: optional(),
  PGHOST: optional(),
  PGPORT: port(5432),
  PGUSER: optional(),
  PGPASSWORD: optional(),
  PGDATABASE: optional(),
  MIGRATIONS_DIR: optional(),
  SEED_ADMIN_EMAIL: z.email().transform((e) => e.toLowerCase()),
  SEED_ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters'),
  GATEWAY_ENC_KEY: z
    .string()
    .refine(
      (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32,
      'must be base64 of exactly 32 bytes',
    ),
  // No GATEWAY_SESSION_SECRET: sessions are random tokens stored hashed in Postgres (nothing is
  // signed). A leftover value in the environment or the Secret is ignored.
  // Browser origin of the dashboard; state-changing /api requests from any other Origin get 403.
  PUBLIC_ORIGIN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .url({ protocol: /^https?$/ })
      .default('http://app.localtest.me')
      .refine((v) => {
        // zod 4 runs refinements after a failed format check too.
        if (!URL.canParse(v)) return false;
        const u = new URL(v);
        return u.pathname === '/' && !u.search && !u.hash && !u.username;
      }, 'must be an http(s) origin without a path')
      .transform((v) => new URL(v).origin),
  ),
  // Secure session cookie; on behind TLS (prod), off for plain-HTTP localtest.me.
  COOKIE_SECURE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  // Client IP from X-Forwarded-For (per-IP login throttle). In-cluster the gateway sits behind
  // Traefik, which replaces any client-sent X-Forwarded-For. `true`, `false`, or a hop count.
  TRUST_PROXY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .default('true')
      .refine((v) => /^(true|false|[0-9]{1,2})$/.test(v), 'must be true, false, or a hop count')
      .transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v))),
  ),
  // Hosts exempt from the SSRF address check (in-cluster upstreams): comma-separated exact
  // hostnames or `*.suffix`, e.g. `*.urumi.svc.cluster.local`. Wildcards need a suffix of at least
  // two labels, so `*` or `*.com` cannot switch the guard off.
  UPSTREAM_ALLOWED_HOSTS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
          .filter(Boolean),
      )
      .refine(
        (hosts) => hosts.every((h) => ALLOWED_HOST_RE.test(h)),
        'must be comma-separated hostnames or *.suffix (suffix of two or more labels)',
      ),
  ),
  // Chat agent (#19). Unset key: /api/chat answers 503, everything else runs.
  ANTHROPIC_API_KEY: optional(),
  CHAT_MODEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .default(DEFAULT_CHAT_MODEL)
      .refine((v) => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/.test(v), 'must be a model id'),
  ),
  // Canary (#23): x-urumi-track response header, and fault injection for the forced-bad-release
  // demo only (see src/http/canary.ts). All unset in a normal install.
  TRACK: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,19}$/, 'must be a lowercase label such as stable or canary')
      .optional(),
  ),
  FAULT_INJECT_ERROR_RATE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().min(0).max(1).default(0),
  ),
  // Below the 15 s tool-call timeout, so an injected delay never looks like a hang.
  // /mcp rate limits (ADR 010): token buckets per API key and per user, shared by all replicas
  // through Postgres. perMinute = sustained rate, burst = bucket size; 0 turns that limit off.
  MCP_RATE_LIMIT_KEY_PER_MIN: count(120),
  MCP_RATE_LIMIT_KEY_BURST: count(60),
  MCP_RATE_LIMIT_USER_PER_MIN: count(240),
  MCP_RATE_LIMIT_USER_BURST: count(120),
  // OAuth (ADR 013): extra private-use redirect URI schemes MCP clients may register, comma-
  // separated (e.g. `cursor`). https and loopback http are always allowed; nothing else by default.
  OAUTH_REDIRECT_SCHEMES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .default('')
      .refine((v) => {
        try {
          parseRedirectSchemes(v);
          return true;
        } catch {
          return false;
        }
      }, 'must be comma-separated URI schemes (not http, https, javascript, data, file)')
      .transform(parseRedirectSchemes),
  ),
  // Chat discovery mode (ADR 012): above this many permitted tools the model gets only
  // gateway__search_tools + gateway__call_tool. 0 = always discovery.
  CHAT_DISCOVERY_THRESHOLD: count(40),
  // Internal Prometheus listener (ADR 011): GET /metrics only, never routed by the Ingress.
  // 0 turns it off.
  METRICS_PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(65535).default(9464),
  ),
  // Hosted MCP servers (ADR 014): the gateway runs admin-added container images in HOSTED_NAMESPACE
  // through the Kubernetes API (in-pod ServiceAccount token). Off unless HOSTED_ENABLED=true.
  HOSTED_ENABLED: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  HOSTED_NAMESPACE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'must be a namespace name')
      .default('urumi-hosted'),
  ),
  HOSTED_SERVICE_ACCOUNT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'must be a ServiceAccount name')
      .default('hosted-mcp'),
  ),
  // Comma-separated registry/repository prefixes, each ending in '/' (added if missing).
  HOSTED_ALLOWED_IMAGES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
          .map((p) => (p.endsWith('/') ? p : `${p}/`)),
      )
      .refine(
        (prefixes) =>
          prefixes.every((p) =>
            /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/(?:[a-z0-9._-]+\/)*$/.test(p),
          ),
        'must be comma-separated registry[/path]/ prefixes',
      ),
  ),
  HOSTED_REQUIRE_DIGEST: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  HOSTED_MAX_SERVERS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(100).default(5),
  ),
  // Multiple stores (ADR 015): the gateway provisions extra WooCommerce stores, one namespace each,
  // through the Kubernetes API. MULTI_STORE_CONFIG is the chart's `multiStore` settings as JSON.
  MULTI_STORE_ENABLED: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  MULTI_STORE_CONFIG: optional(),
  MULTI_STORE_MAX_STORES: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(50).default(3),
  ),
  MULTI_STORE_SCRIPTS_DIR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]{1,200}$/, 'must be an absolute path')
      .default('/etc/urumi/store-bootstrap'),
  ),
  // The chart's own store (upstream `woo`), shown as built-in on the Stores page.
  BUILTIN_STORE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  BUILTIN_STORE_NAME: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().max(100).default('Urumi Store'),
  ),
  KUBERNETES_SERVICE_HOST: optional(),
  KUBERNETES_SERVICE_PORT: port(443),
  // This replica's name for the health-loop lease (Kubernetes: the pod name). Default: hostname.
  POD_NAME: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/, 'must be a hostname-like name')
      .optional(),
  ),
  FAULT_INJECT_LATENCY_MS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(15_000).default(0),
  ),
});

/** Needed unless DATABASE_URL is set. Checked outside zod so they are reported with other errors. */
const PG_VARS = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;

export type DbConfig =
  | { connectionString: string }
  | { host: string; port: number; user: string; password: string; database: string };

export interface Config {
  port: number;
  db: DbConfig;
  migrationsDir: string;
  seedAdmin: { email: string; password: string };
  /** AES-256-GCM key for upstream credentials. */
  encKey: Buffer;
  /** e.g. `http://app.localtest.me` (no trailing slash). */
  publicOrigin: string;
  cookieSecure: boolean;
  /** Fastify trustProxy. */
  trustProxy: boolean | number;
  /** Lowercase hostnames or `*.suffix`, no trailing dot. */
  upstreamAllowedHosts: string[];
  /** ANTHROPIC_API_KEY, or null when chat is not configured. Never logged. */
  anthropicApiKey: string | null;
  chatModel: string;
  /** TRACK: value of the x-urumi-track response header, or null (no header). */
  track: string | null;
  /** Fault injection (forced-bad-release demo). Zero = off. */
  faultInject: { errorRate: number; latencyMs: number };
  /** /mcp token buckets; a limit with perMinute or burst 0 is off. */
  mcpRateLimits: {
    perKey: { perMinute: number; burst: number };
    perUser: { perMinute: number; burst: number };
  };
  /** Holder name for the health lease. */
  podName: string;
  /** Internal /metrics port; 0 = off. */
  metricsPort: number;
  /** Chat switches to discovery mode above this many tools. */
  chatDiscoveryThreshold: number;
  /** OAUTH_REDIRECT_SCHEMES (lowercase). */
  oauthRedirectSchemes: string[];
  /** Hosted MCP servers (ADR 014); null when HOSTED_ENABLED is not true. */
  hosted: {
    namespace: string;
    serviceAccountName: string;
    allowedImages: string[];
    requireDigest: boolean;
    maxServers: number;
    kubeHost: string;
    kubePort: number;
  } | null;
  /** Multiple stores (ADR 015); null when MULTI_STORE_ENABLED is not true. */
  multiStore: {
    settings: StoreSettings;
    maxStores: number;
    scriptsDir: string;
    kubeHost: string;
    kubePort: number;
  } | null;
  /** The chart's original store, or null if BUILTIN_STORE_URL is unset. */
  builtInStore: { name: string; slug: string; storefrontUrl: string } | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  const isUnset = (name: string) => env[name] === undefined || env[name] === '';
  // Only the variable name and a fixed reason: zod issue messages never echo the input, and
  // `input` is deliberately not read here.
  const problems = (parsed.error?.issues ?? []).map((i) => {
    const name = String(i.path[0] ?? 'environment');
    return isUnset(name) ? `${name} is missing` : `${name} ${reason(i)}`;
  });
  if (isUnset('DATABASE_URL')) {
    for (const name of PG_VARS) {
      if (isUnset(name)) problems.push(`${name} is missing (or set DATABASE_URL)`);
    }
  }
  if (parsed.success && parsed.data.HOSTED_ENABLED && isUnset('KUBERNETES_SERVICE_HOST')) {
    problems.push('KUBERNETES_SERVICE_HOST is missing (needed when HOSTED_ENABLED=true)');
  }
  let storeSettings: StoreSettings | null = null;
  if (parsed.success && parsed.data.MULTI_STORE_ENABLED) {
    if (isUnset('KUBERNETES_SERVICE_HOST')) {
      problems.push('KUBERNETES_SERVICE_HOST is missing (needed when MULTI_STORE_ENABLED=true)');
    }
    if (isUnset('MULTI_STORE_CONFIG')) {
      problems.push('MULTI_STORE_CONFIG is missing (needed when MULTI_STORE_ENABLED=true)');
    } else {
      storeSettings = parseStoreSettings(env.MULTI_STORE_CONFIG!, problems);
    }
  }
  if (!parsed.success || problems.length) {
    throw new ConfigError(`Invalid configuration: ${[...new Set(problems)].join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    db: e.DATABASE_URL
      ? { connectionString: e.DATABASE_URL }
      : {
          host: e.PGHOST!,
          port: e.PGPORT,
          user: e.PGUSER!,
          password: e.PGPASSWORD!,
          database: e.PGDATABASE!,
        },
    migrationsDir: e.MIGRATIONS_DIR ?? MIGRATIONS_DIR,
    seedAdmin: { email: e.SEED_ADMIN_EMAIL, password: e.SEED_ADMIN_PASSWORD },
    encKey: Buffer.from(e.GATEWAY_ENC_KEY, 'base64'),
    publicOrigin: e.PUBLIC_ORIGIN,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    upstreamAllowedHosts: e.UPSTREAM_ALLOWED_HOSTS,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    chatModel: e.CHAT_MODEL,
    track: e.TRACK ?? null,
    faultInject: { errorRate: e.FAULT_INJECT_ERROR_RATE, latencyMs: e.FAULT_INJECT_LATENCY_MS },
    mcpRateLimits: {
      perKey: { perMinute: e.MCP_RATE_LIMIT_KEY_PER_MIN, burst: e.MCP_RATE_LIMIT_KEY_BURST },
      perUser: { perMinute: e.MCP_RATE_LIMIT_USER_PER_MIN, burst: e.MCP_RATE_LIMIT_USER_BURST },
    },
    podName: e.POD_NAME ?? hostname(),
    metricsPort: e.METRICS_PORT,
    chatDiscoveryThreshold: e.CHAT_DISCOVERY_THRESHOLD,
    oauthRedirectSchemes: e.OAUTH_REDIRECT_SCHEMES,
    hosted: e.HOSTED_ENABLED
      ? {
          namespace: e.HOSTED_NAMESPACE,
          serviceAccountName: e.HOSTED_SERVICE_ACCOUNT,
          allowedImages: e.HOSTED_ALLOWED_IMAGES,
          requireDigest: e.HOSTED_REQUIRE_DIGEST,
          maxServers: e.HOSTED_MAX_SERVERS,
          kubeHost: e.KUBERNETES_SERVICE_HOST!,
          kubePort: e.KUBERNETES_SERVICE_PORT,
        }
      : null,
    multiStore:
      e.MULTI_STORE_ENABLED && storeSettings
        ? {
            settings: storeSettings,
            maxStores: e.MULTI_STORE_MAX_STORES,
            scriptsDir: e.MULTI_STORE_SCRIPTS_DIR,
            kubeHost: e.KUBERNETES_SERVICE_HOST!,
            kubePort: e.KUBERNETES_SERVICE_PORT,
          }
        : null,
    builtInStore: e.BUILTIN_STORE_URL
      ? { name: e.BUILTIN_STORE_NAME, slug: 'woo', storefrontUrl: e.BUILTIN_STORE_URL.replace(/\/$/, '') }
      : null,
  };
}

/** MULTI_STORE_CONFIG: JSON of the chart's settings. Problems name fields, never values. */
function parseStoreSettings(raw: string, problems: string[]): StoreSettings | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    problems.push('MULTI_STORE_CONFIG is not valid JSON');
    return null;
  }
  const r = StoreSettingsSchema.safeParse(json);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))];
    problems.push(`MULTI_STORE_CONFIG is invalid at ${fields.slice(0, 5).join(', ')}`);
    return null;
  }
  return r.data;
}

function reason(issue: z.core.$ZodIssue): string {
  if (issue.code === 'custom' || issue.code === 'too_small' || issue.code === 'invalid_value') {
    return issue.message;
  }
  if (issue.code === 'invalid_format') return 'is not a valid ' + issue.format;
  return 'is invalid';
}
