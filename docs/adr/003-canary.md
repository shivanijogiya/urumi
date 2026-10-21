# ADR 003 — Canary deploy of the gateway and verdict.py

Status: proposed (needs Aadi's G3 approval: new workload, IngressRoute, NetworkPolicy and values
changes) · Issue #23 · Requirement H2 · Amended by ADR 004 (#24): a ROLLBACK now fails the job,
and a high-risk PROMOTE waits for `release:human-approval`; amended by ADR 005 (#28): stable is
built from the last promoted commit and the store is seeded with today's orders; amended by ADR
006 (#29): a CI-only `X-Urumi-Track` pin rule on the IngressRoute, and AI shoppers as an extra
ROLLBACK signal

## Context

H2: a new gateway release first takes a slice of real traffic; `verdict.py` emits PROMOTE /
ROLLBACK / HOLD from error rate, latency and `woo__list_orders` success; a forced bad release
rolls back automatically. ADR 000 Q9 puts the CI canary in an ephemeral k3d inside the job (risk
#2, proven by `spike/k3d-dind`). There is no service mesh, and we don't want one.

## Decision

- **Second Deployment, own component label.** `gatewayCanary.enabled` renders
  `<release>-gateway-canary` from the same pod template as the stable gateway
  (`templates/gateway/_pod.tpl`), 1 replica, image tag `gatewayCanary.image.tag`, labels
  `app.kubernetes.io/component: gateway-canary` and `track: canary`, plus its own Service. The
  stable Deployment and Service selectors are unchanged (selectors are immutable). Stable pods gain
  only `track: stable` and `TRACK=stable`. The two never select each other's pods. Both share
  Postgres: migrations are serialised by the advisory lock, and the health loop is idempotent. The
  Postgres, woo-mcp and everything NetworkPolicies admit `component In (gateway, gateway-canary)`,
  and add the canary only while it is enabled.
- **Traffic split: a Traefik `IngressRoute` (traefik.io/v1alpha1, shipped with k3s).** It exists
  only while the canary is enabled. It matches `/api` and `/mcp` on the app host with priority
  1000, above the app Ingress's rules, and sends `gatewayCanary.weight` % (default 20) to the
  canary Service by weighted round robin. The app Ingress is untouched, so disabling the canary
  deletes the IngressRoute and traffic falls back to the Ingress with no gap. With `app.tls` the
  route uses `websecure` and the same TLS Secret.
- **Attribution: `x-urumi-track`.** The gateway sets this header on every response from env
  `TRACK`, so verdict.py can tell which Deployment answered without Traefik access logs.
- **Forced bad release: fault injection in the gateway, off by default.** `FAULT_INJECT_ERROR_RATE`
  (0–1) makes that share of authenticated `POST /mcp tools/call` requests fail with a 500, and
  `FAULT_INJECT_LATENCY_MS` delays them (`src/http/canary.ts`). The chart sets these on the canary
  pod only (`gatewayCanary.faultInject`). An injected failure runs no tool, so it writes no audit
  row: it models a broken release, not a tool call. The `callTool` path is unchanged.
- **verdict.py** (stdlib only) sends 60 `tools/call woo__list_orders` requests through the Ingress
  with a member's API key. If the canary has fewer than 10 samples, it keeps sending, up to 240
  requests. It then compares per-track error rate, nearest-rank p95 and tool success:
  - ROLLBACK if the canary error rate is above stable + 5 points, or above 10 %; if its p95 is
    above 1.5 × stable p95 + 200 ms; if its success is below 95 %; or if failures with no track
    header (a dead canary pod's proxy 502s) exceed 10 % of all requests.
  - HOLD if a track has fewer than 10 samples, or if stable itself fails the thresholds.
  - Exit codes are 0/1/2. The JSON result goes to stdout and `verdict.json`.
- **scripts/canary/run.sh** `deploy|promote|rollback <tag>` uses `helm upgrade
--reset-then-reuse-values --no-hooks` and touches only gateway keys. The store bootstrap hook is
  not rerun. Every command is idempotent.
- **CI**: the `canary` job (stage `deploy`; default branch, manual on MRs) runs
  `scripts/canary/ci.sh`. It creates k3d in DinD, builds and imports the images, generates
  secrets, installs stable, and seeds without the GitLab upstream (`E2E_SKIP_GITLAB=1`). Then it
  deploys this commit as the canary and runs the verdict, then promotes or rolls back.
  `CANARY_FORCE_BAD=1` injects a 50 % error rate, and the job then fails unless the result is
  ROLLBACK. HOLD fails the job. Artifacts: `verdict.json` and a dotenv `VERDICT`.

## Consequences

- Stable and canary run the same chart and DB schema, so a canary that needs a non-backward-
  compatible migration is out of scope. Migrations must stay additive.
- The split is per request, with no stickiness. That is fine: the MCP endpoint is stateless and
  sessions live in Postgres.
- A 20 % slice of 60 requests is about 12 canary samples, which is small. The thresholds are
  coarse on purpose and catch gross regressions (a 50 % error rate, seconds of added latency). Raise
  `--requests` for finer judgements.
- In CI, stable and canary are built from the same commit, with a fault injected on demand. The
  job proves the mechanism, not a diff between two real releases.
