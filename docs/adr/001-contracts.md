# ADR 001 — Gateway contracts

Status: accepted · Issue #6 · Requirements G1, G2, G3, T1, T2, T3

## Context

The gateway, dashboard, woo-mcp, and e2e tests are built in parallel. They need one agreed definition of
the HTTP API, the MCP endpoint, the database schema, tool naming, and errors before any of them is
written. ADR 000 already fixed auth, transport, naming, and timeouts; this ADR records how they are
encoded in `packages/contracts`.

## Decision

- **Package.** `@urumi/contracts` exports zod 4 schemas and inferred types from `src/index.ts`. It ships
  TypeScript source with no build step, because every consumer compiles TS (tsc, vitest, Vite).
  Request schemas are strict, so unknown fields fail with `VALIDATION_FAILED`.
- **HTTP API.** `ROUTES` lists every route with its method, path, and auth level
  (`public` | `session` | `admin`). Members can read upstreams, but `url` is sent only to admins.
  Audit queries from members are forced to their own rows. Chat is stateless: the browser resends up
  to 40 messages.
- **Dashboard auth.** Email + scrypt password, httpOnly SameSite=Lax cookie `urumi_session`. The
  `sessions.id` column stores the sha256 of the cookie token. Admins create members and get a one-time
  `tempPassword`. There is no self-signup.
- **API keys.** The secret is `urk_` + base64url(32 random bytes) and is shown once. The database
  stores sha256 (`key_hash`) and an 8-char display `prefix`. Revoking a key sets `revoked_at`.
- **MCP endpoint.** `POST /mcp` is stateless Streamable HTTP with JSON responses and no
  `Mcp-Session-Id`. The bearer key is checked on every request. A bad key gets a 401 with
  `WWW-Authenticate: Bearer` and no detail. GET and DELETE return 405. Timeouts: list 3 s, call 15 s,
  health check every 15 s.
- **Tool names.** `{slug}__{tool}`. Slugs match `^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$`. They cannot
  contain `_`, so splitting on the first `__` is unambiguous. Tool characters outside
  `[a-zA-Z0-9_-]` become `_`. If a name is over 64 chars, the tool part is truncated and suffixed with
  `_` + 6 hex chars of sha256(original). The gateway maps qualified → original names and never
  reverses sanitization.
- **Errors.** Every error is `{ error: { code, message, requestId? } }`, with a fixed code → HTTP status
  table. Messages never contain URLs, credentials, or raw upstream text.
- **Upstream credentials.** Credentials are bearer or a custom header. Header names must be RFC 7230
  tokens and cannot be headers the gateway controls (Host, Content-Length, Content-Type, `Mcp-*`, …).
  Values cannot contain CR/LF/NUL. The value is stored with AES-256-GCM (ciphertext, iv, and tag
  columns) and is never returned: `UpstreamSchema` is strict.
- **Database.** `sql/001_init.sql` creates `users`, `sessions`, `api_keys`, `upstreams`, and
  `audit_log`. A CHECK keeps the credential columns consistent with `credential_type`. The migration
  runner (#11) owns `schema_migrations(version text pk, applied_at timestamptz default now())`.
- **Audit.** One row per `callTool` stores the user, key (MCP) or source, server, tool, start time,
  duration, outcome, and error code. Arguments and results are not stored. Unauthenticated requests are
  not audited because they have no user; they are logged as HTTP 401.

## Alternatives considered

- **Stateful MCP sessions (`Mcp-Session-Id`).** Rejected. We would need session storage and sticky
  routing, and session state could survive a key revocation. Stateless requests re-check the key every
  time.
- **JWT instead of DB sessions.** Rejected. A JWT cannot be revoked before it expires, so disabling a
  user would not take effect immediately. A DB session lookup costs one indexed query.
- **Storing tool arguments and results in the audit log.** Rejected. They hold customer data (orders,
  addresses), which would make the audit log a second store of personal data.
- **`.` or `/` as the separator.** Rejected. Claude tool names must match `^[a-zA-Z0-9_-]{1,64}$`.

## Consequences

- There is no `notifications/tools/list_changed` push (stateless). Clients see a disabled server's
  tools disappear (D6) the next time they list tools.
- Slugs are immutable after creation (`UpdateUpstreamRequestSchema` rejects `slug`) because they are part
  of every tool name and audit row.
- Sanitizing can make two upstream tools on the same server collide (`foo.bar` and `foo_bar`). The
  gateway must detect duplicate qualified names when it builds its map and drop or flag the second one.
- Contracts change only through this package. Changing a schema is a reviewed, cross-team change.
