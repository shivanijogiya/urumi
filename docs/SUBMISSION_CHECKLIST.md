# Submission checklist

Every requirement ID in [`REQUIREMENTS.md`](REQUIREMENTS.md), mapped to the code that implements it,
the test that proves it and the document that explains it. Paths are relative to the repository
root; gateway tests live in `apps/gateway/test/`, dashboard tests in `apps/dashboard/test/`.
`Dn` = `tests/e2e/run.sh Dn` on the local k3d cluster. "Video" points at the narration scene; the
scene numbers are filled in after recording.

## Kubernetes / Helm (K)

| ID  | Implemented in                                                                                                        | Proven by                                                                                                   | Doc                                        | Video                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------- |
| K1  | `scripts/cluster-up.sh` (k3d `urumi`, registry, namespace, Secret)                                                    | no dedicated test; every e2e and `tests/infra` cluster check runs on the cluster it creates                 | README "Zero to running"                   | see NARRATION scene N (TBD) |
| K2  | `charts/platform`, `values.yaml`, `values-local.yaml`, `values-prod.yaml`                                             | `tests/infra/chart-checks.sh` (renders both values files); CI `release:chart:package` (helm lint + package) | README "Local → VPS", DESIGN §10           | see NARRATION scene N (TBD) |
| K3  | `charts/platform/templates/{wordpress,mariadb,woo-mcp,gateway,postgres,dashboard,everything,bootstrap}/`              | `tests/infra/gateway-db.sh`, `store-bootstrap.sh`; D1–D8 run only against in-cluster workloads              | README "Architecture", DESIGN §10          | see NARRATION scene N (TBD) |
| K4  | StatefulSet `volumeClaimTemplates` (MariaDB, Postgres), `templates/wordpress/pvc.yaml` (`resource-policy: keep`)      | `tests/infra/persistence.sh` (MariaDB + wp-content), `tests/infra/gateway-db.sh` (Postgres pod deleted)     | README "Upgrades and rollback", DESIGN §12 | see NARRATION scene N (TBD) |
| K5  | `templates/app/ingress.yaml`, `templates/wordpress/ingress.yaml`; probes + resources in every template, `values.yaml` | `tests/infra/chart-checks.sh` (probes, requests, limits), `scripts/smoke-ingress.sh`                        | DESIGN §10                                 | see NARRATION scene N (TBD) |
| K6  | `scripts/gen-env.sh`, `scripts/secrets-apply.sh`, `.gitignore` (`.env.*`); chart only references Secrets              | `tests/infra/env-scripts.test.sh`; `chart-checks.sh` (no rendered `Secret`); CI `secret_detection`          | THREAT_MODEL 3.4 "Secrets in git"          | see NARRATION scene N (TBD) |

## WooCommerce MCP server (W)

| ID  | Implemented in                                                                                                             | Proven by                                                                                                       | Doc                                   | Video                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------- |
| W1  | `apps/woo-mcp/` (dependencies: MCP SDK, contracts, zod only)                                                               | `apps/woo-mcp/package.json`; review                                                                             | DESIGN §4                             | see NARRATION scene N (TBD) |
| W2  | `apps/woo-mcp/src/server.ts`, `src/tools/` (five tools), `src/woo-client.ts`                                               | `apps/woo-mcp/test/tools/*.test.ts` (incl. `contract.test.ts`), `server.test.ts`, `woo-client.test.ts`          | DESIGN §4                             | see NARRATION scene N (TBD) |
| W3  | ClusterIP `templates/woo-mcp/service.yaml`, `templates/woo-mcp/networkpolicy.yaml`, shared-secret check in `src/server.ts` | `tests/infra/woo-mcp-netpol.sh`, `tests/infra/netpol-default-deny.sh`; `apps/woo-mcp/test/server.test.ts` (401) | THREAT_MODEL 3.1, NETWORK_POLICIES.md | see NARRATION scene N (TBD) |
| W4  | `charts/platform/files/bootstrap/` (Application Password), `apps/woo-mcp/src/woo-client.ts`                                | `tests/infra/store-bootstrap.sh`                                                                                | DESIGN §4                             | see NARRATION scene N (TBD) |

