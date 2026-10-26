import { z } from 'zod';
import { ErrorCodeSchema } from './errors.js';
import { FailureReasonSchema } from './failures.js';
import { RESERVED_SLUGS, SLUG_RE } from './naming.js';
import { AuthMethodSchema } from './oauth.js';

// Request schemas are strict (unknown fields → VALIDATION_FAILED); timestamps are ISO-8601 UTC strings.
const id = z.uuid();
const timestamp = z.iso.datetime();
const email = z.email().max(254).toLowerCase();
const displayName = z.string().trim().min(1).max(100);
const slug = z.string().regex(SLUG_RE);

// ── Routes ───────────────────────────────────────────────────────────────────────────────────
// `session` = any signed-in user; `admin` = session with role admin. POST /mcp is in mcp.ts.
export type RouteAuth = 'public' | 'session' | 'admin';
type Route = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; auth: RouteAuth };
export const ROUTES = {
  healthz: { method: 'GET', path: '/healthz', auth: 'public' },
  readyz: { method: 'GET', path: '/readyz', auth: 'public' },
  login: { method: 'POST', path: '/api/auth/login', auth: 'public' },
  logout: { method: 'POST', path: '/api/auth/logout', auth: 'session' },
  me: { method: 'GET', path: '/api/auth/me', auth: 'session' },
  changePassword: { method: 'POST', path: '/api/auth/password', auth: 'session' },
  listUsers: { method: 'GET', path: '/api/users', auth: 'admin' },
  createUser: { method: 'POST', path: '/api/users', auth: 'admin' },
  updateUser: { method: 'PATCH', path: '/api/users/:id', auth: 'admin' },
  listUserKeys: { method: 'GET', path: '/api/users/:id/keys', auth: 'admin' },
  revokeUserKey: { method: 'DELETE', path: '/api/users/:id/keys/:keyId', auth: 'admin' },
  listKeys: { method: 'GET', path: '/api/keys', auth: 'session' },
  createKey: { method: 'POST', path: '/api/keys', auth: 'session' },
  revokeKey: { method: 'DELETE', path: '/api/keys/:id', auth: 'session' },
  listUpstreams: { method: 'GET', path: '/api/upstreams', auth: 'session' },
  createUpstream: { method: 'POST', path: '/api/upstreams', auth: 'admin' },
  updateUpstream: { method: 'PATCH', path: '/api/upstreams/:id', auth: 'admin' },
  deleteUpstream: { method: 'DELETE', path: '/api/upstreams/:id', auth: 'admin' },
  listUpstreamTools: { method: 'GET', path: '/api/upstreams/:id/tools', auth: 'session' },
  // Hosted MCP servers (ADR 014): run by the gateway in the cluster from a container image.
  listHostedServers: { method: 'GET', path: '/api/hosted-servers', auth: 'admin' },
  createHostedServer: { method: 'POST', path: '/api/hosted-servers', auth: 'admin' },
  updateHostedServer: { method: 'PATCH', path: '/api/hosted-servers/:id', auth: 'admin' },
  deleteHostedServer: { method: 'DELETE', path: '/api/hosted-servers/:id', auth: 'admin' },
  // Stores (ADR 015): extra WooCommerce stores, each in its own namespace, auto-registered.
  listStores: { method: 'GET', path: '/api/stores', auth: 'admin' },
  createStore: { method: 'POST', path: '/api/stores', auth: 'admin' },
  deleteStore: { method: 'DELETE', path: '/api/stores/:id', auth: 'admin' },
  retryStore: { method: 'POST', path: '/api/stores/:id/retry', auth: 'admin' },
  listTools: { method: 'GET', path: '/api/tools', auth: 'session' },
  listAudit: { method: 'GET', path: '/api/audit', auth: 'session' },
  listPermissions: { method: 'GET', path: '/api/permissions', auth: 'admin' },
  upsertPermission: { method: 'POST', path: '/api/permissions', auth: 'admin' },
  deletePermission: { method: 'DELETE', path: '/api/permissions/:id', auth: 'admin' },
  metricsSummary: { method: 'GET', path: '/api/metrics/summary', auth: 'admin' },
  chat: { method: 'POST', path: '/api/chat', auth: 'session' },
  // OAuth consent (ADR 013); the OAuth endpoints themselves are OAUTH_PATHS in oauth.ts.
  getOAuthRequest: { method: 'GET', path: '/api/oauth/requests/:id', auth: 'session' },
  decideOAuthRequest: { method: 'POST', path: '/api/oauth/requests/:id', auth: 'session' },
  /** Members: their own connected apps; admins: everyone's. */
  listConnectedApps: { method: 'GET', path: '/api/connected-apps', auth: 'session' },
  revokeConnectedApp: { method: 'DELETE', path: '/api/connected-apps/:id', auth: 'session' },
} as const satisfies Record<string, Route>;

