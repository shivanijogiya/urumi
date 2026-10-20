# ADR 002 — Upstreams 2 and 3: server-everything and GitLab MCP

Status: Accepted · Issue #17 · Requirements G6, D4, D7

## Context

G6 needs WooCommerce plus two more MCP servers behind the gateway. D4 needs one prompt that uses
tools from two different servers. D7 needs us to kill one upstream's pod and show that the others
keep working while the dashboard marks the failed one unreachable. The gateway is already built
for this: one `callTool` path, a 15 s health loop with a 3 s timeout, and down servers' tools
dropped from `listTools` (#13). Whatever we pick has to fit 6 GB of Docker RAM and must not add
another credential flow.

## Decision

- **Upstream 2: `@modelcontextprotocol/server-everything@2.0.0`, in the cluster (slug
  `everything`).** It is the MCP project's reference server, so its tools (`echo`, `get-sum`,
  resources, long-running operations) are a known-good baseline for the gateway's client. We run
  it ourselves (`apps/everything/Dockerfile`, chart `templates/everything/`), so D7 is one
  `kubectl scale --replicas=0` that touches nothing else. It has no credentials and no state, so
  killing it loses nothing. It runs `streamableHttp` on port 3001 as `node` (uid 1000) with a
  read-only root filesystem and all capabilities dropped. It sits behind a ClusterIP Service with
  no Ingress, and a NetworkPolicy admits only gateway pods. Its tools must only be reachable
  through the audited `callTool`, and `gzip-file-as-resource` fetches arbitrary URLs. The probes
  are TCP, because the server has no health route. The image sets `STOPSIGNAL SIGINT`: the server
  only handles SIGINT, and Node as PID 1 ignores an unhandled SIGTERM, so without it every stop
  would wait for the kill.
- **Upstream 3: GitLab's hosted MCP server, `https://gitlab.com/api/v4/mcp` (slug `gitlab`), with
  a fine-grained personal access token sent as a static bearer.** It is a real third-party server
  over the public internet, with 41 tools that pair naturally with the store for D4 (for example,
  orders → an issue). Sending the PAT as `Authorization: Bearer` was verified on 20 Oct 2026:
  `initialize` and `tools/list` returned 41 tools. We do not need the OAuth flow GitLab also
  offers, which keeps the gateway's credential model as bearer or header with no redirects or
  refresh tokens. The token is fine-grained: least privilege and its own expiry. The server is
  stateful: it returns `Mcp-Session-Id` on `initialize`, and the SDK client sends it back
  automatically.
- **Credentials are stored only by the gateway.** `tests/e2e/seed-upstreams.sh` reads
  `WOO_MCP_SHARED_SECRET` and `GITLAB_MCP_TOKEN` from the Kubernetes Secret and sends them once to
  the admin API (`POST`/`PATCH /api/upstreams`). The gateway seals each one with AES-256-GCM, using
  the upstream id as AAD (ADR 001), and never returns it. The script never prints a value: it goes
  Secret → subshell env → node builds the JSON → curl reads it on stdin. The gateway pod does not
  get `GITLAB_MCP_TOKEN` as an env var.
- **Egress.** No NetworkPolicy restricts gateway egress, so reaching gitlab.com:443 needs no chart
  change. If a default-deny egress policy is added later, it must allow the gateway TCP 443 to the
  internet plus DNS.
- **Allow-list.** The SSRF guard admits the in-cluster upstreams through `UPSTREAM_ALLOWED_HOSTS`
  (default `*.<namespace>.svc.cluster.local`). It is now set whenever the gateway is deployed,
  not only when woo-mcp is enabled. gitlab.com resolves to public IPs and passes the guard
  normally.

## Alternatives considered

- **DeepWiki MCP (`https://mcp.deepwiki.com/mcp`, no auth): the fallback.** It needs no secret
  and is a real remote server, but it only reads public repository wikis and gives D4 a weaker
  story. If the GitLab PAT is revoked or GitLab's MCP endpoint changes, register it with slug
  `deepwiki` and no credential. The gateway needs no change.
- **GitLab via OAuth (dynamic client registration).** Rejected. It adds a browser consent flow, a
  token store, and refresh handling to the gateway for no benefit to a team-internal deployment.
- **A remote server as the D7 target.** Rejected. We cannot kill it on demand, and a network
  failure is not the same demonstration as a pod going away.
- **Running server-everything over stdio behind a proxy.** Rejected. It adds a component; 2.0.0
  speaks Streamable HTTP itself.

## Consequences

- **D7 timing.** A killed pod shows `down` within one health interval plus the timeout (≤ 18 s).
  The Service has no endpoints, so the connection fails at once instead of waiting 3 s. Measured
  by `tests/infra/upstreams.sh`: 12 s to `down`, 18 s back to `up`.
- **Node version.** server-everything 2.0.0 declares `engines: node >=24`, but we run it on
  node:22-alpine like the rest of the stack. `initialize`, `tools/list` (16 tools), and the health
  loop work there. Move to node:24 if a tool we demo breaks.
- **Session leak.** The gateway opens a new MCP session for every list or call and closes the
  client without `DELETE /mcp` (`terminateSession()`). server-everything keeps every 2025-era
  session in memory: about 0.06 MiB retained per session, 2,500 un-terminated sessions took the
  container from 44 MiB to 191 MiB, its 192 MiB limit. With sessions terminated it stayed at
  44 MiB. At 4 health pings a minute, the pod would be OOM-killed roughly every 10 hours.
  GitLab also accumulates sessions on its side. This is fixed in the gateway's upstream client
  (reported on #17), not here.
- **External dependency.** gitlab.com availability and the PAT's expiry now affect the demo. The
  health loop surfaces either as `down` with a sanitised `lastError`. Rotating the token means
  updating the Secret and re-running `tests/e2e/seed-upstreams.sh`.