## Gateway (G)

| ID  | Implemented in                                                                                             | Proven by                                                                        | Doc                   | Video                       |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------- | --------------------------- |
| G1  | `apps/gateway/src/upstreams/routes.ts`, dashboard `pages/Upstreams.tsx`                                    | `upstreams.test.ts`, dashboard `upstreams.test.tsx`; D6                          | DESIGN §8, ADR 001    | see NARRATION scene N (TBD) |
| G2  | `apps/gateway/src/mcp/endpoint.ts`, `core/registry.ts`, `core/call-tool.ts`                                | `aggregation.test.ts`, `mcp-endpoint.test.ts`; D3                                | DESIGN §2             | see NARRATION scene N (TBD) |
| G3  | `packages/contracts/src/naming.ts`, `apps/gateway/src/core/registry.ts`                                    | `packages/contracts/test/naming.test.ts`, `aggregation.test.ts`                  | DESIGN §5, ADR 001    | see NARRATION scene N (TBD) |
| G4  | `core/registry.ts` (`allSettled`), `core/health.ts`, `mcp-client/upstream-client.ts` (3 s / 15 s)          | `aggregation.test.ts`, `health.test.ts`; `tests/infra/upstreams.sh`; D7          | DESIGN §6             | see NARRATION scene N (TBD) |
| G5  | `crypto/secretbox.ts`, `upstreams/decrypt-for-call.ts`, strict `UpstreamSchema`, log redaction `server.ts` | `secretbox.test.ts`, `upstreams.test.ts` (no credential in responses or logs)    | DESIGN §8, THREAT 3.4 | see NARRATION scene N (TBD) |
| G6  | `tests/e2e/seed-upstreams.sh` (woo, everything, gitlab), `apps/everything/Dockerfile`                      | seed step ("all three up"), `tests/infra/upstreams.sh`; D3 (lists all three), D4 | ADR 002               | see NARRATION scene N (TBD) |

## Team, keys, audit (T)

| ID  | Implemented in                                                                       | Proven by                                                                                    | Doc                   | Video                       |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------- | --------------------------- |
| T1  | `auth/session.ts` (`requireAdmin`), `users/routes.ts`, dashboard `pages/Members.tsx` | `auth.test.ts`, `users.test.ts`, dashboard `members.test.tsx`; `tests/infra/gateway-auth.sh` | DESIGN §7             | see NARRATION scene N (TBD) |
| T2  | `auth/api-keys.ts`, `keys/`, dashboard `pages/Keys.tsx`                              | `keys.test.ts`, dashboard `keys.test.tsx`; D5                                                | DESIGN §7, THREAT 3.1 | see NARRATION scene N (TBD) |
| T3  | `core/call-tool.ts` → `audit/hook.ts` → `audit/repo.ts`, dashboard `pages/Audit.tsx` | `audit.test.ts`, dashboard `audit.test.tsx`; D8                                              | DESIGN §9             | see NARRATION scene N (TBD) |

## Chat agent (C)

| ID  | Implemented in                                                                                               | Proven by                                                       | Doc                             | Video                       |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------- | --------------------------- |
| C1  | `apps/gateway/src/chat/service.ts`, `chat/routes.ts`, dashboard `pages/Chat.tsx`                             | `chat.test.ts`, dashboard `chat.test.tsx`; D2, D4               | DESIGN §2 "Chat"                | see NARRATION scene N (TBD) |
| C2  | `chat/service.ts` calls `callTool(sessionUser.id, …, { source: 'chat' })`                                    | `chat.test.ts` (audit row under the session user); D8           | DESIGN §2                       | see NARRATION scene N (TBD) |
| C3  | `ANTHROPIC_API_KEY` from Secret `urumi-env` (`templates/gateway/_pod.tpl`), `config.ts`, `chat/anthropic.ts` | `chat.test.ts` ("ANTHROPIC_API_KEY handling"), `config.test.ts` | THREAT_MODEL 3.4 "LLM key leak" | see NARRATION scene N (TBD) |