// ── Auth and users ───────────────────────────────────────────────────────────────────────────
/** Login sets the httpOnly SameSite=Lax cookie `urumi_session`. */
export const SESSION_COOKIE = 'urumi_session';
export const RoleSchema = z.enum(['admin', 'member']);
export const UserSchema = z.object({
  id,
  email,
  name: z.string(),
  role: RoleSchema,
  createdAt: timestamp,
  disabledAt: timestamp.nullable(),
});
export const UserResponseSchema = z.object({ user: UserSchema }); // login, me, update user
export const UserListResponseSchema = z.object({ users: z.array(UserSchema) });

export const LoginRequestSchema = z.strictObject({ email, password: z.string().min(1).max(1024) });
export const ChangePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});
export const CreateUserRequestSchema = z.strictObject({
  email,
  name: displayName,
  role: RoleSchema,
});
/** `tempPassword` is shown once; the admin hands it to the member. */
export const CreateUserResponseSchema = z.object({ user: UserSchema, tempPassword: z.string() });
export const UpdateUserRequestSchema = z.strictObject({
  name: displayName.optional(),
  role: RoleSchema.optional(),
  disabled: z.boolean().optional(),
});

// ── API keys ─────────────────────────────────────────────────────────────────────────────────
/** Secret = `urk_` + base64url(32 random bytes); stored as sha256, shown once. */
export const API_KEY_PREFIX = 'urk_';
export const ApiKeySchema = z.object({
  id,
  name: z.string(),
  prefix: z.string().length(8).startsWith(API_KEY_PREFIX), // first 8 chars of the secret
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});
export const ApiKeyListResponseSchema = z.object({ keys: z.array(ApiKeySchema) });
export const CreateKeyRequestSchema = z.strictObject({ name: displayName });
export const CreateKeyResponseSchema = z.object({
  key: ApiKeySchema,
  secret: z.string().regex(/^urk_[A-Za-z0-9_-]{43}$/),
});

// ── Upstreams ────────────────────────────────────────────────────────────────────────────────
// Headers the gateway controls itself; a credential must not override them.
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'accept', 'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version',
]); // prettier-ignore
const headerName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/, 'Must be an RFC 7230 token')
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), 'Header is reserved');
const credentialValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n\0]+$/, 'No CR, LF, or NUL');
export const CredentialSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bearer'), value: credentialValue }),
  z.strictObject({ type: z.literal('header'), headerName, value: credentialValue }),
]);
/** Scheme check only; the gateway applies the SSRF guard (resolved IPs) on create, edit, and call. */
const upstreamUrl = z.url({ protocol: /^https?$/ }).max(2048);

export const CreateUpstreamRequestSchema = z.strictObject({
  // Immutable after creation; `gateway` is reserved for the gateway's meta-tools (ADR 012).
  slug: slug.refine((s) => !RESERVED_SLUGS.includes(s), 'is reserved'),
  name: displayName,
  url: upstreamUrl,
  enabled: z.boolean().default(true),
  credential: CredentialSchema.optional(),
});
export const UpdateUpstreamRequestSchema = z.strictObject({
  name: displayName.optional(),
  url: upstreamUrl.optional(),
  enabled: z.boolean().optional(),
  credential: CredentialSchema.nullable().optional(), // null = remove
});
/** Strict: a credential value can never appear in a response. `url` is sent to admins only. */
export const UpstreamSchema = z.strictObject({
  id,
  slug,
  name: z.string(),
  url: z.string().optional(),
  enabled: z.boolean(),
  credentialType: z.enum(['none', 'bearer', 'header']),
  hasCredential: z.boolean(),
  status: z.enum(['unknown', 'up', 'down']),
  lastError: z.string().nullable(),
  lastCheckedAt: timestamp.nullable(),
  /** Classification of lastError (ADR 011); null when there is none. */
  lastErrorReason: FailureReasonSchema.nullable(),
  /** Last successful health check. */
  lastOkAt: timestamp.nullable(),
  toolCount: z.number().int().nonnegative(),
  /** Run by the gateway from a container image (ADR 014); managed via /api/hosted-servers. */
  hosted: z.boolean().optional(),
  /** The woo-mcp of a provisioned store (ADR 015); managed via /api/stores. */
  store: z.boolean().optional(),
});
export const UpstreamResponseSchema = z.object({ upstream: UpstreamSchema });
export const UpstreamListResponseSchema = z.object({ upstreams: z.array(UpstreamSchema) });

