// The Authorization Server half of ADR 013, as Fastify routes:
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 (Resource Server metadata)
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /oauth/register                               RFC 7591 Dynamic Client Registration
//   GET  /oauth/authorize                              code + PKCE S256 → consent page
//   POST /oauth/token                                  authorization_code, refresh_token
//   POST /oauth/revoke                                 RFC 7009
// The consent decision itself is a cookie-authenticated dashboard API (consent-routes.ts).
//
// Why not the SDK's mcpAuthRouter: it is an Express router (the gateway is Fastify) and its
// provider interface leaves storage, consent and reuse detection to us anyway; see ADR 013.
// The SDK's resource-matching helper (checkResourceAllowed) is used for RFC 8707.
//
// These routes read no cookie, so they are exempt from the CSRF guard and answer CORS with `*`
// (browser-based clients such as MCP Inspector call them cross-origin). Errors use the OAuth
// JSON shape {error, error_description}, not the gateway envelope.
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  CONSENT_PAGE_PATH,
  MCP_PATH,
  OAUTH_PATHS,
  OAUTH_SCOPE,
  OAUTH_TTL,
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
} from '@urumi/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db/tx.js';
import type { BucketLimit, PgTokenBucket } from '../ratelimit/bucket.js';
import {
  randomToken,
  safeEqual,
  sha256,
  sha256hex,
  verifyPkceS256,
  CODE_CHALLENGE_RE,
} from './crypto.js';
import {
  redirectUriMatches,
  redirectUriProblem,
  withParams,
  type RedirectPolicy,
} from './redirect.js';
import {
  activateGrant,
  deleteToken,
  findClient,
  findTokenGrant,
  insertAuthRequest,
  insertClient,
  insertToken,
  pruneOAuth,
  redeemCode,
  revokeGrant,
  rotateRefreshToken,
  type AuthMethod,
} from './repo.js';

export interface OAuthConfig {
  /** PUBLIC_ORIGIN: the issuer, and the origin of the protected resource `${origin}/mcp`. */
  issuer: string;
  redirectPolicy?: RedirectPolicy;
  bucket: PgTokenBucket;
  limits?: Partial<OAuthLimits>;
}

export interface OAuthLimits {
  /** Dynamic Client Registrations per client IP. */
  registerPerIp: BucketLimit;
  /** Registrations in total (all IPs): caps table growth under a distributed flood. */
  registerGlobal: BucketLimit;
  /** /oauth/authorize requests per IP (each one stores a pending request row). */
  authorizePerIp: BucketLimit;
  /** /oauth/token + /oauth/revoke per IP. */
  tokenPerIp: BucketLimit;
}

export const DEFAULT_OAUTH_LIMITS: OAuthLimits = {
  registerPerIp: { perMinute: 1, burst: 10 },
  registerGlobal: { perMinute: 10, burst: 100 },
  authorizePerIp: { perMinute: 30, burst: 30 },
  tokenPerIp: { perMinute: 60, burst: 60 },
};

const FORM_BODY_LIMIT = 16 * 1024;
const MAX_STATE_LENGTH = 1024;
const SUPPORTED_AUTH_METHODS: AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export const resourceUrl = (issuer: string) => `${issuer}${MCP_PATH}`;
export const resourceMetadataUrl = (issuer: string) =>
  `${issuer}${OAUTH_PATHS.protectedResource}${MCP_PATH}`;

export function protectedResourceMetadata(issuer: string): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUrl(issuer),
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Urumi MCP Gateway',
  };
}

