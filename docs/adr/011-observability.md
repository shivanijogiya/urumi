# ADR 011 — Observability: Prometheus metrics on an internal port, failure reasons, Health page

Status: accepted, merged to `main` (was proposed: needs Aadi: new dependency `prom-client`, new port/Service/NetworkPolicy, new
admin API) · Brief stand-out item 8 ("Observability") · Builds on ADR 010 (several replicas)

## Context

The brief: "Metrics such as tool calls, error rate and latency per server. Clear reporting of why
an upstream is unreachable or why a call failed."

What existed: the health loop's `status` + `last_error`, an audit row per call (outcome, error
code, duration), JSON logs. Missing: anything Prometheus can scrape; a per-server view of error
rate and latency; and the _reason_ of a failure in the audit row and in the error the caller sees
(`UPSTREAM_UNREACHABLE` said "unreachable", not "DNS" vs "connection refused" vs "HTTP 503").
With two replicas (ADR 010), per-process numbers no longer describe the deployment.

## Decision

**1. Prometheus metrics** (`prom-client`, `src/metrics/metrics.ts`):

| Metric                                            | Type      | Labels                                |
| ------------------------------------------------- | --------- | ------------------------------------- |
| `tool_calls_total`                                | counter   | `server`, `tool`, `outcome`, `source` |
| `tool_call_duration_seconds`                      | histogram | `server` (buckets 10 ms … 30 s)       |
| `rate_limited_total`                              | counter   | `scope` (`key` / `user`)              |
| `upstream_up`                                     | gauge     | `server`                              |
| `upstream_last_check_timestamp_seconds`           | gauge     | `server`                              |
| `upstream_last_success_timestamp_seconds`         | gauge     | `server`                              |
| default process metrics (`process_*`, `nodejs_*`) |           |                                       |

- **Label cardinality is bounded.** `server`/`tool` are registry data, used only when the call
  resolved to a real upstream tool (`CallRecord.resolved`); anything else — unknown names,
  FORBIDDEN before resolution — is `_unresolved`. Caller input never becomes a label value
  (unit test + D11 check).
- **Several replicas.** Counters and histograms are per pod; Prometheus sums them
  (`sum by (server) (rate(tool_calls_total[5m]))`,
  `histogram_quantile(0.95, sum by (le, server) (rate(tool_call_duration_seconds_bucket[5m])))`).
  The upstream gauges are read **from Postgres at scrape time**, so every replica reports the
  health-lease holder's view instead of its own (followers never ping).

**2. Internal port, never public.** A second Fastify listener on `METRICS_PORT` (9464) serves
only `GET /metrics`. It is not on the gateway Service the Ingress routes (port 80 → 8080); a
separate ClusterIP Service `<release>-gateway-metrics` exists for scrapers. NetworkPolicy
`<release>-gateway-metrics` admits only pods labelled `urumi.io/metrics-scraper: "true"` in the
namespace (plus an optional `scraperNamespace` for an external Prometheus); a matching egress
policy lets those pods reach the port. Traefik's allow policy covers 8080 only.
`gateway.metrics.serviceMonitor.enabled` (off by default; no operator is installed) renders a
prometheus-operator `ServiceMonitor`.

**3. Failure reasons.** One fixed vocabulary, classified in contracts (`failures.ts`, shared by
gateway and dashboard): `timeout`, `dns`, `connection_refused`, `connection_failed`,
`http_status`, `mcp_error`, `blocked_address`, `tool_error`, `result_too_large`,
`not_permitted`, `unknown_tool`, `server_disabled`, `server_down`, `rate_limited`,
`invalid_arguments`, `other`. The details come only from the gateway's own strings
(`UpstreamError.detail`, `FAILURE_DETAILS`) — never upstream text, URLs or credentials.

- `audit_log.error_detail` (migration 004) stores the detail; `/api/audit` returns
  `errorDetail` + `errorReason`.
- `upstreams.last_ok_at` (migration 004): when the upstream last passed a health check;
  `/api/upstreams` returns `lastErrorReason` + `lastOkAt`.
- Caller-facing messages now say why: `Server 'woo' is unreachable: connection refused`,
  `Server 'x' is unreachable (marked down by the health check: host name did not resolve (DNS))`,
  `Server 'x' returned an error: HTTP error status: HTTP 502`.

**4. Health / Metrics page (admin)** backed by `GET /api/metrics/summary?windowMinutes=N`:
per server, over the window, calls, errors, error rate, p50/p95 (`percentile_cont` over
`audit_log.duration_ms`), outcome counts and the top failure details. Next to them: the
upstream's status, the classified last error, last check and last success, plus the current
health-lease holder. It is computed in Postgres from `audit_log`, which every replica writes,
so it is correct across replicas **without** Prometheus. An index
`(server_slug, started_at DESC)` keeps the window query cheap.

## Consequences

- Tests: `test/observability.test.ts` (labels, `_unresolved`, gauges equal on a replica that
  never pinged, listener serves only `/metrics`, failure details per failure kind, summary
  numbers, admin-only, down-upstream reason with `lastOkAt`), `packages/contracts/test/failures.test.ts`,
  `apps/dashboard/test/health.test.tsx`; e2e **D11** (scrape every gateway pod from a labelled
  pod, counters move after 3 calls, unknown tool counted as `_unresolved`, unlabelled pod blocked,
  no Prometheus text via the Ingress host, summary row correct).
- The `/metrics` scrape costs one small `SELECT` on `upstreams`; the summary page costs four
  aggregate queries over the window (bounded by the index; at most 7 days).
- Not done: tracing (no OpenTelemetry), alert rules, a bundled Prometheus/Grafana. Audit-based
  p50/p95 counts only calls that reached `callTool` (rate-limited requests are counted
  separately, as `rate_limited`).
- New runtime dependency: `prom-client` 15 (MIT, bundled into `dist/main.js` by esbuild, plus
  `tdigest`/`bintrees`).