// ── Hosted MCP servers (ADR 014) ─────────────────────────────────────────────────────────────
/** Lowercase image reference (registry/path[:tag][@sha256:digest]); the gateway applies the allow-list. */
export const IMAGE_REF_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** Env var names: POSIX-ish; PORT and KUBERNETES_* are set by the platform. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const envName = z
  .string()
  .regex(ENV_NAME_RE, 'Must be a valid environment variable name')
  .refine((n) => n !== 'PORT' && !n.startsWith('KUBERNETES_'), 'is set by the platform');
const envValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\0]*$/, 'No NUL');
export const HostedEnvSchema = z
  .record(envName, envValue)
  .refine((env) => Object.keys(env).length <= 20, 'At most 20 variables');
export const HostedPresetSchema = z.enum(['small', 'medium']);
export const HostedPhaseSchema = z.enum([
  'deploying',
  'connected',
  'unreachable',
  'failed',
  'deleting',
]);
const imageRef = z.string().max(512).regex(IMAGE_REF_RE, 'Must be a lowercase image reference');
const mcpPath = z
  .string()
  .regex(/^\/[A-Za-z0-9._~/-]{0,127}$/, 'Must be an absolute path')
  .default('/mcp');
const containerPort = z.number().int().min(1024).max(65535);

export const CreateHostedServerRequestSchema = z.strictObject({
  slug: slug.refine((s) => !RESERVED_SLUGS.includes(s), 'is reserved'),
  name: displayName,
  image: imageRef,
  port: containerPort,
  mcpPath,
  preset: HostedPresetSchema.default('small'),
  /** Outbound internet (80/443, no private ranges). Default: none at all. */
  egress: z.boolean().default(false),
  /** Values are write-only: stored encrypted, injected via a Secret, never returned. */
  env: HostedEnvSchema.optional(),
});
export const UpdateHostedServerRequestSchema = z.strictObject({
  name: displayName.optional(),
  image: imageRef.optional(),
  preset: HostedPresetSchema.optional(),
  egress: z.boolean().optional(),
  /** Replaces all variables; {} removes them. */
  env: HostedEnvSchema.optional(),
});
/** Strict: env values can never appear in a response, only their names. */
export const HostedServerSchema = z.strictObject({
  id,
  slug,
  name: z.string(),
  image: z.string(),
  imageDigest: z.string().nullable(),
  port: z.number().int(),
  mcpPath: z.string(),
  preset: HostedPresetSchema,
  egress: z.boolean(),
  envKeys: z.array(z.string()),
  phase: HostedPhaseSchema,
  /** Why it is failed / unreachable / still deploying (ImagePullBackOff, CrashLoopBackOff …). */
  reason: z.string().nullable(),
  /** In-cluster URL the gateway registered as the upstream. */
  url: z.string(),
  toolCount: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const HostedServerResponseSchema = z.object({ server: HostedServerSchema });
export const HostedServerListResponseSchema = z.object({
  /** False when the gateway runs without HOSTED_ENABLED (no Kubernetes access). */
  enabled: z.boolean(),
  allowedImagePrefixes: z.array(z.string()),
  requireDigest: z.boolean(),
  maxServers: z.number().int(),
  servers: z.array(HostedServerSchema),
});

// ── Stores (ADR 015) ─────────────────────────────────────────────────────────────────────────
/**
 * Store slug: also the upstream slug (tools `<slug>__list_products`), the namespace `store-<slug>`
 * and the storefront host `<slug>.<domain suffix>`. A DNS-1123 label of 2–20 chars that starts with
 * a letter (so the host is never all digits).
 */
export const STORE_SLUG_RE = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])$/;
/** Names a store may not take: the built-in upstreams, platform hosts and Kubernetes-ish words. */
export const RESERVED_STORE_SLUGS: readonly string[] = [
  ...RESERVED_SLUGS,
  'woo',
  'everything',
  'gitlab',
  'default',
  'store',
  'stores',
  'app',
  'www',
  'api',
  'admin',
  'mcp',
  'urumi',
  'hosted',
  'kube',
  'system',
  'public',
];
export const StoreSlugSchema = z
  .string()
  .regex(
    STORE_SLUG_RE,
    'Must be 2–20 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen',
  )
  .refine((s) => !RESERVED_STORE_SLUGS.includes(s), 'is reserved');
