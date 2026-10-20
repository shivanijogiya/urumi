# Delivery plan

Owner: Hermes (senior SDE) · Approver: Aadi · Written 20 Oct 2026 04:30 IST
Hard freeze: **27 Oct 12:00 IST**. Requirement IDs: `docs/REQUIREMENTS.md`.

## 1. Where we are

- Repo has the starter only (CLAUDE.md, `.claude/skills`, scripts, one-job CI). No app, chart, or contracts code.
- The 19 Oct checkpoint (storefront loads) is **missed**: we start 20 Oct, about one day behind §10 of the plan.
- Issues #2–#26 exist with estimates, dependencies, and acceptance criteria. Core work (#2–#21) totals **53 h**; hackathon (#22–#24) 11 h; docs 3 h; VPS 3 h (optional).
- Risk #1 checked this morning (see §6): GitLab MCP accepts a static token, but only a fine-grained PAT with *MCP tool: Execute*.

## 2. Architecture in one screen

```
 browser ──► Ingress app.localtest.me ──► dashboard (nginx, static React)
                                     └──► gateway  /api/*  (session cookie)   ─┐
 MCP client ─► Ingress app.localtest.me/mcp ─► gateway /mcp (Bearer key)      ─┤
                                                                               ▼
                                         callTool(userId, "slug__tool", args)  ── audit_log (Postgres)
                                               │ parallel, timeouts, health
                       ┌───────────────────────┼─────────────────────────┐
                       ▼                       ▼                         ▼
              woo-mcp (ClusterIP,     server-everything          GitLab MCP (gitlab.com,
              NetPol: gateway only,   (ClusterIP, killable)      encrypted bearer) or
              shared-secret header)                              public no-auth fallback
                       │
                       ▼  WooCommerce REST API + Application Password
              WordPress + WooCommerce ── MariaDB (PVCs)  ◄── Ingress store.localtest.me
```

Chat: dashboard → `POST /api/chat` → gateway runs the Claude tool loop with the session user's visible tools → each tool use goes through `callTool`. One code path, one audit trail.

## 3. Tracks and critical path

| Track | Issues (in order) | App folder |
|---|---|---|
| A — Infra/store | #2 → #3 → #4 → #5 → #10 → #17 | `charts/`, `scripts/` |
| B — Contracts (gate) | #6 (G1) | `packages/contracts` |
| C — woo-mcp | #7 → #8 → #9 | `apps/woo-mcp` |
| D — Gateway | #11 → #12 → #13 → #14 → #15, #16 → #19 | `apps/gateway` |
| E — Dashboard | #18 | `apps/dashboard` |
| F — Proof | #20 → #21 (checkpoint) | `tests/e2e` |
| G — Hackathon | #22 → #23 → #24 | `.gitlab-ci.yml`, `release/` |
| H — Docs | #26 (drafted alongside, finalised 26 Oct) | `docs/` |

**Critical path (≈ 31 h):** #2 → #6 (G1 wait) → #11 → #14 → #13 → #15/#16 → #18 → #19 → #20 → #21.
The G1 approval on #6 is the single biggest schedule lever: every app track waits on it.

**Parallelism:** max 3 Claude Code runs, one per app folder. Track A does not touch contracts, so I propose running it while #6 is in review (Decision Q1). After G1 merges: woo-mcp, gateway, and infra run in parallel; dashboard starts once #14 lands.

## 4. Schedule (revised)

| Date | Work | Gate / checkpoint |
|---|---|---|
| **20 Oct** | #2 skeleton (+ security scan jobs, Q3) · #6 contracts MR · #3 k3d · #4 store chart | G1 on #6, G3 on #3/#4 · storefront loads |
| 21 Oct | #5 bootstrap Job · #7 woo-mcp scaffold · #11 Postgres + migrations · #10 woo-mcp NetPol · verify risks #2–#4 | D1 passes; risk report to Aadi |
| 22 Oct | #8, #9 woo tools · #12 registry · #14 users/keys · #13 aggregation starts | all 5 woo tools callable in-cluster |
| 23 Oct | #13 done · #15 MCP endpoint · #16 audit · #17 upstreams 2–3 · #18 dashboard starts | 3 upstreams listed; D3, D5, D6, D7, D8 pass |
| 24 Oct | #18 dashboard · #19 chat · #20 e2e · **#21 checkpoint by 18:00** | **ALL D1–D8 PASS** (else hackathon layer cut) |
| 25 Oct | #22 pipeline + registries · #23 canary + verdict.py | green pipeline; one PROMOTE |
| 26 Oct | #24 Duo flows (forced rollback) · #26 docs · GitHub mirror (Q8) | one forced rollback in history; docs merged; Aadi records video |
| 27 Oct | Fixes only. **Freeze 12:00 IST.** | nothing merges after freeze |

