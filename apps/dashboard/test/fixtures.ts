// Every fixture is parsed with its contracts schema, so a contract change breaks the tests here.
import {
  ApiKeySchema,
  AuditEntrySchema,
  ToolSchema,
  UpstreamSchema,
  UserSchema,
  type ApiKey,
  type AuditEntry,
  type Tool,
  type Upstream,
  type User,
} from '@urumi/contracts';

export const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
export const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
export const UPSTREAM_ID = '33333333-3333-4333-8333-333333333333';
export const KEY_ID = '44444444-4444-4444-8444-444444444444';
const T = '2026-10-20T10:00:00.000Z';

export const admin: User = UserSchema.parse({
  id: ADMIN_ID,
  email: 'admin@example.com',
  name: 'Ada Admin',
  role: 'admin',
  createdAt: T,
  disabledAt: null,
});

export const member: User = UserSchema.parse({
  id: MEMBER_ID,
  email: 'member@example.com',
  name: 'Max Member',
  role: 'member',
  createdAt: T,
  disabledAt: null,
});

export function upstream(overrides: Partial<Upstream> = {}): Upstream {
  return UpstreamSchema.parse({
    id: UPSTREAM_ID,
    slug: 'woo',
    name: 'WooCommerce',
    url: 'http://woo-mcp:8080/mcp',
    enabled: true,
    credentialType: 'bearer',
    hasCredential: true,
    status: 'up',
    lastError: null,
    lastCheckedAt: T,
    lastErrorReason: null,
    lastOkAt: T,
    toolCount: 2,
    ...overrides,
  });
}

export function tool(overrides: Partial<Tool> = {}): Tool {
  return ToolSchema.parse({
    name: 'woo__list_orders',
    serverSlug: 'woo',
    description: 'List store orders',
    inputSchema: { type: 'object' },
    ...overrides,
  });
}

export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return ApiKeySchema.parse({
    id: KEY_ID,
    name: 'laptop',
    prefix: 'urk_abcd',
    createdAt: T,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  });
}

export const SECRET = `urk_${'A'.repeat(20)}${'b'.repeat(20)}xyz`;

export function auditEntry(id: string, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return AuditEntrySchema.parse({
    id,
    userId: MEMBER_ID,
    userEmail: 'member@example.com',
    source: 'chat',
    serverSlug: 'woo',
    tool: 'list_orders',
    startedAt: T,
    durationMs: 120,
    outcome: 'ok',
    errorCode: null,
    errorDetail: null,
    errorReason: null,
    authMethod: 'session',
    oauthClientName: null,
    ...overrides,
  });
}