export const StorePhaseSchema = z.enum(['provisioning', 'ready', 'failed', 'deleting']);
export const CreateStoreRequestSchema = z.strictObject({
  slug: StoreSlugSchema,
  name: displayName,
  /** WordPress administrator email. The admin password is generated in-cluster and never returned. */
  adminEmail: email,
});
/** Strict: no password, shared secret or Application Password can appear in a response. */
export const StoreSchema = z.strictObject({
  id,
  slug,
  name: z.string(),
  adminEmail: z.string(),
  namespace: z.string(),
  storefrontUrl: z.string(),
  phase: StorePhaseSchema,
  /** Current provisioning step, or why it failed (bootstrap job failed, ImagePullBackOff, …). */
  reason: z.string().nullable(),
  /** The store's upstream (its woo-mcp): enabled once provisioned, then health-checked. */
  upstreamEnabled: z.boolean(),
  upstreamStatus: z.enum(['unknown', 'up', 'down']),
  toolCount: z.number().int().nonnegative(),
  /** Bumped by every Retry (a new bootstrap Job runs). */
  generation: z.number().int().positive(),
  provisionStartedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const StoreResponseSchema = z.object({ store: StoreSchema });
export const StoreListResponseSchema = z.object({
  /** False when the gateway runs without MULTI_STORE_ENABLED (no Kubernetes access). */
  enabled: z.boolean(),
  maxStores: z.number().int(),
  /** Storefronts are http(s)://<slug>.<domainSuffix>. */
  domainSuffix: z.string(),
  /** The chart's original store (upstream `woo`): shown, never deletable. */
  builtIn: z.object({ name: z.string(), slug, storefrontUrl: z.string() }).nullable(),
  stores: z.array(StoreSchema),
});

// ── Tools ────────────────────────────────────────────────────────────────────────────────────
/**
 * Returned by GET /api/tools and GET /api/upstreams/:id/tools: only the tools the caller's tool
 * permissions allow (permissions.ts). Descriptions are untrusted data.
 */
export const ToolSchema = z.object({
  name: z.string(), // qualified: {slug}__{tool}
  serverSlug: slug,
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export const ToolListResponseSchema = z.object({ tools: z.array(ToolSchema) });

// ── Audit ────────────────────────────────────────────────────────────────────────────────────
/** `rate_limited`: an /mcp request refused by the per-key or per-user limit (ADR 010). */
export const OutcomeSchema = z.enum(['ok', 'error', 'timeout', 'denied', 'rate_limited']);
/** Query-string input. For members the gateway forces `userId` to their own id. */
export const AuditQuerySchema = z.strictObject({
  userId: id.optional(),
  serverSlug: slug.optional(),
  tool: z.string().max(200).optional(),
  outcome: OutcomeSchema.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(), // opaque
});
export const AuditEntrySchema = z.object({
  id: z.string(), // bigint identity, serialized as a string
  userId: id,
  userEmail: z.string(),
  source: z.enum(['mcp', 'chat']),
  serverSlug: z.string(),
  tool: z.string(), // upstream tool name
  startedAt: timestamp,
  durationMs: z.number().int().nonnegative(),
  outcome: OutcomeSchema,
  errorCode: ErrorCodeSchema.nullable(),
  /** Why the call failed, fixed vocabulary (ADR 011); null for ok. */
  errorDetail: z.string().nullable(),
  errorReason: FailureReasonSchema.nullable(),
  /** api_key / oauth (MCP) or session (chat), ADR 013. */
  authMethod: AuthMethodSchema,
  /** Registered name of the OAuth client, for authMethod oauth; otherwise null. */
  oauthClientName: z.string().nullable(),
});
export const AuditListResponseSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: z.string().nullable(),
});

// ── Metrics (ADR 011) ────────────────────────────────────────────────────────────────────────
/** GET /api/metrics/summary: per-server call stats over a window, from audit_log (all replicas). */
export const MetricsSummaryQuerySchema = z.strictObject({
  windowMinutes: z.coerce.number().int().min(1).max(10_080).default(60),
});
export const ServerMetricsSchema = z.object({
  serverSlug: z.string(),
  calls: z.number().int().nonnegative(),
  /** Calls whose outcome is not `ok`. */
  errors: z.number().int().nonnegative(),
  /** errors / calls, 0..1 (0 when there are no calls). */
  errorRate: z.number().min(0).max(1),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  byOutcome: z.record(z.string(), z.number().int().nonnegative()),
  /** Most frequent failure details in the window. */
  topErrors: z.array(
    z.object({
      errorCode: z.string().nullable(),
      errorDetail: z.string().nullable(),
      reason: FailureReasonSchema.nullable(),
      count: z.number().int().positive(),
      lastAt: timestamp,
    }),
  ),
  /** The registered upstream with this slug, if any (calls can name unknown slugs). */
  upstream: z
    .object({
      id,
      name: z.string(),
      enabled: z.boolean(),
      status: z.enum(['unknown', 'up', 'down']),
      lastError: z.string().nullable(),
      lastErrorReason: FailureReasonSchema.nullable(),
      lastCheckedAt: timestamp.nullable(),
      lastOkAt: timestamp.nullable(),
    })
    .nullable(),
});
export const MetricsSummaryResponseSchema = z.object({
  windowMinutes: z.number().int(),
  generatedAt: timestamp,
  /** Replica (pod) currently holding the health-loop lease; null if none (ADR 010). */
  healthLeader: z.string().nullable(),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    errorRate: z.number().min(0).max(1),
    rateLimited: z.number().int().nonnegative(),
  }),
  servers: z.array(ServerMetricsSchema),
});

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────
/** Conversation state lives in the browser; the gateway is stateless and resends the history. */
export const ChatRequestSchema = z.strictObject({
  messages: z
    .array(
      z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }),
    )
    .min(1)
    .max(40),
});
export const ChatResponseSchema = z.object({
  reply: z.string(),
  /** Real tools executed (also when the model reached them through gateway__call_tool). */
  toolCalls: z.array(
    z.object({
      name: z.string(),
      serverSlug: z.string(),
      outcome: OutcomeSchema,
      durationMs: z.number().int().nonnegative(),
      errorCode: ErrorCodeSchema.nullable(),
      /** Present when the call went through discovery mode's gateway__call_tool (ADR 012). */
      via: z.literal('discovery').optional(),
    }),
  ),
  /**
   * `discovery` when the user's permitted tools exceeded the threshold, so the model got only
   * gateway__search_tools + gateway__call_tool (ADR 012). Absent from older gateways.
   */
  toolMode: z.enum(['direct', 'discovery']).optional(),
  /** The model's tool searches in discovery mode (not audited: they run no upstream tool). */
  discoverySearches: z
    .array(z.object({ query: z.string(), resultCount: z.number().int(), top: z.array(z.string()) }))
    .optional(),
});