## Demo flows (D)

| ID  | Script                               | What it proves                                                         | Doc                       | Video                       |
| --- | ------------------------------------ | ---------------------------------------------------------------------- | ------------------------- | --------------------------- |
| D1  | `tests/e2e/d1-store-checkout.sh`     | Store API checkout (COD) visible through the admin REST API            | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D2  | `tests/e2e/d2-chat-product-order.sh` | chat creates a product; "orders today" returns the placed order        | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D3  | `tests/e2e/d3-mcp-client.sh`         | MCP SDK client with User B's key lists tools, calls `woo__list_orders` | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D4  | `tests/e2e/d4-chat-two-upstreams.sh` | one chat prompt calls `everything` and `woo`                           | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D5  | `tests/e2e/d5-revoke-key.sh`         | revoked key → 401 on the next call                                     | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D6  | `tests/e2e/d6-disable-upstream.sh`   | disabled upstream's tools leave MCP and chat tool sets; re-enable      | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D7  | `tests/e2e/d7-upstream-down.sh`      | `everything` scaled to 0 → `down`; `woo` keeps working                 | README "Demo walkthrough" | see NARRATION scene N (TBD) |
| D8  | `tests/e2e/d8-audit.sh`              | every D2–D7 call audited under the right user, source, tool            | README "Demo walkthrough" | see NARRATION scene N (TBD) |

## Stand-out and bonus features

| Feature                                                 | Implemented in                                                                                                                 | Proven by                                                                                                    | Doc                                        | Video                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------- |
| Tool permissions                                        | `packages/contracts/src/permissions.ts`, `apps/gateway/src/permissions/`, `core/visible-tools.ts`, dashboard `Permissions.tsx` | `permissions.test.ts` (gateway + contracts), dashboard `permissions.test.tsx`; D9                            | ADR 008, DESIGN §7                         | see NARRATION scene N (TBD) |
| Default-deny NetworkPolicies, non-root WordPress        | `charts/platform/templates/networkpolicy/`                                                                                     | `tests/infra/netpol-default-deny.sh`, `chart-checks.sh`                                                      | ADR 009, NETWORK_POLICIES.md               | see NARRATION scene N (TBD) |
| Scaling: 2 replicas, `/mcp` rate limits, health lease   | `gateway.replicas`, `templates/gateway/pdb.yaml`, `apps/gateway/src/ratelimit/`, `core/leader.ts`                              | `ratelimit.test.ts`, `leader.test.ts`; D10                                                                   | ADR 010, DESIGN §10                        | see NARRATION scene N (TBD) |
| Observability: `/metrics`, failure reasons, Health page | `apps/gateway/src/metrics/`, `packages/contracts/src/failures.ts`, `templates/gateway/metrics.yaml`, dashboard `Health.tsx`    | `observability.test.ts`, contracts `failures.test.ts`, dashboard `health.test.tsx`; D11                      | ADR 011, DESIGN §10                        | see NARRATION scene N (TBD) |
| Discovery mode (many tools)                             | `apps/gateway/src/discovery/`                                                                                                  | `discovery.test.ts`, `discovery-search.test.ts`; D12 (142 tools)                                             | ADR 012, DESIGN §5                         | see NARRATION scene N (TBD) |
| OAuth 2.1 for MCP clients                               | `apps/gateway/src/oauth/`, dashboard `Consent.tsx`, `ConnectedApps.tsx`                                                        | `oauth.test.ts`, `oauth-unit.test.ts`, `oauth-sdk.test.ts`, dashboard `oauth.test.tsx`; D13                  | ADR 013, DESIGN §7, THREAT 3.8             | see NARRATION scene N (TBD) |
| Hosted MCP servers                                      | `apps/gateway/src/hosted/`, `charts/platform/templates/hosted/`, dashboard `HostedServers.tsx`                                 | `hosted.test.ts`, `hosted-unit.test.ts`, dashboard `hosted.test.tsx`, `tests/infra/hosted-chart.sh`; D14     | ADR 014, THREAT 3.9                        | see NARRATION scene N (TBD) |
| Multi-store provisioning                                | `apps/gateway/src/stores/`, `charts/platform/templates/stores/`, dashboard `Stores.tsx`                                        | `stores.test.ts`, `stores-unit.test.ts`, dashboard `stores.test.tsx`, `tests/infra/stores-chart.sh`; D15     | ADR 015, THREAT 3.10                       | see NARRATION scene N (TBD) |
| Upgrades and rollback                                   | one Helm release, idempotent bootstrap hook, additive `packages/contracts/sql/` migrations                                     | recorded `helm rollback` (README); canary promote/rollback in CI                                             | README "Upgrades and rollback", DESIGN §12 | see NARRATION scene N (TBD) |
| VPS deployment                                          | `charts/platform/values-prod.yaml`                                                                                             | `tests/infra/chart-checks.sh` renders it; **never deployed** (see below)                                     | README "Local → VPS"                       | see NARRATION scene N (TBD) |
| Release pipeline (H1)                                   | `.gitlab-ci.yml`, `.gitlab/ci/release.gitlab-ci.yml`                                                                           | `.gitlab/ci/tests/*.test.sh` (CI `release:config-tests`)                                                     | `.gitlab/ci/README.md`                     | see NARRATION scene N (TBD) |
| Canary + verdict (H2)                                   | `.gitlab/ci/canary.gitlab-ci.yml`, `scripts/canary/verdict.py`, `run.sh`, `ci.sh`                                              | `scripts/canary/test_*.py` (CI `canary:unit-tests`), gateway `canary.test.ts`, `tests/infra/canary-chart.sh` | ADR 003, ADR 005                           | see NARRATION scene N (TBD) |
| Duo flows: risk gate, incident, postmortem (H3, H4)     | `.gitlab/flows/*.yaml`, `.gitlab/ci/duo-dispatch.gitlab-ci.yml`, `scripts/canary/risk.py`                                      | `.gitlab/flows/tests/flows.test.sh`, `duo-dispatch.test.sh`; project history (README table)                  | ADR 004, ADR 007, HACKATHON.md             | see NARRATION scene N (TBD) |

