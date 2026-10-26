# ADR 013 — OAuth 2.1 sign-in for MCP clients (the gateway as Authorization Server)

Status: accepted, merged to `main` (was proposed: needs Aadi: new public endpoints on the app host, new tables, a second way to
authenticate /mcp) · Brief stand-out item 3 ("OAuth on the gateway") · Builds on ADR 008
(permissions), 010 (replicas, Postgres buckets), 012 (discovery mode)

## Context

MCP clients reach `/mcp` with a per-user API key (`urk_…`) that a member creates in the dashboard
and pastes into the client's config. That works, but it is a long-lived bearer secret in a config
file, it is not how current MCP clients expect to connect, and nothing tells a member which apps
hold their keys. The MCP Authorization spec (revision 2025-06-18, unchanged in its essentials in
2025-11-25) lets a client start from just the server URL: the server answers 401 with
`WWW-Authenticate: Bearer resource_metadata=…`, the client discovers the authorization server
(RFC 9728 → RFC 8414), registers itself (RFC 7591), and runs OAuth 2.1 authorization code + PKCE
with a `resource` indicator (RFC 8707). Claude Code, Cursor, VS Code and MCP Inspector all do this.

## Decision

**The gateway is both the Authorization Server (AS) and the Resource Server (RS).** The issuer is
`PUBLIC_ORIGIN` (`http://app.localtest.me` locally); the protected resource is
`PUBLIC_ORIGIN + /mcp`. Users sign in with the existing dashboard login; there is no new
identity store and no external IdP.

| Endpoint                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource` (and `…/mcp`)             | RFC 9728: resource, `authorization_servers: [issuer]`, `scopes_supported: [mcp]`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /.well-known/oauth-authorization-server`                         | RFC 8414: endpoints, `code_challenge_methods_supported: [S256]`, `grant_types: [authorization_code, refresh_token]`, auth methods `none` / `client_secret_post` / `client_secret_basic`, `authorization_response_iss_parameter_supported`                                                                                                                                                                                                                                                                                              |
| `POST /oauth/register`                                                | RFC 7591 DCR. Redirect URIs: `https://…`, or `http://` on `localhost` / `127.0.0.1` / `[::1]` (any port); private-use schemes only if the operator lists them (`gateway.oauth.extraRedirectSchemes`, e.g. `cursor`). No fragments, userinfo, `javascript:`/`data:`/`file:`. Public clients get no secret; confidential ones get a secret stored as SHA-256. Rate limited per IP (burst 10, 1/min) and globally (burst 100, 10/min) with the Postgres token buckets of ADR 010. Clients that never got a grant are deleted after a day. |
| `GET /oauth/authorize`                                                | Unknown `client_id` or a `redirect_uri` not registered for it → 400, **never a redirect**. Then: `response_type=code` only; `code_challenge` + `code_challenge_method=S256` required (plain or missing → `invalid_request`); `scope` ⊆ {`mcp`}; `resource`, if given, must be the gateway's MCP URL (→ `invalid_target`); `state` passed through. Loopback redirect URIs may change port (RFC 8252 §7.3). Stores a pending request (10 min) and redirects to the dashboard's `/consent?request=<id>`. `X-Frame-Options: DENY`.         |
| dashboard `/consent` + `GET/POST /api/oauth/requests/:id`             | The SPA signs the user in if needed (login returns to the consent page), shows the client's name **marked as unverified**, the redirect host, and what it can do; **Approve** / **Deny**. The GET binds the request to the signed-in user and issues a one-time consent token; the POST must echo it.                                                                                                                                                                                                                                  |
| `POST /oauth/token`                                                   | `authorization_code`: the code is single use (60 s), bound to client, redirect URI and PKCE challenge; any mismatch burns it; a **second redemption revokes everything the first one issued**. `refresh_token`: rotated on every use; a **rotated-out token coming back revokes the whole family** (grant). Access tokens live 1 h, refresh tokens 30 days.                                                                                                                                                                            |
| `POST /oauth/revoke`                                                  | RFC 7009; revoking a refresh token revokes its grant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| dashboard **Connected apps** + `GET/DELETE /api/connected-apps[/:id]` | Members see and disconnect their own grants; admins see and disconnect everyone's. Disconnect deletes the grant's tokens: the next `/mcp` request is 401 on every replica.                                                                                                                                                                                                                                                                                                                                                             |

**Tokens are opaque**, 32 random bytes (`uat_…` access, `urt_…` refresh), and like API keys only
their SHA-256 is stored (`oauth_tokens.token_hash`); codes, pending-request ids, consent tokens and
client secrets too. No JWTs: every request already hits Postgres for permissions, revocation must
be immediate, and there is no third-party RS that would need to verify offline.