export type Role = z.infer<typeof RoleSchema>;
export type User = z.infer<typeof UserSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type CreateUserResponse = z.infer<typeof CreateUserResponseSchema>;
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type CreateKeyRequest = z.infer<typeof CreateKeyRequestSchema>;
export type CreateKeyResponse = z.infer<typeof CreateKeyResponseSchema>;
export type Credential = z.infer<typeof CredentialSchema>;
export type CreateUpstreamRequest = z.infer<typeof CreateUpstreamRequestSchema>;
export type UpdateUpstreamRequest = z.infer<typeof UpdateUpstreamRequestSchema>;
export type Upstream = z.infer<typeof UpstreamSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type CreateHostedServerRequest = z.infer<typeof CreateHostedServerRequestSchema>;
export type UpdateHostedServerRequest = z.infer<typeof UpdateHostedServerRequestSchema>;
export type HostedServer = z.infer<typeof HostedServerSchema>;
export type HostedServerListResponse = z.infer<typeof HostedServerListResponseSchema>;
export type HostedPhase = z.infer<typeof HostedPhaseSchema>;
export type CreateStoreRequest = z.infer<typeof CreateStoreRequestSchema>;
export type Store = z.infer<typeof StoreSchema>;
export type StorePhase = z.infer<typeof StorePhaseSchema>;
export type StoreListResponse = z.infer<typeof StoreListResponseSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type MetricsSummaryQuery = z.infer<typeof MetricsSummaryQuerySchema>;
export type ServerMetrics = z.infer<typeof ServerMetricsSchema>;
export type MetricsSummaryResponse = z.infer<typeof MetricsSummaryResponseSchema>;
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
