import { z } from 'zod';
import { ErrorCodeSchema } from './errors.js';
import { SLUG_RE } from './naming.js';

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
  listTools: { method: 'GET', path: '/api/tools', auth: 'session' },
  listAudit: { method: 'GET', path: '/api/audit', auth: 'session' },
  listPermissions: { method: 'GET', path: '/api/permissions', auth: 'admin' },
  upsertPermission: { method: 'POST', path: '/api/permissions', auth: 'admin' },
  deletePermission: { method: 'DELETE', path: '/api/permissions/:id', auth: 'admin' },
  chat: { method: 'POST', path: '/api/chat', auth: 'session' },
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
  slug, // immutable after creation
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
  toolCount: z.number().int().nonnegative(),
});
export const UpstreamResponseSchema = z.object({ upstream: UpstreamSchema });
export const UpstreamListResponseSchema = z.object({ upstreams: z.array(UpstreamSchema) });

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
});
export const AuditListResponseSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: z.string().nullable(),
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
  toolCalls: z.array(
    z.object({
      name: z.string(),
      serverSlug: z.string(),
      outcome: OutcomeSchema,
      durationMs: z.number().int().nonnegative(),
      errorCode: ErrorCodeSchema.nullable(),
    }),
  ),
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
export type Outcome = z.infer<typeof OutcomeSchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