**One call path.** `/mcp` accepts `Bearer urk_…` (API key) or `Bearer uat_…` (access token). Both
resolve to a user; the request then goes through exactly the same code: `listToolsFor` (ADR 008)
for `tools/list`, `callTool` for `tools/call` (permissions, timeouts, metrics, audit), per-user
rate limit, plus a per-credential bucket (`key:<api key id>` or `key:oauth:<grant id>`). A token is
accepted only if not expired, its grant is not revoked, its user is enabled, and its audience
(`resource`) is this gateway's MCP URL. The 401 always carries
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`
(and `error="invalid_token"` if a credential was sent).

**Attribution.** `audit_log.oauth_grant_id` (nullable, `CHECK (api_key_id IS NULL OR
oauth_grant_id IS NULL)`). The audit API returns `authMethod` (`api_key` | `oauth` | `session`)
and `oauthClientName`; the Audit page shows "mcp · OAuth: Claude Code".

**Replicas.** All state is in Postgres (`005_oauth.sql`: `oauth_clients`, `oauth_auth_requests`,
`oauth_grants`, `oauth_codes`, `oauth_tokens`). Single-use values are consumed with one conditional
`UPDATE … RETURNING` / `DELETE … RETURNING`, so two replicas racing on the same code or refresh
token cannot both win. Rate limits use the shared buckets.

**Exposure.** The app Ingress (and the canary IngressRoute) now also routes `/oauth` and exactly
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` to the
gateway, on the same host and port as `/api` and `/mcp`. No new Service, port or NetworkPolicy
rule: the existing Traefik → gateway allow covers it.

**CSRF and clickjacking.** `/oauth/register`, `/oauth/token`, `/oauth/revoke` read no cookie, so
they are exempt from the CSRF guard and answer CORS `*` (browser-based clients like Inspector call
them cross-origin). The consent decision is a cookie route: JSON body + `Origin` = `PUBLIC_ORIGIN`
(global guard) + `SameSite=Lax` + the one-time consent token bound to the request and user. The
dashboard (consent page included) is served with `frame-ancestors 'none'` and
`X-Frame-Options: DENY`; `/oauth/authorize` sets both too. The login page's `next` parameter only
accepts `/consent?request=<43 chars>`.

### Why not the SDK's auth server helpers

`@modelcontextprotocol/sdk` 1.32.1 ships `mcpAuthRouter`, `requireBearerAuth` and
`ProxyOAuthServerProvider`. They are **Express** routers/middleware; the gateway is Fastify, so
using them means adding Express (`@fastify/express`) in front of the most security-sensitive
routes. The provider interface would still leave storage, consent, code/refresh reuse detection
and revocation to us, and `ProxyOAuthServerProvider` assumes an upstream AS we do not have. We
reuse what fits without Express: the SDK's metadata **types** (`OAuthMetadata`,
`OAuthProtectedResourceMetadata`) for both documents and `checkResourceAllowed` for RFC 8707, and
we test the whole flow with the **SDK client's own OAuth implementation**
(`test/oauth-sdk.test.ts`, e2e D13).

## Consequences

- API keys keep working unchanged; OAuth is an alternative, not a replacement. Both are visible
  and revocable by the member (My keys, Connected apps) and by admins.
- Tests: `test/oauth-unit.test.ts` (PKCE S256 incl. RFC 7636 vector, plain refused; redirect URI
  registration and loopback-port matching; resource and scope), `test/oauth.test.ts` (metadata,
  401 header, CORS, DCR validation and rate limit, `/authorize` error handling without open
  redirects, consent binding/CSRF/Deny/single use, code single use + reuse revocation, PKCE /
  redirect / client binding, 60 s expiry, resource mismatch, refresh rotation + reuse detection,
  expired access token, `/mcp` = same permissions + audit attribution, disabled user, connected
  apps for members and admins, RFC 7009), `test/oauth-sdk.test.ts` (SDK client end to end),
  dashboard `test/oauth.test.tsx`. e2e **D13** on k3d through the Ingress.
- Scope is a single `mcp`: what a client may do is exactly what its user may do (ADR 008). Finer
  scopes (read-only tokens) would be a later change.
- Consent phishing remains possible in principle (an attacker registers "Claude Code" with their
  own https redirect and sends a member the link); the consent screen shows the redirect host and
  says the name is unverified, the grant is visible in Connected apps, and every call is audited
  with the client's name. See THREAT_MODEL.
- Locally the issuer is plain `http://app.localtest.me` (OAuth 2.1 wants https outside loopback);
  production uses `https://` via `publicOrigin` + TLS, as for the session cookie.
- Not done: Client ID Metadata Documents (the 2025-11-25 alternative to DCR), token
  introspection, per-client admin policy (allow-listing clients), refresh-token binding (DPoP).
- Cursor's redirect URI uses the private-use scheme `cursor://`; it is refused unless the operator
  sets `gateway.oauth.extraRedirectSchemes: [cursor]`.