export function authorizationServerMetadata(issuer: string): OAuthMetadata {
  return {
    issuer,
    authorization_endpoint: issuer + OAUTH_PATHS.authorize,
    token_endpoint: issuer + OAUTH_PATHS.token,
    registration_endpoint: issuer + OAUTH_PATHS.register,
    revocation_endpoint: issuer + OAUTH_PATHS.revoke,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: SUPPORTED_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: SUPPORTED_AUTH_METHODS,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * RFC 8707: a `resource` the client asks for must be the gateway's MCP URL (scheme, host, port and
 * path; a query such as ?mode=discovery is tolerated, a fragment is not). Absent = that URL.
 */
export function resourceProblem(issuer: string, resource: unknown): string | null {
  if (resource === undefined) return null;
  if (typeof resource !== 'string' || resource.length > 2000 || !URL.canParse(resource)) {
    return 'resource must be an absolute URI';
  }
  const u = new URL(resource);
  if (u.hash || resource.includes('#')) return 'resource must not contain a fragment';
  const canonical = resourceUrl(issuer);
  // checkResourceAllowed: same origin, and the requested path within the configured one.
  const noQuery = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  if (
    noQuery !== canonical ||
    !checkResourceAllowed({ requestedResource: u, configuredResource: canonical })
  ) {
    return 'resource is not this server';
  }
  return null;
}

/** Space-separated scopes; every one must be supported. Absent/empty = `mcp`. */
export function normaliseScope(raw: unknown): string | null {
  if (raw === undefined || raw === '') return OAUTH_SCOPE;
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const parts = [...new Set(raw.split(' ').filter(Boolean))];
  if (parts.length === 0) return OAUTH_SCOPE;
  return parts.every((p) => p === OAUTH_SCOPE) ? parts.join(' ') : null;
}

function setCors(reply: FastifyReply): void {
  reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version')
    .header('access-control-max-age', '600');
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

/** First value of a form/query parameter; repeated parameters are an error (RFC 6749 §3.1). */
function param(src: unknown, name: string): string | undefined {
  const v = (src as Record<string, unknown> | undefined)?.[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new OAuthError('invalid_request', `${name} must be given once`);
  return v;
}

const RegisterSchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(5),
  client_name: z.string().max(1000).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).max(10).optional(),
  response_types: z.array(z.string()).max(10).optional(),
  scope: z.string().max(200).optional(),
});

/** Display name for the consent page: printable, single line, ≤ 100 chars. */
function cleanClientName(raw: string | undefined): string {
  const name = (raw ?? '')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return name || 'Unnamed MCP client';
}

/** HTTP Basic client credentials (RFC 6749 §2.3.1: form-urlencoded id and secret). */
function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  const m = header ? /^Basic ([A-Za-z0-9+/=]{1,1000})$/.exec(header) : null;
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

