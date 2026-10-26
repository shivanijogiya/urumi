# ADR 008 — Tool permissions: per-role and per-user rules, enforced on the one call path

Status: accepted, merged to `main` (was proposed: needs Aadi: new table, new admin API, default policy changes what members can do)
· Brief stand-out item 2 ("Tool permissions") · Amends DESIGN §7 (roles) and THREAT_MODEL 3.5/3.7

## Context

Until now every signed-in user — admin or member — saw and could call every tool of every enabled
upstream, including store writes (`woo__create_product`, `woo__update_order_status`), GitLab
writes and server-everything's `get-env` (prints that server's environment). The brief asks for
"per-role or per-user control over which servers and tools are allowed … members can read orders
but only admins can create products or change order status. The restricted tools are hidden from
the tool list and rejected if called directly."

Constraints: one code path (every call is `callTool(userId, …)`, which writes the audit row); the
chat agent and external MCP clients must see the same tool set; the dashboard needs to show the
effect of a rule before an admin relies on it.

## Decision

**Model** (`packages/contracts/sql/002_tool_permissions.sql`). One table `tool_permissions`:
subject = a role (`admin` | `member`) **or** one user (`user_id`, cascade on delete) × server
(`slug` or `*`) × tool pattern (`*`, `prefix*`, or the exact tool part of `{slug}__{tool}`) ×
effect (`allow` | `deny`). Unique per (subject, server, tool); the admin API upserts on that key.

**Evaluation** (`packages/contracts/src/permissions.ts`, `isToolAllowed`, pure and browser-safe):

1. the user's own matching rules, if any, decide (overrides in both directions);
2. otherwise the role's matching rules decide;
3. otherwise **deny**.

Within a level the most specific rule wins: exact server beats `*`; then exact tool > longer prefix

> shorter prefix > `*`. Deny wins a tie. The same function runs in the gateway (enforcement) and
> the dashboard (preview), so the preview cannot drift from what is enforced.

**Default policy** (seeded by the migration, editable at runtime):

| Role   | Allowed                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| admin  | `*` / `*` — everything                                                                                                                                                                                                                                                          |
| member | woo: `list_products`, `list_orders`, `get_order` · everything: `echo`, `get-sum`, `get-tiny-image`, `get-annotated-message`, `get-structured-content`, `get-resource-links`, `get-resource-reference` · gitlab: `get_*`, `list_*`, `search`, `search_labels`, `semantic_search` |

Everything else is denied to members by default: store writes, everything's `get-env`,
`get-header-params` and trigger/toggle tools, GitLab write tools, and **every tool of a newly
added upstream** (admin-only until an admin grants it). Default-deny was chosen over
default-allow so that adding an upstream never silently widens what members can do.

**Enforcement — one place per direction:**

- _Listing_: `createListToolsFor(pool, registry)` (`apps/gateway/src/core/visible-tools.ts`)
  filters the registry aggregate by the caller's policy. MCP `tools/list`, the chat agent's tool
  set, `GET /api/tools` and `GET /api/upstreams/:id/tools` all use it.
- _Calling_: `callTool` loads the caller's policy right after parsing the name and before
  resolving or contacting the upstream. A denied call throws `FORBIDDEN` (HTTP 403 for REST; an
  `isError` tool result with the contracts envelope over MCP; `is_error` tool_result in chat), and
  the audit hook records it with outcome `denied`, error `FORBIDDEN`. The message names the tool
  only if it is a well-formed tool name (the caller's own input), never anything else.
- The policy is read from Postgres per request (one indexed join, a handful of rows), never cached,
  so a rule change applies on the next `tools/list` / `tools/call` / chat turn. Disabled or
  unknown users get deny-all.

**Admin API** (contracts `ROUTES`, all `admin`): `GET /api/permissions`, `POST /api/permissions`
(upsert, strict schema, exactly one of `role` / `userId`), `DELETE /api/permissions/:id`.
Dashboard: **Permissions** page (admins only) with the rule table, an add-rule form and an
"Effective access" preview per role or user.

**E2E**: D2 has User A (a member) create a product through chat, so `tests/e2e/seed.sh` grants A a
per-user `allow woo create_product` — the per-user override path, exercised on every run. New
step D9 (`tests/e2e/d9-permissions.sh`) proves: B's `tools/list` hides `woo__create_product` and
`woo__update_order_status`; B's direct call returns `FORBIDDEN` and is audited as `denied`; the
admin sees the tool and its call succeeds (audited `ok`).

## Consequences

- Members lose write tools and `everything__get-env` by default. Anyone relying on a member
  creating products must get a per-user grant (as User A does in the e2e seed).
- One extra small query per `tools/list` and per `tools/call`.
- Rules match the _sanitised_ tool part shown in `tools/list`, which is what admins see.
- Test suites that are not about permissions start with a member `* *` allow rule
  (`apps/gateway/test/helpers/app.ts`, `toolPermissions: 'open'`); `test/permissions.test.ts`
  runs against the seeded default.
- Rollback: an older gateway image ignores the table; the migration is additive.

## Not done

- Per-API-key scopes (a key carries its user's policy).
- Admin edits to rules are logged (`tool permission set`) but not written to an audit table.
- No "confirm before write" step in chat; write tools are simply absent for members.