The checkpoint moves from 23 Oct to 24 Oct 18:00 (Decision Q2). VPS (#25) is cut unless the checkpoint lands by 24 Oct 12:00.

**Cut order if we slip further** (from first cut to last): #25 VPS → #24 risk-gate flow (keep Verdict + Incident) → #23 traffic-split canary (keep verdict.py against a single release) → dashboard polish (audit filters, status auto-refresh UI). D1–D8 are never cut.

## 5. How each issue runs

Per `SOUL.md` §5 and the `gitlab-loop` skill: design note in the issue → worktree `feat/<n>-<slug>` → Claude Code headless with tests first → I verify locally (tests, e2e step, diff < 400 lines, §7 checklist) → MR with evidence → Duo review + `/code-review` → merge per autonomy policy v2 or ask (G1/G3/auth).

Expected gate routing:

| Needs Aadi | Issues |
|---|---|
| G1 contracts | #6 |
| G3 infra/secrets | #3, #4, #5, #10, #11, #17, #22 (security jobs), #25 |
| Auth/security code | #14, #15, #12 (credential encryption + SSRF) |
| Auto-merge candidates | #7, #8, #9, #13, #16, #18, #19, #20, #26 (if all v2 rules hold) |

## 6. Risks to verify first (results by 21 Oct)

| # | Risk | Status | Fallback |
|---|---|---|---|
| 1 | GitLab MCP accepts a static bearer | **Checked 20 Oct.** `POST https://gitlab.com/api/v4/mcp` with the current PAT → `403 insufficient_granular_scope: requires fine-grained PAT with MCP tool: Execute`. So static bearer works with the right token type. Need a dedicated fine-grained PAT from Aadi. | Public no-auth MCP server (DeepWiki `https://mcp.deepwiki.com/mcp`) |
| 2 | k3d runs inside GitLab CI (DinD) | **Verified 20 Oct.** Shared runner, `docker:27-dind`: k3d v5.9 cluster Ready, Traefik rolled out, pods scheduled; 86 s job (pipeline 2965520038, branch `spike/k3d-dind`). | e2e + canary run on a project runner on the Mac (or VPS) |
| 3 | Application Password works with WooCommerce REST | **Verified 20 Oct** in #5 (!6): WooCommerce 11.0.1, `GET /wc/v3/orders` → 200, wrong password → 401. Needs `WP_ENVIRONMENT_TYPE=local` over HTTP; prod over HTTPS. | WooCommerce consumer key/secret over HTTP basic (in-cluster only) |
| 4 | Duo custom agents can use external MCP servers in the hackathon group | **Docs checked 20 Oct:** external MCP servers for custom agents are beta, Premium/Ultimate, configured in the AI Catalog. Moot without a public gateway (VPS is cut-first), so **plan on the fallback**. | `verdict.py` calls the gateway from CI; the Duo flow reads its output artifact |
| 5 | Schedule (one day behind) | Active | Cut order in §4 |
| 6 | Anthropic API key / credits for chat (D2, D4) | Needs Aadi | none: D2/D4 require a working LLM |

## 7. Technical decisions I am taking (reversible, within my authority)

- Node 22 LTS, npm workspaces, TypeScript strict, Vitest, ESLint + Prettier. zod for every boundary.
- Gateway: Fastify HTTP server; MCP SDK `McpServer` (to clients) and `Client` + `StreamableHTTPClientTransport` (to upstreams). Postgres via `pg` with plain SQL migrations (`node-pg-migrate`-style numbered files, run on start).
- Dashboard: React + Vite + React Router + TanStack Query, served by nginx; the chat is request/response (no streaming) showing a tool-call trace.
- Woo upstream credential: the woo-mcp shared secret is registered as the `woo` upstream's encrypted header credential, so G5 is exercised by a real upstream.
- D7 uses `kubectl scale --replicas=0` for a deterministic outage (a plain pod delete self-heals in seconds), then restores; the demo can still show a pod delete.
- Images build locally and import into k3d's registry; tags are the git SHA.
- Each e2e step is idempotent; users and keys are seeded only through the admin API.

## 8. Open decisions for Aadi

Sent as one DECIDE message on 20 Oct. **All accepted** (ADR 000).

| Q | Question | Recommendation |
|---|---|---|
| Q1 | Run infra track (#2–#5) in parallel while contracts #6 waits for G1? | **Yes.** It touches no contract; saves ~half a day. |
| Q2 | Checkpoint moves 23 → 24 Oct 18:00; VPS #25 cut unless checkpoint lands by 24 Oct 12:00 | **Accept.** D1–D8 stay intact; hackathon gets 25–26 Oct. |
| Q3 | Pull Secret Detection + SAST + IaC scan templates from #22 into #2 | **Yes.** Autonomy v2 auto-merge needs these jobs green; without them nothing can auto-merge. Touches security CI jobs, so you approve #2. |
| Q4 | Third upstream: GitLab MCP with a dedicated fine-grained PAT (*MCP tool: Execute*, 7-day expiry) vs DeepWiki no-auth | **GitLab.** Shows encrypted bearer credentials and gives the best D4: "summarise today's orders and open a GitLab issue with the summary" (woo + gitlab). |
| Q5 | Dashboard login method | **Email + password** (scrypt, Node built-in), admin creates members with a temp password; seed admin from a Secret. No self-signup, no OAuth. |
| Q6 | External MCP endpoint shape | **`POST /mcp`, stateless Streamable HTTP, Bearer key checked on every request**, JSON responses. Tradeoff: no `tools/list_changed` push, so D6 is shown by re-listing (Inspector "List Tools"). |
| Q7 | Chat model | **Claude Sonnet (latest)**: good tool use at lower latency/cost than Opus. Key goes in `.env.local` by you, never in chat. |
| Q8 | Urumi asks for a GitHub repo; this project lives on GitLab | **GitLab push-mirror to a new public GitHub repo** (`1012aaditya/urumi-mcp-gateway`), set up 26 Oct. |
| Q9 | Canary target for #23 | **Ephemeral k3d inside the CI job** (no VPS dependency); fallback a project runner on the Mac if DinD fails (risk #2). |

## 9. Inputs needed from Aadi (no secrets in chat)

1. Anthropic API key → `~/work/urumi/.env.local` as `ANTHROPIC_API_KEY` (by 23 Oct).
2. Fine-grained GitLab PAT, *MCP tool: Execute*, scoped to this project, 7-day expiry → `.env.local` as `GITLAB_MCP_TOKEN` (by 23 Oct). Separate from the merge token.
3. G1 review of the #6 contracts MR (target: today).
4. GitHub repo for the mirror (by 26 Oct), if Q8 = yes.
