// OAuth 2.1 for MCP clients (ADR 013). The gateway is both the Authorization Server and the
// Resource Server for POST /mcp. Browser-safe: no node:* imports.
import { z } from 'zod';

/** Endpoints served by the gateway (routed by the app Ingress). */
export const OAUTH_PATHS = {
  /** RFC 9728. Also served with the resource path appended (`…/mcp`), as clients probe both. */
  protectedResource: '/.well-known/oauth-protected-resource',
  /** RFC 8414. */
  authorizationServer: '/.well-known/oauth-authorization-server',
  register: '/oauth/register',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
} as const;

/** Dashboard page that shows the consent screen: `/consent?request=<id>`. */
export const CONSENT_PAGE_PATH = '/consent';

/** The only scope: use the MCP endpoint as yourself. What you may call is tool permissions (ADR 008). */
export const OAUTH_SCOPE = 'mcp';

/** Opaque token prefixes (32 random bytes, base64url). API keys are `urk_`. */
export const ACCESS_TOKEN_PREFIX = 'uat_';
export const REFRESH_TOKEN_PREFIX = 'urt_';

export const OAUTH_TTL = {
  /** Authorization code (single use). */
  codeSeconds: 60,
  accessTokenSeconds: 60 * 60,
  refreshTokenSeconds: 30 * 24 * 60 * 60,
  /** A pending /authorize request waiting for the user's decision. */
  requestSeconds: 10 * 60,
} as const;

/** 32 random bytes, base64url: request ids and consent tokens. */
export const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const opaqueId = z.string().regex(OPAQUE_ID_RE);

/** GET /api/oauth/requests/:id — what the consent page shows. */
export const OAuthRequestInfoSchema = z.object({
  client: z.object({ id: z.uuid(), name: z.string() }),
  /** Host (and port) of the redirect URI the code will be sent to. */
  redirectHost: z.string(),
  redirectUri: z.string(),
  scope: z.string(),
  /** One-time token the decision POST must echo (CSRF; bound to this request and user). */
  consentToken: opaqueId,
});
export const OAuthDecisionRequestSchema = z.strictObject({
  approve: z.boolean(),
  consentToken: opaqueId,
});
/** Where the browser goes next: the client's registered redirect URI with code or error. */
export const OAuthDecisionResponseSchema = z.object({ redirectTo: z.string() });

/** One approved authorization ("connected app"). Admins see everyone's. */
export const ConnectedAppSchema = z.object({
  id: z.uuid(), // grant id
  clientId: z.uuid(),
  clientName: z.string(),
  redirectHosts: z.array(z.string()),
  userId: z.uuid(),
  userEmail: z.string(),
  scope: z.string(),
  authorizedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export const ConnectedAppListResponseSchema = z.object({ apps: z.array(ConnectedAppSchema) });

/** How an audited call authenticated: MCP API key, MCP OAuth token, or a dashboard session (chat). */
export const AuthMethodSchema = z.enum(['api_key', 'oauth', 'session']);

export type OAuthRequestInfo = z.infer<typeof OAuthRequestInfoSchema>;
export type OAuthDecisionRequest = z.infer<typeof OAuthDecisionRequestSchema>;
export type OAuthDecisionResponse = z.infer<typeof OAuthDecisionResponseSchema>;
export type ConnectedApp = z.infer<typeof ConnectedAppSchema>;
export type ConnectedAppListResponse = z.infer<typeof ConnectedAppListResponseSchema>;
export type AuthMethod = z.infer<typeof AuthMethodSchema>;
