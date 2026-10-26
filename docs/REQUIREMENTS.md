# Requirements

Single source of requirement IDs for the Urumi MCP Gateway and the GitLab Transcend entry.
Source: the Urumi FDE assignment (analysed in `docs/ASSIGNMENT_ANALYSIS.md`) and the hackathon brief.
Every issue, MR, test, and e2e step refers to these IDs.

**Status legend:** ☐ not started · ◐ in progress · ☑ verified (evidence linked in the closing MR)

**Verification types:** `unit` = package test suite · `contract` = schema/type test in `packages/contracts` ·
`e2e:Dn` = `tests/e2e/run.sh Dn` on local k3d · `k8s` = kubectl/helm assertion in e2e or CI · `doc` = reviewed document

---

## 1. Kubernetes / Helm (K)

| ID  | Requirement                                                        | Acceptance test                                                                                                                                           | Verify   | Issues            |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------- |
| K1  | Runs on local Kubernetes                                           | `scripts/cluster-up.sh` creates a k3d cluster idempotently; `helm upgrade --install` brings every pod Ready                                               | k8s      | #3                |
| K2  | One Helm chart for local and VPS; differences only in values files | `charts/platform` + `values-local.yaml` + `values-prod.yaml`; `helm template` succeeds for both; no Kustomize                                             | k8s, doc | #2, #4, #25, #26  |
| K3  | Everything runs in the cluster                                     | Store, MariaDB, woo-mcp, gateway, Postgres, dashboard, server-everything are all chart workloads                                                          | k8s      | #4, #10, #11, #17 |
| K4  | Store data persists                                                | Delete WordPress + MariaDB pods (and Postgres pod) → products, orders, users still present                                                                | k8s      | #4, #11           |
| K5  | Ingress at stable URLs; probes + requests/limits on every workload | `store.localtest.me`, `app.localtest.me` answer; a CI check fails if any container lacks liveness, readiness, requests, or limits                         | k8s      | #3, #4, #10       |
| K6  | No hardcoded secrets                                               | All credentials come from Kubernetes Secrets created from gitignored `.env.local`; Secret Detection job green; `git grep` for known secret patterns empty | k8s, CI  | #3, #5, #22       |

## 2. WooCommerce MCP server (W)

| ID  | Requirement                                                                                                 | Acceptance test                                                                                                                                                                     | Verify         | Issues     |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- |
| W1  | Our own MCP server (no existing Woo MCP plugin/server)                                                      | Source in `apps/woo-mcp`, depends only on the official MCP SDK + HTTP client                                                                                                        | doc            | #7         |
| W2  | Streamable HTTP; tools `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` | `tools/list` returns exactly these five with zod input schemas; unit tests per tool for valid/invalid input, 401/404/timeout mapping                                                | unit, contract | #7, #8, #9 |
| W3  | Not reachable from outside the cluster; only the gateway may call it                                        | ClusterIP Service, no Ingress; NetworkPolicy allows ingress only from gateway pods; a curl pod without the gateway label times out; requests without the shared-secret header → 401 | k8s, unit      | #7, #10    |
| W4  | Document the store connectivity choice                                                                      | DESIGN.md explains WooCommerce REST API + Application Password vs WP-CLI vs direct DB, and why                                                                                      | doc            | #5, #26    |

## 3. Gateway (G)

| ID  | Requirement                                                                                                 | Acceptance test                                                                                                                                                                    | Verify       | Issues       |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ |
| G1  | Admin adds, edits, disables, removes upstream MCP servers, with optional static header or bearer credential | Admin API + dashboard CRUD; member gets 403; credential accepted on create/edit                                                                                                    | unit, e2e:D6 | #12, #18     |
| G2  | One endpoint lists tools from all enabled upstreams and routes calls to the right one                       | `POST /mcp` `tools/list` aggregates enabled upstreams; `tools/call` reaches the owning upstream                                                                                    | unit, e2e:D3 | #13, #15     |
| G3  | Tool-name collisions handled; naming scheme documented                                                      | Two fake upstreams exposing the same tool name are both callable as `{slug}__{tool}`; scheme in ADR 001 + DESIGN.md                                                                | unit, doc    | #6, #13, #26 |
| G4  | A slow or dead upstream never blocks the others                                                             | Parallel `listTools` (`allSettled`), 3 s list / 15 s call timeouts; slow fake upstream does not delay listing past 3 s; dead upstream's tools hidden; clear error envelope on call | unit, e2e:D7 | #13          |
| G5  | Upstream credentials stay server-side                                                                       | Stored AES-256-GCM encrypted; no API response, log line, or browser request contains the value (API returns `hasCredential` only)                                                  | unit, e2e    | #12, #18     |
| G6  | WooCommerce plus two other upstreams                                                                        | Three upstreams registered and `up`: `woo`, `everything` (in-cluster), `gitlab` (or fallback public server)                                                                        | e2e:D4       | #17          |

## 4. Team, keys, audit (T)

| ID  | Requirement                                                                                             | Acceptance test                                                                                                                     | Verify       | Issues   |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- |
| T1  | Roles `admin` and `member`; admin manages servers and members                                           | Role checks on every admin route; member cannot reach admin routes (403) or pages                                                   | unit         | #14, #18 |
| T2  | Per-user gateway API keys, revocable, stored hashed                                                     | 32 random bytes, shown once, SHA-256 stored, `revoked_at` revokes; revoked key → 401 on next call                                   | unit, e2e:D5 | #14, #15 |
| T3  | Every tool call audited (user, server, tool, timestamp, duration, outcome) and visible in the dashboard | `callTool` writes one row on success, error, timeout, and denial; members see own rows, admins all; no raw arguments/results stored | unit, e2e:D8 | #16, #18 |

