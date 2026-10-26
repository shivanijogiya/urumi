# ADR 010 — Scaling: several gateway replicas, shared rate limits, one health writer

Status: accepted, merged to `main` (was proposed: needs Aadi: new tables, new chart objects, default replica count changes)
· Brief stand-out item 7 ("Scaling") · Amends DESIGN §10/§11 and THREAT_MODEL 3.6

## Context

The brief: "Run more than one gateway replica and show that MCP sessions and upstream connections
still work. Rate limits per user or per key."

What one replica assumed, and what breaks with two:

| Piece                      | Today (one replica)                                                                         | With two replicas                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/mcp` sessions            | Stateless Streamable HTTP: no `Mcp-Session-Id`, key checked per POST, fresh SDK server each | Nothing to share — any replica answers any POST (verified, below)                            |
| Upstream connections       | A new SDK client connection per operation, closed (session `DELETE`) after                  | Nothing to share                                                                             |
| Tool cache                 | In memory, 30 s TTL keyed to the row's `updated_at`                                         | Per replica; a cache miss costs one `tools/list`. Correctness comes from the row, not cache  |
| Health loop (15 s)         | Pings every enabled upstream, writes `status`/`last_error`/`last_checked_at`                | Two writers: double pings, interleaved writes, `last_error` flapping between replicas' views |
| Rate limits (`/mcp`)       | None                                                                                        | Must hold across replicas                                                                    |
| Chat limit, login throttle | In memory per replica                                                                       | Each replica counts separately                                                               |
| Migrations                 | Advisory lock                                                                               | Already safe                                                                                 |

## Decision

**1. MCP transport: keep it stateless.** We considered session state shared through Postgres
(the SDK's `sessionIdGenerator` + an event store) and rejected it: it would add a table write per
message, server-initiated SSE streams pinned to one pod, and sticky routing or replay — for no
feature we use (no server→client notifications, no resumable streams). With
`sessionIdGenerator: undefined` and JSON responses, the "session" an MCP client holds is only its
key; `initialize`, `tools/list` and `tools/call` can land on different pods. Cost (unchanged): no
`notifications/tools/list_changed` push.

**2. Health loop: one writer via a Postgres lease** (`gateway_leases`, `core/leader.ts`). At the
start of every tick a replica runs one atomic UPSERT that takes the `health` lease if it is free or
expired, or renews it if it already holds it (TTL 45 s = three ticks). Only the holder pings and
writes. A clean shutdown deletes the lease, so another replica takes over on its next tick
(≤ 15 s); a crash is covered by expiry (≤ 45 s + 15 s). The holder id is the pod name
(`POD_NAME`, downward API).

- Chosen over `pg_try_advisory_lock`: a session advisory lock needs one connection pinned for the
  pod's life and is lost silently when the pool recycles it; a lease row is visible
  (`SELECT * FROM gateway_leases`), testable, and survives connection churn.
- Chosen over "every replica checks, DB is the source of truth": that doubles upstream pings and
  makes `last_error` alternate between two replicas' views (e.g. one sees DNS fail, one times out).
- A failed ping is retried once, 1 s later, within the same tick before the upstream is marked
  `down`. Found by D10: deleting a pod made the leader's pings to all three upstreams time out
  at once (pod churn + NetworkPolicy resync on a loaded node), hiding every tool for one
  interval. The retry adds ≤ 4 s to down-detection (D7 still requires ≤ 25 s).
- Followers keep correct behaviour without pinging: `listTools` and `callTool` read the row's
  `status` from Postgres on every request, so a `down` written by the leader hides the tools on
  every replica at once; followers fill their tool caches on demand (30 s TTL).

**3. Rate limits on `/mcp`: Postgres token buckets** (`rate_limit_buckets`,
`ratelimit/bucket.ts`). Two buckets per request: `key:<api key id>` then `user:<user id>` (a user's
keys share one user budget). Taking a token is one statement — an UPSERT that refills the bucket
for `now() - updated_at` (the Postgres clock, so replicas agree on time) and decrements only if a
whole token is there; the row lock serialises concurrent requests from all replicas. A refused
request leaves the row untouched (refill continues), gets **HTTP 429**, `Retry-After: <seconds
until one token>` and error code `RATE_LIMITED`, and is **audited** with outcome `rate_limited`,
`server_slug = 'gateway'`, `tool = 'mcp'` (the check runs in `onRequest`, after the key check and
before the body is read, so the tool name is not known — and a flood never makes us parse 1 MB).

- Math: N replicas together admit at most `burst + perMinute × t` requests in `t` minutes per
  bucket — the same as one replica. Defaults: per key 120/min burst 60, per user 240/min burst 120;
  `values-local.yaml` raises them (600/100, 1200/400) for the e2e load step. 0 disables a limit.
- Cost: two small UPSERTs per `/mcp` POST (the key lookup already costs one query). Rows are
  bounded by the number of keys + users.
- Chosen over per-replica in-memory buckets (limit silently multiplies by the replica count and
  resets on restart) and over Redis (a new stateful dependency for one feature).

**4. Kubernetes.** `gateway.replicas` (default 1; 2 in `values-local.yaml` and
`values-prod.yaml`); RollingUpdate `maxUnavailable: 0, maxSurge: 1`; a PodDisruptionBudget
`minAvailable: 1` when replicas > 1; soft pod anti-affinity + topology spread on hostname
(`ScheduleAnyway`, so a one-node cluster still schedules both); `preStop: sleep 5` so Traefik drops
a terminating pod from its endpoints before Node stops accepting. No new NetworkPolicy: replicas
never talk to each other, only to Postgres (already allowed). Local requests shrink to 25m/96Mi
so two pods fit where one did on an 8 GB laptop.

## Consequences

- `tests/e2e/d10-scaling.sh` (D10) proves on k3d: 2 ready pods; one SDK client session doing
  initialize + 60 × (`tools/list` + `tools/call`) with `/mcp` requests in both pods' logs; one pod
  deleted mid-run without a single failed call; back to 2 pods; `last_checked_at` still advancing
  after the kill; a 150-request burst getting 429 + `Retry-After` + `RATE_LIMITED` and
  `rate_limited` audit rows.
- Unit/integration tests (real Postgres): `test/ratelimit.test.ts` (refill/Retry-After math,
  exactly `burst` admitted out of 40 concurrent requests from two pools, refill over time, per-user
  sharing, `/mcp` 429 + audit), `test/leader.test.ts` (one holder, renew, release, expiry
  takeover, 8 concurrent acquirers → 1 winner, only the holder's tick writes).
- Still per replica (documented, not fixed here): the chat limit (20/min per user **per replica**)
  and the login throttle (per email/IP **per replica**), so with 2 replicas an attacker gets up to
  2× the login attempts before lockout. Both are small and could move to the same buckets.
- A pod killed with `--grace-period=0 --force` (not a graceful delete) can fail the in-flight
  request on that pod; the client must retry it. D10 uses a graceful delete, as a rollout or
  node drain does.
- Migration `003_scaling.sql` is additive (two tables, a wider `CHECK`), so the previous image
  still runs on the new schema (rollback rule in DESIGN §12). **Rollback caveat:** the previous
  dashboard validates `/api/audit` responses with an outcome enum that lacks `rate_limited`, so
  after rolling back below this release its Audit page errors on any page that contains a
  rate-limited row (the gateway API, filters by user/server, and D1–D8 are unaffected). Filter
  the page (e.g. by outcome or user), or keep the rows' meaning and relabel them before the
  rollback: `UPDATE audit_log SET outcome = 'denied' WHERE outcome = 'rate_limited'`
  (`error_code` stays `RATE_LIMITED`).
