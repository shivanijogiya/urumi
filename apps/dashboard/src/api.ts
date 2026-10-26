// The one fetch wrapper. Every response is parsed with its contracts schema; every non-2xx body is
// read as the error envelope. Writes send JSON (the gateway's CSRF guard rejects any other body
// type) and rely on the browser's Origin header, which the gateway checks against PUBLIC_ORIGIN.
import {
  ApiKeyListResponseSchema,
  AuditListResponseSchema,
  AuditQuerySchema,
  ChangePasswordRequestSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  ConnectedAppListResponseSchema,
  CreateKeyRequestSchema,
  CreateKeyResponseSchema,
  CreateHostedServerRequestSchema,
  CreateUpstreamRequestSchema,
  HostedServerListResponseSchema,
  HostedServerResponseSchema,
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  ErrorEnvelopeSchema,
  LoginRequestSchema,
  MetricsSummaryResponseSchema,
  OAuthDecisionRequestSchema,
  OAuthDecisionResponseSchema,
  OAuthRequestInfoSchema,
  PermissionListResponseSchema,
  PermissionResponseSchema,
  ROUTES,
  ToolListResponseSchema,
  UpdateUpstreamRequestSchema,
  UpdateUserRequestSchema,
  UpsertPermissionRequestSchema,
  UpstreamListResponseSchema,
  UpstreamResponseSchema,
  UserListResponseSchema,
  UserResponseSchema,
  type AuditQuery,
  type ChatRequest,
  type ChangePasswordRequest,
  type CreateHostedServerRequest,
  type CreateUpstreamRequest,
  type CreateUserRequest,
  type ErrorCode,
  type LoginRequest,
  type UpdateUpstreamRequest,
  type UpdateUserRequest,
  type UpsertPermissionRequest,
} from '@urumi/contracts';
import type { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 20_000;
/** A chat turn can run several 15 s tool calls plus model time. */
const CHAT_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK' | 'BAD_RESPONSE',
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── 401 handling ─────────────────────────────────────────────────────────────────────────────
// The app installs a router-aware handler; the fallback is a full page load, which also wipes
// any in-memory state (chat history, a key shown once).
let onUnauthorized: () => void = () => {
  if (window.location.pathname !== '/login') window.location.assign('/login');
};

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

// ── Core request ─────────────────────────────────────────────────────────────────────────────
interface RequestOptions<S extends z.ZodType | undefined> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema: S;
  timeoutMs?: number;
  /** Login answers 401 for bad credentials; that is a form error, not "signed out". */
  redirectOn401?: boolean;
}

type Result<S> = S extends z.ZodType ? z.infer<S> : undefined;

export async function request<S extends z.ZodType | undefined>(
  path: string,
  opts: RequestOptions<S>,
): Promise<Result<S>> {
  const { method = 'GET', body, schema, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ApiError(
      0,
      'NETWORK',
      timedOut ? 'The server took too long to respond.' : 'Could not reach the server.',
    );
  }

  if (!res.ok) {
    if (res.status === 401 && opts.redirectOn401 !== false) onUnauthorized();
    throw await toApiError(res);
  }
  if (schema === undefined) return undefined as Result<S>;

  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
  }
  return parsed.data as Result<S>;
}

async function toApiError(res: Response): Promise<ApiError> {
  const envelope = ErrorEnvelopeSchema.safeParse(await res.json().catch(() => undefined));
  if (envelope.success) {
    const { code, message, requestId } = envelope.data.error;
    return new ApiError(res.status, code, message, requestId);
  }
  return new ApiError(res.status, 'BAD_RESPONSE', `Request failed (HTTP ${res.status}).`);
}

/** Validates a request body against its contracts schema so mistakes show before the round trip. */
function checked<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  const message = issue ? `${field ? `${field}: ` : ''}${issue.message}` : 'Invalid input';
  throw new ApiError(0, 'VALIDATION_FAILED', message);
}