## 5. Chat agent (C)

| ID  | Requirement                                                                        | Acceptance test                                                                                             | Verify     | Issues   |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| C1  | Dashboard chat uses an LLM to call gateway tools and shows which tools were called | Claude tool loop over the user's visible tool set; UI lists each tool call with name, args summary, outcome | e2e:D2, D4 | #19      |
| C2  | Chat acts as the logged-in user                                                    | Chat calls `callTool(sessionUserId, …)`; audit rows carry that user                                         | e2e:D8     | #19, #16 |
| C3  | LLM key handled like any other secret                                              | Key only in a K8s Secret, read by the gateway; never in the bundle, network responses, or logs              | k8s, e2e   | #19      |

## 6. Demo flows (D) — the definition of done for the assignment

Each flow is one script `tests/e2e/dN-*.sh`, printing `PASS Dn` / `FAIL Dn: <reason>`. `run.sh all` must pass twice in a row on a fresh cluster (#21).

| ID  | Flow                   | Pass condition                                                                                                                                                   |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Storefront checkout    | Order placed via Store API (cart → checkout, COD) is visible via the admin REST API and in wp-admin                                                              |
| D2  | User A chat            | Chat creates a named, priced product (visible on storefront); a manual order is placed; chat "what orders came in today?" returns that order id                  |
| D3  | User B external client | With only gateway URL + User B's key, `tools/list` shows enabled tools and `woo__list_orders` succeeds (script uses the MCP SDK client; demo uses MCP Inspector) |
| D4  | Cross-server prompt    | One chat prompt causes tool calls on two different upstreams; both are listed in the response                                                                    |
| D5  | Key revocation         | Admin revokes User B's key; User B's next MCP call → 401                                                                                                         |
| D6  | Disable upstream       | Admin disables an upstream; its tools disappear from `tools/list` and from the chat tool set; re-enable restores them                                            |
| D7  | Kill upstream          | `everything` scaled to 0 / pod deleted; other upstreams keep working; status API and dashboard show it `down` within one health interval (≤ 15 s + 3 s)          |
| D8  | Audit attribution      | Audit API returns every call made in D2–D7 under the correct user, server, tool, with duration and outcome                                                       |

## 7. Deliverables (R)

| ID  | Deliverable                                                                                              | Issue        |
| --- | -------------------------------------------------------------------------------------------------------- | ------------ |
| R1  | Repository with all source, chart, values-local, values-prod                                             | all          |
| R2  | README: zero to D1–D8 on a new machine, plus local-to-VPS story                                          | #26          |
| R3  | DESIGN.md: architecture, W4 connectivity choice, G3 naming, tradeoffs                                    | #26          |
| R4  | THREAT_MODEL.md: SSRF, malicious tool descriptions, compromised upstream, key leak, LLM prompt injection | #26          |
| R5  | Demo video (recorded by Aadi) covering D1–D8, K8s setup, MCP internals, security, local→VPS              | 26 Oct       |
| R6  | Submission form with video + public repo link                                                            | Aadi, 27 Oct |

## 8. Hackathon layer (H) — only after #21 passes

| ID  | Requirement                                                                                                      | Acceptance test                                                                                                                                                | Issue   |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| H1  | Pipeline builds images to GitLab registry, packages the chart, runs Secret Detection, SAST, IaC, container scans | Main pipeline green with tagged images + versioned chart; scan reports visible                                                                                 | #22     |
| H2  | Canary deploy of the gateway + verdict from business health                                                      | `verdict.py` emits PROMOTE / ROLLBACK / HOLD from error rate, latency, and `woo__list_orders` success; a forced bad release rolls back                         | #23     |
| H3  | Duo Agent Platform flows: Verdict, Incident, risk gate                                                           | Forced rollback opens an incident + `priority::high` regression issue; an auth/gateway MR pauses for Human Input before promote; flow YAML in `.gitlab/flows/` | #24     |
| H4  | Public project with visible pipeline history                                                                     | Project public; history shows ≥ 1 PROMOTE and ≥ 1 ROLLBACK                                                                                                     | #22–#24 |

## 9. Optional (O) — not started before #21

| ID  | Item                                     | Issue                                                                  |
| --- | ---------------------------------------- | ---------------------------------------------------------------------- |
| O1  | Live VPS deployment with the same chart  | #25                                                                    |
| O2  | Multi-store provisioning                 | not planned                                                            |
| O3  | Per-tool permissions, OAuth, rate limits | per-tool permissions: ADR 008, e2e D9; OAuth, rate limits: not planned |

## 10. Fixed conventions (decided; change only via ADR)

- "Today" = calendar day in the store timezone **Asia/Kolkata**, filtered by order `date_created`; bootstrap sets the WordPress timezone to match.
- Qualified tool names `{server_slug}__{tool}`; slug `^[a-z0-9-]{1,20}$`, immutable; full name ≤ 64 chars (Claude tool-name limit).
- Unreachable upstreams: tools **hidden** from listings; upstream shown `down` with `last_error` in the dashboard.
- Timeouts: upstream list 3 s, upstream call 15 s, WooCommerce REST 10 s, health check every 15 s.
- Audit stores metadata only (no raw arguments or results).
