# ADR 014 — Hosted MCP servers (the gateway runs admin-added container images)

Status: proposed (G3: new namespace, RBAC for the gateway, NetworkPolicies, a Kubernetes-API
egress rule; needs Aadi) · Brief stand-out item 5 ("Hosted MCP servers") · Builds on ADR 002
(upstream registry, SSRF guard, secretbox), 008 (tool permissions), 009 (default-deny
NetworkPolicies), 010 (replicas, Postgres leases)

## Context

Admins can only register an MCP server by URL. A server that exists only as a container image
(most of the reference servers, `docker.io/mcp/*`, an in-house tool) needs someone with cluster
access to deploy it, expose it, add an egress rule and an SSRF exception for it — four manual
steps, each of which can weaken the platform's isolation. The brief asks for: add by image → the
platform runs it in the cluster and registers it automatically.

The risk is obvious: the gateway gains the power to start arbitrary code in the cluster. The
design goal is that this power stays small even if the gateway itself is compromised.

## Decision

**API and data.** `POST /api/hosted-servers` (admin only) takes `slug`, `name`, `image`, `port`
(1024–65535), `mcpPath` (default `/mcp`), `preset` (`small` | `medium`), `egress` (default
`false`) and optional `env` (≤ 20 variables; `PORT` and `KUBERNETES_*` are refused). Env values
are sealed with secretbox (AES-256-GCM, AAD `hosted-env:<id>`) into `hosted_servers`
(migration `006_hosted.sql`); only the names are stored in the clear and returned. No API, log
line or error contains a value (strict `HostedServerSchema`; logger redaction of `env`). The
same transaction inserts a **disabled** upstream row (`upstreams.hosted = true`) that reserves
the slug and carries the generated URL
`http://mcp-<slug>.<hosted.namespace>.svc.cluster.local:<port><mcpPath>`. `PATCH` changes name,
image, preset, egress or env; `DELETE` disables the upstream at once (its tools vanish on every
replica), then removes the objects and the rows. The upstream PATCH/DELETE routes refuse hosted
rows (409), so they cannot be repointed or re-enabled by hand.

**Image allow-list** (`hosted.allowedImages`, `HOSTED_ALLOWED_IMAGES`): registry/repository
prefixes, each ending in `/`. A reference is normalised as the runtime resolves it
(`mcp/x` → `docker.io/mcp/x`) and must start with a prefix at a path boundary, so
`docker.io/mcp/` does not match `docker.io/mcpevil/…`. Anything else → 400 "Image is not
allowed: its registry/repository is not on the hosted image allow-list". An `@sha256:` digest is
recorded (`image_digest`) and the pod runs `name@digest`; `hosted.requireDigest` (on in
`values-prod.yaml`) refuses tag-only references. Local default: `k3d-urumi-registry.localhost:5005/`
and `docker.io/mcp/`. The demo hosts the repo's own `urumi-everything` image.

**Hardened pod template, fixed in the gateway** (`apps/gateway/src/hosted/manifests.ts`). The
admin's inputs map to: image (allow-listed), container port (probes + `PORT` env), preset (an enum
→ fixed requests/limits: small 10m/48Mi → 250m/128Mi, medium 25m/96Mi → 500m/256Mi), a pod label
for egress, and Secret data. Everything else is constant: `runAsNonRoot`, uid/gid 65532 (not the
image's choice), `readOnlyRootFilesystem` with a 64 Mi `emptyDir` on `/tmp`,
`allowPrivilegeEscalation: false`, `privileged: false`, `capabilities.drop: [ALL]`, seccomp
`RuntimeDefault`, `automountServiceAccountToken: false` (ServiceAccount `hosted-mcp`, no
permissions), `enableServiceLinks: false`, no host namespaces, no command/args override, TCP
liveness + readiness probes on the port, `Recreate` strategy, 180 s progress deadline. Env values
reach the container only through `envFrom` a per-server Secret `mcp-<slug>-env`; `PORT` is in
`env`, which wins over `envFrom`. A unit test feeds hostile inputs (env keys named like security
fields, `PORT`, another preset, egress on, a digest) and asserts every hardening field is
unchanged.

**The namespace enforces it, not just the gateway** (chart, `templates/hosted/`):
`urumi-hosted` carries Pod Security Admission `enforce: restricted` (+ audit/warn), so the API
server rejects a privileged/root/capability-keeping pod even if the gateway's code or token were
abused. A `ResourceQuota` (6 pods, 300m/768Mi requests, 3 CPU/1.5 Gi limits) and a `LimitRange`
bound resource use however many servers exist; the gateway also caps them (`hosted.maxServers`,
default 5, serialised with an advisory lock across replicas).

**NetworkPolicies.** In the hosted namespace: default deny (Ingress + Egress); DNS egress to
CoreDNS; ingress to `managed-by=urumi-gateway` pods only from this release's gateway pods
(namespace + pod selector); internet egress (80/443, `0.0.0.0/0` minus 10/8, 172.16/12,
192.168/16, 100.64/10, 169.254/16, 127/8 — same helper as ADR 009) **only** for pods labelled
`urumi.io/hosted-egress=internet`, i.e. servers created with `egress: true`. Default: no egress
at all. In the release namespace, `urumi-gateway-egress` gains exactly two rules: the hosted
namespace's `managed-by=urumi-gateway` pods (any port) and the Kubernetes API
(`networkPolicy.kubeApi`, as for the bootstrap Job). Nothing in the release namespace admits
traffic from the hosted namespace, so Postgres, MariaDB, WordPress and woo-mcp are unreachable
from a hosted pod twice over.

**SSRF guard.** Static `UPSTREAM_ALLOWED_HOSTS` is unchanged (no wildcard for the hosted
namespace). At call time, a row with `hosted = true` is checked against an allow-list of exactly
one host, `mcp-<slug>.<namespace>.svc.cluster.local`, computed from its slug — and nothing
else; a non-hosted row pointing at that host is blocked like any private address.

**Kubernetes access.** The gateway pods run as ServiceAccount `<release>-gateway`
(`automountServiceAccountToken: false`); while `hosted.enabled`, a projected token (1 h expiry,
rotated by the kubelet) plus the cluster CA are mounted read-only. The only binding is a
**Role in the hosted namespace**:

| Resource           | Verbs                            | Why                                   |
| ------------------ | -------------------------------- | ------------------------------------- |
| `apps/deployments` | get, list, create, patch, delete | apply, status, garbage collection     |
| `services`         | create, patch, delete            | apply, delete                         |
| `secrets`          | create, patch, delete            | env Secret; **no get/list/watch**     |
| `pods`             | get, list                        | failure reasons (ImagePullBackOff, …) |

No ClusterRole, no rights in the release namespace, no `pods/exec|log|attach`, no pod creation
outside Deployments, no RBAC/ServiceAccount/NetworkPolicy objects. `tests/infra/hosted-chart.sh`
renders the chart and fails on any deviation (also asserts nothing is rendered with
`hosted.enabled=false`).

**Client: plain HTTPS, no library** (`hosted/kube.ts`). Six calls in one namespace do not justify
`@kubernetes/client-node` (large dependency tree, its own auth plugins, exec credential
providers we must not enable). `node:https` with the SA token (re-read per request), the CA, a
5 s timeout and a 4 MiB response cap; writes are **server-side apply**
(`PATCH application/apply-patch+yaml`, `fieldManager=urumi-gateway`, `force=true`), which is
idempotent. The client refuses to write an object whose namespace is not the hosted one. Errors
keep the API's status reason and a 200-char message (safe to show as a hosted server's reason).