/** Fills `:param` segments, URL-encoding each value. */
export function routePath(path: string, params: Record<string, string>): string {
  return path.replace(/:(\w+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing route param ${key}`);
    return encodeURIComponent(value);
  });
}

/** Audit filters → query string, dropping empty values. Validated with AuditQuerySchema. */
export function auditQueryString(query: Partial<AuditQuery>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(checked(AuditQuerySchema, query))) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

// ── Endpoints ────────────────────────────────────────────────────────────────────────────────
// Async so that a body failing `checked` rejects like any other API error instead of throwing.
export const api = {
  me: async () => request(ROUTES.me.path, { schema: UserResponseSchema }).then((r) => r.user),
  login: async (body: LoginRequest) =>
    request(ROUTES.login.path, {
      method: 'POST',
      body: checked(LoginRequestSchema, body),
      schema: UserResponseSchema,
      redirectOn401: false,
    }).then((r) => r.user),
  logout: async () => request(ROUTES.logout.path, { method: 'POST', schema: undefined }),
  changePassword: async (body: ChangePasswordRequest) =>
    request(ROUTES.changePassword.path, {
      method: 'POST',
      body: checked(ChangePasswordRequestSchema, body),
      schema: undefined,
    }),

  listUsers: async () =>
    request(ROUTES.listUsers.path, { schema: UserListResponseSchema }).then((r) => r.users),
  createUser: async (body: CreateUserRequest) =>
    request(ROUTES.createUser.path, {
      method: 'POST',
      body: checked(CreateUserRequestSchema, body),
      schema: CreateUserResponseSchema,
    }),
  updateUser: async (id: string, body: UpdateUserRequest) =>
    request(routePath(ROUTES.updateUser.path, { id }), {
      method: 'PATCH',
      body: checked(UpdateUserRequestSchema, body),
      schema: UserResponseSchema,
    }).then((r) => r.user),
  listUserKeys: async (id: string) =>
    request(routePath(ROUTES.listUserKeys.path, { id }), {
      schema: ApiKeyListResponseSchema,
    }).then((r) => r.keys),
  revokeUserKey: async (id: string, keyId: string) =>
    request(routePath(ROUTES.revokeUserKey.path, { id, keyId }), {
      method: 'DELETE',
      schema: undefined,
    }),

  listPermissions: async () =>
    request(ROUTES.listPermissions.path, { schema: PermissionListResponseSchema }).then(
      (r) => r.rules,
    ),
  upsertPermission: async (body: UpsertPermissionRequest) =>
    request(ROUTES.upsertPermission.path, {
      method: 'POST',
      body: checked(UpsertPermissionRequestSchema, body),
      schema: PermissionResponseSchema,
    }).then((r) => r.rule),
  deletePermission: async (id: string) =>
    request(routePath(ROUTES.deletePermission.path, { id }), {
      method: 'DELETE',
      schema: undefined,
    }),

  listKeys: async () =>
    request(ROUTES.listKeys.path, { schema: ApiKeyListResponseSchema }).then((r) => r.keys),
  createKey: async (name: string) =>
    request(ROUTES.createKey.path, {
      method: 'POST',
      body: checked(CreateKeyRequestSchema, { name }),
      schema: CreateKeyResponseSchema,
    }),
  revokeKey: async (id: string) =>
    request(routePath(ROUTES.revokeKey.path, { id }), { method: 'DELETE', schema: undefined }),

  listUpstreams: async () =>
    request(ROUTES.listUpstreams.path, { schema: UpstreamListResponseSchema }).then(
      (r) => r.upstreams,
    ),
  createUpstream: async (body: CreateUpstreamRequest) =>
    request(ROUTES.createUpstream.path, {
      method: 'POST',
      body: checked(CreateUpstreamRequestSchema, body),
      schema: UpstreamResponseSchema,
    }).then((r) => r.upstream),
  updateUpstream: async (id: string, body: UpdateUpstreamRequest) =>
    request(routePath(ROUTES.updateUpstream.path, { id }), {
      method: 'PATCH',
      body: checked(UpdateUpstreamRequestSchema, body),
      schema: UpstreamResponseSchema,
    }).then((r) => r.upstream),
  deleteUpstream: async (id: string) =>
    request(routePath(ROUTES.deleteUpstream.path, { id }), {
      method: 'DELETE',
      schema: undefined,
    }),
  // Hosted MCP servers (ADR 014), admin only. Env values go out once and never come back.
  listHostedServers: async () =>
    request(ROUTES.listHostedServers.path, { schema: HostedServerListResponseSchema }),
  createHostedServer: async (body: CreateHostedServerRequest) =>
    request(ROUTES.createHostedServer.path, {
      method: 'POST',
      body: checked(CreateHostedServerRequestSchema, body),
      schema: HostedServerResponseSchema,
    }).then((r) => r.server),
  deleteHostedServer: async (id: string) =>
    request(routePath(ROUTES.deleteHostedServer.path, { id }), {
      method: 'DELETE',
      schema: undefined,
    }),
  listUpstreamTools: async (id: string) =>
    request(routePath(ROUTES.listUpstreamTools.path, { id }), {
      schema: ToolListResponseSchema,
    }).then((r) => r.tools),
  listTools: async () =>
    request(ROUTES.listTools.path, { schema: ToolListResponseSchema }).then((r) => r.tools),

  metricsSummary: async (windowMinutes: number) =>
    request(`${ROUTES.metricsSummary.path}?windowMinutes=${encodeURIComponent(windowMinutes)}`, {
      schema: MetricsSummaryResponseSchema,
    }),

  listAudit: async (query: Partial<AuditQuery>) =>
    request(`${ROUTES.listAudit.path}?${auditQueryString(query)}`, {
      schema: AuditListResponseSchema,
    }),

  // OAuth consent and connected apps (ADR 013).
  getOAuthRequest: async (id: string) =>
    request(routePath(ROUTES.getOAuthRequest.path, { id }), { schema: OAuthRequestInfoSchema }),
  decideOAuthRequest: async (id: string, body: { approve: boolean; consentToken: string }) =>
    request(routePath(ROUTES.decideOAuthRequest.path, { id }), {
      method: 'POST',
      body: checked(OAuthDecisionRequestSchema, body),
      schema: OAuthDecisionResponseSchema,
    }).then((r) => r.redirectTo),
  listConnectedApps: async () =>
    request(ROUTES.listConnectedApps.path, { schema: ConnectedAppListResponseSchema }).then(
      (r) => r.apps,
    ),
  revokeConnectedApp: async (id: string) =>
    request(routePath(ROUTES.revokeConnectedApp.path, { id }), {
      method: 'DELETE',
      schema: undefined,
    }),

  chat: async (body: ChatRequest) =>
    request(ROUTES.chat.path, {
      method: 'POST',
      body: checked(ChatRequestSchema, body),
      schema: ChatResponseSchema,
      timeoutMs: CHAT_TIMEOUT_MS,
    }),
};

/** A user-facing message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong.';
}