export function registerOAuthRoutes(app: FastifyInstance, cfg: OAuthConfig): void {
  const { pool } = app;
  const issuer = cfg.issuer;
  const limits: OAuthLimits = { ...DEFAULT_OAUTH_LIMITS, ...cfg.limits };
  const canonicalResource = resourceUrl(issuer);

  const limited = async (key: string, limit: BucketLimit) => {
    const r = await cfg.bucket.take(key, limit);
    if (!r.allowed) {
      throw Object.assign(
        new OAuthError('temporarily_unavailable', 'Too many requests; retry later', 429),
        {
          retryAfter: r.retryAfterSeconds,
        },
      );
    }
  };

  /** The client of a token/revoke request, authenticated per its registered method. */
  const authenticateClient = async (req: FastifyRequest) => {
    const body = req.body as Record<string, unknown>;
    const basic = basicCredentials(req.headers.authorization);
    const bodyId = param(body, 'client_id');
    const bodySecret = param(body, 'client_secret');
    if (basic && bodySecret !== undefined) {
      throw new OAuthError('invalid_request', 'Use one client authentication method', 400);
    }
    const clientId = basic?.id ?? bodyId;
    if (basic && bodyId !== undefined && bodyId !== basic.id) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    const client = await findClient(pool, clientId);
    const fail = () => new OAuthError('invalid_client', 'Client authentication failed', 401);
    if (!client) throw fail();
    const presented = basic?.secret ?? bodySecret;
    if (client.token_endpoint_auth_method === 'none') {
      if (presented !== undefined) throw fail();
      return client;
    }
    if (client.token_endpoint_auth_method === 'client_secret_basic' && !basic) throw fail();
    if (client.token_endpoint_auth_method === 'client_secret_post' && basic) throw fail();
    if (presented === undefined || !client.secret_hash) throw fail();
    if (!safeEqual(sha256(presented).toString('hex'), client.secret_hash.toString('hex'))) {
      throw fail();
    }
    return client;
  };

  const issueTokens = async (
    db: Parameters<typeof insertToken>[0],
    grantId: string,
    scope: string,
  ) => {
    const access = randomToken(ACCESS_TOKEN_PREFIX);
    const refresh = randomToken(REFRESH_TOKEN_PREFIX);
    await insertToken(db, {
      hash: sha256(access),
      grantId,
      kind: 'access',
      ttlSeconds: OAUTH_TTL.accessTokenSeconds,
    });
    await insertToken(db, {
      hash: sha256(refresh),
      grantId,
      kind: 'refresh',
      ttlSeconds: OAUTH_TTL.refreshTokenSeconds,
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: OAUTH_TTL.accessTokenSeconds,
      refresh_token: refresh,
      scope,
    };
  };

  void app.register(async (scope) => {
    // OAuth requests are application/x-www-form-urlencoded (RFC 6749 §4.1.3). Only in this scope:
    // the rest of the API keeps accepting JSON only (CSRF guard).
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT },
      (_req, body, done) => {
        const out: Record<string, string | string[]> = Object.create(null);
        for (const [k, v] of new URLSearchParams(body as string)) {
          const prev = out[k];
          out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
        }
        done(null, out);
      },
    );

    scope.addHook('onRequest', async (_req, reply) => setCors(reply));
    scope.setErrorHandler((err, req, reply) => {
      if (err instanceof OAuthError) {
        const retry = (err as OAuthError & { retryAfter?: number }).retryAfter;
        if (retry) reply.header('retry-after', String(retry));
        if (err.status === 401) reply.header('www-authenticate', 'Basic realm="oauth"');
        return noStore(reply)
          .code(err.status)
          .send({ error: err.error, error_description: err.description });
      }
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', error_description: 'Malformed request' });
      }
      req.log.error({ err }, 'oauth request failed');
      return reply.code(500).send({ error: 'server_error', error_description: 'Internal error' });
    });

    const preflight = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(204).send();
    for (const path of [
      OAUTH_PATHS.protectedResource,
      `${OAUTH_PATHS.protectedResource}${MCP_PATH}`,
      OAUTH_PATHS.authorizationServer,
      OAUTH_PATHS.register,
      OAUTH_PATHS.token,
      OAUTH_PATHS.revoke,
    ]) {
      scope.options(path, preflight);
    }

    // ── Metadata ────────────────────────────────────────────────────────────────────────────
    const prm = protectedResourceMetadata(issuer);
    scope.get(OAUTH_PATHS.protectedResource, async () => prm);
    scope.get(`${OAUTH_PATHS.protectedResource}${MCP_PATH}`, async () => prm);
    const asm = authorizationServerMetadata(issuer);
    scope.get(OAUTH_PATHS.authorizationServer, async () => asm);

    // ── Dynamic Client Registration ─────────────────────────────────────────────────────────
    scope.post(OAUTH_PATHS.register, { bodyLimit: FORM_BODY_LIMIT }, async (req, reply) => {
      await limited(`oauth-register:${req.ip}`, limits.registerPerIp);
      await limited('oauth-register:*', limits.registerGlobal);
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new OAuthError('invalid_client_metadata', 'redirect_uris (1–5 strings) is required');
      }
      const m = parsed.data;
      for (const uri of m.redirect_uris) {
        const problem = redirectUriProblem(uri, cfg.redirectPolicy);
        if (problem) throw new OAuthError('invalid_redirect_uri', `Redirect URI ${problem}`);
      }
      const method = (m.token_endpoint_auth_method ?? 'client_secret_basic') as AuthMethod;
      if (!SUPPORTED_AUTH_METHODS.includes(method)) {
        throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
      }
      const grantTypes = m.grant_types ?? ['authorization_code'];
      if (!grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
        throw new OAuthError('invalid_client_metadata', 'Unsupported grant_types');
      }
      const responseTypes = m.response_types ?? ['code'];
      if (!responseTypes.every((t) => t === 'code')) {
        throw new OAuthError('invalid_client_metadata', 'Unsupported response_types');
      }
      if (m.scope !== undefined && normaliseScope(m.scope) === null) {
        throw new OAuthError('invalid_client_metadata', 'Unsupported scope');
      }
      // Housekeeping rides on registration: it is rate limited and rare.
      await pruneOAuth(pool).catch((err: Error) =>
        req.log.warn({ err: { message: err.message } }, 'oauth prune failed'),
      );
      const secret = method === 'none' ? null : randomToken('urs_');
      const client = await insertClient(pool, {
        name: cleanClientName(m.client_name),
        redirectUris: [...new Set(m.redirect_uris)],
        authMethod: method,
        secretHash: secret ? sha256(secret) : null,
      });
      req.log.info({ clientId: client.id, method }, 'oauth client registered');
      return noStore(reply)
        .code(201)
        .send({
          client_id: client.id,
          client_id_issued_at: Math.floor(client.created_at.getTime() / 1000),
          client_name: client.client_name,
          redirect_uris: client.redirect_uris,
          grant_types: grantTypes,
          response_types: responseTypes,
          token_endpoint_auth_method: method,
          scope: OAUTH_SCOPE,
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        });
    });

    // ── Authorization endpoint ─────────────────────────────────────────────────────────────
    scope.get(OAUTH_PATHS.authorize, async (req, reply) => {
      reply
        .header('x-frame-options', 'DENY')
        .header('content-security-policy', "frame-ancestors 'none'");
      await limited(`oauth-authorize:${req.ip}`, limits.authorizePerIp);
      const q = req.query as Record<string, unknown>;
      // Until client and redirect URI are verified, errors are shown here, never redirected
      // (OAuth 2.1 §4.1.2.1): otherwise /authorize would be an open redirector.
      const client = await findClient(pool, param(q, 'client_id'));
      if (!client) throw new OAuthError('invalid_client', 'Unknown client_id');
      const redirectUri = param(q, 'redirect_uri');
      if (!redirectUri || !redirectUriMatches(client.redirect_uris, redirectUri)) {
        throw new OAuthError('invalid_request', 'redirect_uri is missing or not registered');
      }
      const state = param(q, 'state');
      const back = (error: string, description: string) =>
        reply.redirect(
          withParams(redirectUri, { error, error_description: description, state, iss: issuer }),
          302,
        );
      if (state !== undefined && state.length > MAX_STATE_LENGTH) {
        return back('invalid_request', 'state is too long');
      }
      if (param(q, 'response_type') !== 'code') {
        return back('unsupported_response_type', 'Only response_type=code is supported');
      }
      const challenge = param(q, 'code_challenge');
      const method = param(q, 'code_challenge_method');
      if (!challenge) return back('invalid_request', 'code_challenge is required (PKCE)');
      if (method !== 'S256') {
        return back('invalid_request', 'code_challenge_method must be S256');
      }
      if (!CODE_CHALLENGE_RE.test(challenge)) {
        return back('invalid_request', 'code_challenge is malformed');
      }
      const scopeValue = normaliseScope(param(q, 'scope'));
      if (!scopeValue) return back('invalid_scope', `Only the scope '${OAUTH_SCOPE}' is supported`);
      const resourceIssue = resourceProblem(issuer, param(q, 'resource'));
      if (resourceIssue) return back('invalid_target', resourceIssue);

      const requestId = randomToken();
      await insertAuthRequest(pool, {
        idHash: sha256hex(requestId),
        clientId: client.id,
        redirectUri,
        codeChallenge: challenge,
        state: state ?? null,
        scope: scopeValue,
        resource: canonicalResource,
        ttlSeconds: OAUTH_TTL.requestSeconds,
      });
      // The dashboard signs the user in if needed, then shows the consent screen.
      return reply.redirect(`${CONSENT_PAGE_PATH}?request=${requestId}`, 302);
    });

    // ── Token endpoint ──────────────────────────────────────────────────────────────────────
    scope.post(OAUTH_PATHS.token, { bodyLimit: FORM_BODY_LIMIT }, async (req, reply) => {
      await limited(`oauth-token:${req.ip}`, limits.tokenPerIp);
      if (typeof req.body !== 'object' || req.body === null) {
        throw new OAuthError('invalid_request', 'Body must be application/x-www-form-urlencoded');
      }
      const body = req.body as Record<string, unknown>;
      const client = await authenticateClient(req);
      const grantType = param(body, 'grant_type');
      const resourceIssue = resourceProblem(issuer, param(body, 'resource'));
      if (resourceIssue) throw new OAuthError('invalid_target', resourceIssue);

      if (grantType === 'authorization_code') {
        const code = param(body, 'code');
        if (!code || code.length > 200) throw new OAuthError('invalid_request', 'code is required');
        const result = await withTransaction(pool, async (tx) => {
          const r = await redeemCode(tx, sha256(code));
          if (r.status === 'reused') {
            // OAuth 2.1 §4.1.3: a second redemption may be an attacker with a stolen code;
            // revoke everything the first redemption issued.
            if (r.clientId === client.id) await revokeGrant(tx, r.grantId, 'code_reuse');
            return { error: 'Authorization code was already used' } as const;
          }
          if (r.status === 'invalid')
            return { error: 'Authorization code is invalid or expired' } as const;
          const c = r.code;
          // Bound to client, redirect URI and PKCE challenge. Any mismatch burns the code (it is
          // already marked used) without issuing anything.
          if (c.clientId !== client.id)
            return { error: 'Code was issued to another client' } as const;
          if (param(body, 'redirect_uri') !== c.redirectUri) {
            return { error: 'redirect_uri does not match the authorization request' } as const;
          }
          if (!verifyPkceS256(param(body, 'code_verifier'), c.codeChallenge)) {
            return { error: 'PKCE verification failed' } as const;
          }
          if (c.grantRevoked) return { error: 'Authorization was revoked' } as const;
          await activateGrant(tx, c.grantId);
          return { tokens: await issueTokens(tx, c.grantId, c.scope), grantId: c.grantId } as const;
        });
        if ('error' in result) throw new OAuthError('invalid_grant', result.error!);
        req.log.info({ clientId: client.id, grantId: result.grantId }, 'oauth code exchanged');
        return noStore(reply).send(result.tokens);
      }

      if (grantType === 'refresh_token') {
        const token = param(body, 'refresh_token');
        if (!token || token.length > 200) {
          throw new OAuthError('invalid_request', 'refresh_token is required');
        }
        const requestedScope = param(body, 'scope');
        if (requestedScope !== undefined && normaliseScope(requestedScope) === null) {
          throw new OAuthError('invalid_scope', `Only the scope '${OAUTH_SCOPE}' is supported`);
        }
        const result = await withTransaction(pool, async (tx) => {
          const r = await rotateRefreshToken(tx, sha256(token));
          if (r.status === 'reused') {
            // Rotation + reuse detection (OAuth 2.1 §4.3.1): a rotated-out token came back, so
            // either the client or an attacker holds a copy. Revoke the whole family.
            await revokeGrant(tx, r.grantId, 'refresh_reuse');
            return {
              error: 'Refresh token was already used; authorization revoked',
              reuse: r.grantId,
            } as const;
          }
          if (r.status === 'invalid')
            return { error: 'Refresh token is invalid or expired' } as const;
          const g = r.grant;
          if (g.clientId !== client.id)
            return { error: 'Token was issued to another client' } as const;
          if (g.grantRevoked) return { error: 'Authorization was revoked' } as const;
          if (g.userDisabled) return { error: 'User is disabled' } as const;
          return { tokens: await issueTokens(tx, g.grantId, g.scope), grantId: g.grantId } as const;
        });
        if ('error' in result) {
          if ('reuse' in result) {
            req.log.warn(
              { clientId: client.id, grantId: result.reuse },
              'oauth refresh token reuse: grant revoked',
            );
          }
          throw new OAuthError('invalid_grant', result.error!);
        }
        return noStore(reply).send(result.tokens);
      }

      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    });

    // ── Revocation (RFC 7009) ───────────────────────────────────────────────────────────────
    scope.post(OAUTH_PATHS.revoke, { bodyLimit: FORM_BODY_LIMIT }, async (req, reply) => {
      await limited(`oauth-token:${req.ip}`, limits.tokenPerIp);
      if (typeof req.body !== 'object' || req.body === null) {
        throw new OAuthError('invalid_request', 'Body must be application/x-www-form-urlencoded');
      }
      const client = await authenticateClient(req);
      const token = param(req.body, 'token');
      if (!token) throw new OAuthError('invalid_request', 'token is required');
      if (token.length <= 200) {
        const hash = sha256(token);
        const found = await findTokenGrant(pool, hash);
        // A token of another client is ignored (RFC 7009 §2.1); the answer is 200 either way.
        if (found && found.clientId === client.id) {
          if (found.kind === 'refresh') await revokeGrant(pool, found.grantId, 'client');
          else await deleteToken(pool, hash);
        }
      }
      return noStore(reply).code(200).send();
    });
  });
}