**Reconciler and replicas** (`hosted/reconciler.ts`, `hosted/status.ts`). Every 5 s, on the replica
holding the Postgres lease `hosted` (ADR 010's lease table), for each row: desired `present` →
apply Secret/Service/Deployment when missing or when the spec hash (image, port, preset, egress,
env version — never the values) changed; read the Deployment and its pods; when the pod is
available, enable the upstream (= register it) and run one MCP `tools/list` immediately (instead
of waiting for the 15 s health loop); store phase + reason. Desired `absent` → delete the three
objects (404 = gone), then the upstream row (cascades). Deployments labelled
`managed-by=urumi-gateway` with no row are garbage-collected (re-checked against the DB to avoid
racing a create). API handlers also apply/delete directly so a change takes effect without
waiting; with server-side apply a non-leader doing this races harmlessly. Phase and reason have
a single writer (the lease holder).

| Phase         | When                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploying`   | objects being created; pod not ready (reason: `ContainerCreating`, `Unschedulable: …`); first check                                                                                                             |
| `connected`   | pod ready and the upstream is `up` (the normal health loop keeps checking it)                                                                                                                                   |
| `unreachable` | pod ready but the MCP check fails (reason: the health detail, e.g. `HTTP 404` for a wrong path)                                                                                                                 |
| `failed`      | `ImagePullBackOff`/`ErrImagePull`/`CrashLoopBackOff` (with last exit)/`CreateContainerConfigError`…; Deployment `ReplicaFailure` (Pod Security, quota); `ProgressDeadlineExceeded`; a 4xx from the API on apply |
| `deleting`    | delete requested, objects not yet gone                                                                                                                                                                          |

Once registered, a hosted server is an ordinary upstream: tools as `<slug>__*`, tool permissions
(members see nothing until granted, ADR 008: the seeded member rules name only woo/everything/
gitlab), audit rows, discovery mode, timeouts, rate limits, metrics, health loop.

## Consequences

- **Tested:** unit tests for manifests (hardening cannot be overridden), the allow-list, the phase
  state machine and API error details; integration tests on a real Postgres with the Kubernetes API
  faked at its boundary (admin-only API, env never returned/logged and stored sealed, allow-list,
  limit, taken slug, create → ready → registered → connected, failure reasons, a rejected apply,
  re-apply only on spec change, delete and deferred delete, garbage collection, the lease, the
  per-row SSRF exception); `tests/infra/hosted-chart.sh` (RBAC minimal and namespaced); e2e **D14**
  on k3d with two gateway replicas and default deny.
- **Not covered:** image signature verification (cosign/policy-controller) — the allow-list +
  digest pinning is the supply-chain control; vulnerability scanning of hosted images; per-server
  egress allow-lists by domain (egress is all-or-nothing public internet); horizontal scaling of a
  hosted server (1 replica); HTTP readiness on the MCP path (probes are TCP; the reconciler's MCP
  check covers protocol health).
- **Kubernetes API egress** uses `networkPolicy.kubeApi.cidr` (default `0.0.0.0/0` on 443/6443,
  as for the bootstrap Job). Narrow it per environment.
- **Rollback:** `helm rollback` to a revision without `hosted.*` removes the Role, ServiceAccounts
  and the namespace (deleting any hosted pods with it); the previous gateway image ignores the new
  table and column (migration is additive). `--set hosted.enabled=false` turns it off without a
  rollback: the API then lists rows but refuses creates; existing hosted upstream rows stay
  registered but unreachable until deleted.