Requirement IDs with no automated test of their own: **K1** (exercised by every cluster run) and
**W1** (a source-review property). W4 and the design-only parts of G3 are document requirements.

## Known limitations / not done

- **VPS deployment not performed.** `charts/platform/values-prod.yaml` exists and sets placeholder
  hosts `store.example.com` / `app.example.com`, TLS Secret names (off until a certificate
  exists), `gateway.publicOrigin: https://app.example.com`, `cookieSecure: true`,
  `bootstrap.environmentType: production`, `wooMcp.forwardedProto: https`, 5 Gi volumes on the
  default StorageClass, `registry.gitlab.com/<group>/<project>/…` images, 2 gateway replicas,
  hosted servers with a registry-only allow-list and `requireDigest: true`, and
  `multiStore.enabled: false`. Only rendering is tested; TLS, cert-manager/ACME and a remote
  registry pull are not.
- **Real third-party OAuth sign-in** (Claude Code, MCP Inspector, Cursor) was not run in the
  automated checks; the OAuth flow is tested with the official MCP SDK client only
  (`oauth-sdk.test.ts`, D13).
- **Multi-store has no backups or HA**: one MariaDB and one WordPress per store, `local-path`
  volumes, no backup before delete (THREAT_MODEL 3.10). The same holds for the built-in store and
  Postgres: no scheduled backup in the chart (DESIGN §12).
- **CI does not run the e2e flows or the `tests/infra` cluster checks**; they run on the local
  cluster. The CI canary runs the seed and the verdict only.
- Upstream MCP sessions are not terminated (`DELETE`); server-everything's memory grows until a
  restart (DESIGN §11).
- Open security gaps listed in THREAT_MODEL §4: no confirmation for write tools in chat, response
  bodies buffered before the size cap, login throttle and chat limit per replica, mutable audit
  log, plain Kubernetes Secrets, no FQDN egress filtering, no Pod Security label on the release
  namespace, hosted-image allow-list enforced by the gateway rather than admission control.
