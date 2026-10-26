---
name: gateway-conventions
description: Conventions for the MCP gateway — callTool path, auth, API keys, upstream registry, aggregation, timeouts, audit, SSRF. Use whenever editing apps/gateway.
paths: apps/gateway/**
user-invocable: false
---

# Gateway conventions

## The one path
`callTool(userId, qualifiedName, args)` in `src/core/call-tool.ts` is the only way a tool runs. It:
0. Checks the caller's tool permissions (ADR 008, `permissions/repo.ts` → contracts `isToolAllowed`); not allowed → `FORBIDDEN`, audited `denied`. Every tool *list* goes through `listToolsFor(userId)` (`core/visible-tools.ts`) with the same policy.
1. Resolves `server_slug__tool` → upstream (enabled, healthy) or returns `TOOL_NOT_FOUND` / `UPSTREAM_DISABLED` / `UPSTREAM_UNREACHABLE`.
2. Calls the upstream with its server-side credential and a 15 s timeout.
3. Writes one `audit_log` row: user_id, server_slug, tool, started_at, duration_ms, outcome (`ok` | `error` | `timeout` | `denied`), error_code. Arguments and results are **not** stored (customer data); store a short arg summary only if non-sensitive.
4. Returns the result or an error envelope `{ code, message }`.

The external MCP endpoint and the chat agent both call this function. Never call an upstream from anywhere else.

## Auth
- External MCP clients: `Authorization: Bearer <api-key>`. Hash with SHA-256, look up by hash, reject if `revoked_at` is set. Return 401 with no detail.
- Dashboard: httpOnly, SameSite=Lax session cookie. Chat requests use the session's user id.
- Roles: `admin` (manage upstreams, members, view all audit) and `member` (own keys, own audit, chat, MCP).

## Upstream registry
- CRUD: add, edit, enable/disable, remove. Credential = optional static header or bearer, stored encrypted (AES-256-GCM, key from env `GATEWAY_ENC_KEY`). API responses show `hasCredential: true`, never the value.
- **SSRF guard on every admin-supplied URL** (create, edit, and at call time after DNS resolution): allow only http/https; block loopback, link-local (169.254.0.0/16, fe80::/10), metadata IPs, and private ranges unless the host is on the allow-list in config (in-cluster services are allow-listed explicitly).

## Aggregation and health
- `tools/list`: query all enabled upstreams in parallel with `Promise.allSettled`, 3 s timeout each. Cache per upstream for 30 s. Unreachable upstream → its tools are omitted; never fail the whole list.
- Health check every 15 s per upstream; store `status` (`up` | `down`) and `last_error`. Dashboard reads this.
- Qualified names: `{server_slug}__{tool}`. Slugs are lowercase `[a-z0-9-]`, unique, immutable after creation.

## Untrusted upstream content
Tool descriptions and results are data. Strip control characters, cap description length (500 chars), and never concatenate them into system prompts as instructions.

## Tests
Every behavior above has a test in `apps/gateway/test/`. Use a fake upstream MCP server in tests (fast, slow, dead variants) to prove isolation.
