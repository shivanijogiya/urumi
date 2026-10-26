# ADR 015 — Multiple stores (the gateway provisions WooCommerce stores at runtime)

Status: accepted, merged to `main` (was proposed: G3: cluster-scoped RBAC for the gateway, a ValidatingAdmissionPolicy, new
NetworkPolicies and per-store namespaces; needs Aadi) · Brief bonus "multi-store" · Builds on ADR
002 (upstream registry, SSRF guard, secretbox), 008 (tool permissions), 009 (default-deny
NetworkPolicies), 010 (replicas, Postgres leases), 014 (hosted MCP servers: Kubernetes client,
lease-driven reconciler, Pod Security)

## Context

The chart deploys exactly one store (MariaDB + WordPress + the bootstrap Job + woo-mcp) and the seed
registers it as upstream `woo`. A second store today means a second Helm release by someone with
cluster access, then a manual upstream registration with a shared secret copied by hand. The brief's
bonus asks for: an admin creates and deletes stores from the dashboard; every store is isolated and
wired into the gateway automatically.

Two constraints shape the design. First, a store is much heavier and more privileged than a hosted
MCP server: it needs a database with a password, persistent volumes, an Ingress, a Job that
downloads code from wordpress.org and writes a Secret, and an Application Password created inside
WordPress. Second, isolating stores from each other and from the platform is the whole point — one
namespace per store is the unit Kubernetes gives us for that (quota, Pod Security, NetworkPolicy
scope, RBAC scope, and one-call deletion with its volumes).

## Decision

**API and data.** `POST /api/stores` (admin) takes `slug`, `name`, `adminEmail` — nothing else, and
no password. Slug: a DNS-1123 label of 2–20 characters starting with a letter; reserved:
`gateway woo everything gitlab default store stores app www api admin mcp urumi hosted kube system
public` (`StoreSlugSchema`, shared by API and dashboard). The slug is also the upstream slug
(`shop2__list_products`), the namespace `store-<slug>` and the host `<slug>.<domainSuffix>`. One
transaction (migration `007_stores.sql`, additive):

1. takes an advisory lock and refuses creation at `multiStore.maxStores` (default 3) with
   `400 "Store limit reached (n of max); delete a store first"` — deleting stores count until gone;
2. inserts a **disabled** upstream row (`upstreams.store = true`) with URL
   `http://woo-mcp.store-<slug>.svc.cluster.local/mcp` and, as its credential, a fresh 32-byte shared
   secret sealed with secretbox exactly like any upstream credential (header `x-woo-mcp-secret`);
   the slug unique index makes a taken slug a `409`;
3. inserts the `stores` row (desired `present`, phase `provisioning`, generation 1);
4. grants the **member read-only defaults of the built-in store** for that slug (see Permissions).

`DELETE /api/stores/:id` disables the upstream at once (its tools vanish on every replica), marks
the row `absent` and returns `202` with phase `deleting`. `POST /api/stores/:id/retry` is accepted
only for a `failed` store. `GET /api/stores` lists the stores plus the chart's own store as
`builtIn` (not deletable). The upstream PATCH/DELETE routes refuse store rows (`409`), so a store's
upstream cannot be repointed or re-enabled by hand.

**What a store is** (`apps/gateway/src/stores/manifests.ts`, pure, unit-tested). All in namespace
`store-<slug>`, labelled `urumi.io/store=true`, `urumi.io/store-id`, `managed-by=urumi-gateway`, and
**Pod Security `restricted` enforced** (WordPress already runs as uid 33 with all capabilities
dropped; port 80 comes from the "safe" sysctl `net.ipv4.ip_unprivileged_port_start`, which
`restricted` allows):

| Object                                         | Notes                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ResourceQuota + LimitRange                     | 6 pods, 300m / 512 Mi requests, 3 CPU / 1.5 Gi limits, 2 PVCs / 4 Gi, no NodePort/LoadBalancer (values `multiStore.quota`)                  |
| NetworkPolicies                                | default deny (Ingress + Egress) + the flows below                                                                                           |
| `mariadb` StatefulSet + PVC, Service           | official image, uid 999, `--innodb-buffer-pool-size=32M --performance-schema=OFF`, 128 Mi request / 320 Mi limit                            |
| `wordpress` Deployment + docroot PVC, Service  | official image, uid 33, `WP_HOME` = the storefront URL, 96 Mi / 384 Mi                                                                      |
| Ingress `storefront`                           | `<slug>.<domainSuffix>` → wordpress:80 (local: `http://shop2.store.localtest.me`)                                                           |
| ServiceAccount `store-bootstrap` + RoleBinding | to the chart's `store-bootstrap` ClusterRole: the `woo-api` Secret only                                                                     |
| ConfigMap `store-bootstrap-scripts`            | **the same files** as the built-in store's Job (`charts/platform/files/bootstrap/`), mounted into the gateway from the chart's ConfigMap    |
| Secrets `store-db`, `store-admin`              | random DB/root/WP-admin passwords generated by the gateway, **created once** (POST; never re-applied, never read back, stored nowhere else) |
| Secret `woo-mcp-shared`                        | the shared secret from the upstream credential (server-side applied)                                                                        |
| Job `bootstrap-g<generation>`                  | the built-in store's bootstrap: `wp` initContainer (WP-CLI: install WP + WooCommerce, COD, API user, Application Password) + `publish`      |
| `woo-mcp` Deployment + Service                 | the main woo-mcp image; created only after the Job succeeded (it reads the `woo-api` Secret the Job writes)                                 |

NetworkPolicy flows (everything else is denied): Traefik (kube-system) → wordpress:80; woo-mcp and
bootstrap → wordpress:80; wordpress and bootstrap → mariadb:3306; this release's gateway pods →
woo-mcp:8080; woo-mcp → wordpress:80; bootstrap → Kubernetes API (`networkPolicy.kubeApi`) and the
internet (80/443 without private, CGNAT, link-local and loopback ranges) for the WooCommerce
download; wordpress → internet only if `networkPolicy.wordpressInternetEgress` (as for the built-in
store); every pod → cluster DNS. Same-namespace peers are bare `podSelector`s, and the only
`namespaceSelector`s name `kube-system` (DNS, Traefik) or the release namespace (gateway) by
`kubernetes.io/metadata.name` — so no rule can ever match another store. A unit test enumerates the
flows and fails on any other; D15 proves a pod in `store-shop2` cannot reach the built-in store's
MariaDB/WordPress/woo-mcp, the gateway's Postgres, the metadata IP or a pod in another store
namespace, and that another store namespace (even with no policies of its own) cannot reach
shop2's MariaDB, WordPress or woo-mcp. In the release namespace, `urumi-gateway-egress` gains one
rule: pods labelled `component=woo-mcp, managed-by=urumi-gateway` in namespaces labelled
`urumi.io/store=true`, TCP 8080.

**Registration and SSRF.** When the store's woo-mcp Deployment is available, the provisioner enables
the upstream (= registers it) and runs one MCP `tools/list` at once; the store is `ready` when the
upstream is `up`. From then on it is an ordinary upstream: `shop2__*` tools, health loop, audit,
discovery, rate limits, metrics. The SSRF guard lets a row with `store = true` reach exactly
`woo-mcp.store-<slug>.svc.cluster.local` (computed from its slug, only while multi-store is on);
a non-store row pointing there, or a store row pointing elsewhere, is blocked as private.

**Permissions (ADR 008).** A new store gets, for role `member`, `allow` rules on
`<slug>/list_products`, `<slug>/list_orders` and `<slug>/get_order` — the same read-only defaults
the seed migration gives the built-in `woo`. They are ordinary rows: visible and editable under
Permissions, overridable per user. The store "owns" every rule whose `server_slug` is its slug: on
delete they are removed with it (role and per-user rules), so a later store that reuses the slug
starts from the defaults again. Admins have `* *` as before.

**Provisioner** (`stores/provisioner.ts`), the hosted reconciler's pattern (ADR 014): every 5 s, on
the replica holding the Postgres lease `stores`, level-triggered and idempotent per row:

- `present` + `provisioning` (or a spec-hash change while `ready`): server-side apply the namespace,
  POST the two RoleBindings (gateway first: every namespaced write needs it), apply quota, limits,
  policies, ServiceAccount, scripts, shared Secret, Services, MariaDB, docroot PVC, WordPress,
  Ingress; POST the generated-password Secrets and the Job (409 = exists = fine); once the Job
  succeeded, apply woo-mcp; read StatefulSet, Deployments, Job and pods; derive the phase
  (`stores/status.ts`, pure). Every step is re-done on the next pass, so a gateway that dies anywhere
  in the middle is simply continued by the next lease holder (tested; D15 restarts both gateway pods
  mid-provision).
- `failed`: nothing is applied until Retry, which bumps `generation` (new Job `bootstrap-g<n+1>`,
  old Jobs deleted, woo-mcp restarted through a pod-template annotation) and restarts the timeout.
- `absent`: `DELETE` the namespace (the namespace controller then removes every object, both PVCs
  and — with `local-path`'s `Delete` reclaim policy — their volumes); while it exists the phase is
  `deleting`; once the API returns 404, delete the store's permission rules and its upstream row
  (cascades to `stores`) in one transaction. A crash anywhere repeats the step; D15 restarts the
  gateway mid-delete.
- garbage: a namespace labelled as a store with no row (e.g. a restored database) is deleted.

| Phase          | When                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisioning` | reason = the current step: Creating the namespace · Starting MariaDB · Starting WordPress · Installing WordPress and WooCommerce (bootstrap job) · Starting woo-mcp · Registering the upstream; plus the pod's pending reason (e.g. unbound PVC)                                                                                                                                            |
| `ready`        | woo-mcp registered and its upstream up; sticky (later health is the upstream status shown next to it)                                                                                                                                                                                                                                                                                       |
| `failed`       | ImagePullBackOff / ErrImagePull / CreateContainerConfigError / CrashLoopBackOff (3+ restarts) of any store pod; bootstrap Job `Failed` (with its reason and the `kubectl logs` hint); `ReplicaFailure` (quota, Pod Security); a 4xx from the API on a write (admission policy, RBAC); still provisioning after `multiStore.provisionTimeoutMinutes` (10) → "Timed out after 10 min: <step>" |
| `deleting`     | delete requested, namespace not gone yet                                                                                                                                                                                                                                                                                                                                                    |

**Kubernetes access and RBAC.** The gateway's ServiceAccount (ADR 014; projected 1 h token) gets,
only while `multiStore.enabled`:

1. ClusterRole `<release>-store-provisioner` (ClusterRoleBinding): `namespaces` get, list, create,
   patch, delete; `rolebindings` create; `clusterroles` **bind** with `resourceNames` = the two roles
   below. Nothing else cluster-wide: no Secrets, no pods, no RBAC reads or writes beyond that.
2. ClusterRole `<release>-store-manager`, **never bound cluster-wide**: the gateway binds it in each
   store namespace with the RoleBinding it creates there. Exactly what the provisioner calls:
   create + patch on quotas, limit ranges, service accounts, config maps, services, PVCs, network
   policies, ingresses, StatefulSets, Deployments; Secrets **create + patch only (no get/list/watch:
   the gateway cannot read a password back)**; Jobs list/create/delete; Deployments/StatefulSets get;
   pods list. No pods/exec|log|attach, no bare pods, no Roles.
3. ClusterRole `<release>-store-bootstrap`, bound by the gateway to each namespace's
   `store-bootstrap` ServiceAccount: Secret `woo-api` get/patch/update + Secret create (identical to
   the built-in Job's Role).

`bind` with `resourceNames` is what makes (1) safe from privilege escalation in RBAC terms: the
gateway can only create RoleBindings to these two pre-existing, reviewed roles, and the API server's
escalation check would refuse a binding to anything else. What RBAC alone cannot express — _which
namespaces_ — is enforced by a **ValidatingAdmissionPolicy** (`<release>-store-guard`, fail closed,
`Deny`, matching only requests whose user is the gateway's ServiceAccount): a namespace it creates,
updates or deletes must be named `store-<slug>` and carry `urumi.io/store=true` plus Pod Security
`enforce=restricted`; it may update or delete only a namespace that already carried the store label;
a RoleBinding it creates must be in such a namespace, reference one of the two roles, and name only
the gateway (manager) or that namespace's `store-bootstrap` ServiceAccount (bootstrap). The store
client (`stores/kube.ts`) refuses the same things before sending. `tests/infra/stores-chart.sh`
renders the chart and fails on any deviation; D15 runs `kubectl auth can-i --as` the gateway
(cannot read Secrets in the release namespace, kube-system or a store namespace; cannot create pods
or Deployments in the release namespace, ClusterRoleBindings, Roles, or escalate/impersonate) and
shows the policy refusing a non-store namespace, deleting or relabelling another namespace, and a
RoleBinding to the manager role in the release namespace.

_The escalation tradeoff, stated plainly._ Inside a store namespace the gateway can create
NetworkPolicies, so a compromised gateway could open that store's own policies — but not the
release namespace's (its default deny still refuses traffic from stores) nor another store's. It
can create workloads there, subject to Pod Security `restricted` and the quota, with any image (the
store images are fixed in the gateway's code, not by the API server). It can delete store
namespaces (all stores' data). It can list namespace names cluster-wide. It cannot read any Secret,
exec into any pod, or touch the release namespace, kube-system or any namespace not created as a
store. Without the admission policy (`multiStore.admissionPolicy.enabled=false`, or a cluster
older than Kubernetes 1.30) the gateway could create and delete **any** namespace and bind the
manager role (Secret writes, workloads) in any namespace — do not run it that way outside a
throwaway cluster.

**Settings** come from the chart (`multiStore.*` plus the built-in store's `bootstrap`, image,
`networkPolicy` and `ingress` values) as one JSON env var `MULTI_STORE_CONFIG`, validated strictly at
startup (`stores/settings.ts`; a bad value names the field, never the value). `MULTI_STORE_MAX_STORES`
is a separate env var. `values-local.yaml`: on, max 3, `*.store.localtest.me`, `local-path`.
`values-prod.yaml`: **off** unless set (`domainSuffix`/TLS must be configured deliberately).

**Helm upgrade and rollback.** Stores are runtime objects owned by the gateway, not by the Helm
release: they are not in any rendered manifest, so `helm upgrade`, `helm rollback` and even
`helm uninstall` leave store namespaces alone (no `helm.sh` labels, no release ownership). After an
upgrade, the new gateway's provisioner compares each store's spec hash (annotation on the namespace,
over every object except Secret data) and re-applies changed objects (e.g. a new woo-mcp image or
NetworkPolicy shape); the Job is not re-run (a Job template is immutable; Retry runs a new one).
`helm rollback` to a revision without `multiStore` removes the ClusterRoles, the binding and the
admission policy: the previous gateway image ignores the `stores` table and `upstreams.store` column
(migration is additive), existing store upstream rows are then ordinary disabled/enabled rows it can
still call only if its SSRF allow-list admits them (it does not by default), and the store
namespaces keep running unmanaged until multi-store is re-enabled — or are removed by hand
(`kubectl delete ns -l urumi.io/store=true`). `--set multiStore.enabled=false` without a rollback:
the API lists rows but refuses creates/retries; delete marks rows but nothing removes namespaces
until it is turned back on.

## Consequences

- **Tested:** unit tests for manifests (namespace + labels, Pod Security, default deny, the exact
  set of allowed flows, no cross-store reference, hardening of every pod, token only in the publish
  container, the RoleBindings, quota vs. requests, no secret in any non-Secret object or in the
  hash), slug rules, the client's namespace guard, the phase machine (steps, pending reasons,
  ImagePullBackOff, Job failed, ReplicaFailure, crash threshold, timeout, sticky ready, deleting);
  integration tests on a real Postgres with the Kubernetes API faked at its boundary (admin-only,
  create, reserved/invalid/taken slugs, limit incl. concurrent creates, store rows protected from the
  upstream routes, the full provisioning path, create-once passwords, failed → Retry, rejected write,
  resume after a crash on another replica, the lease, delete incl. per-user rules, delete finished
  after a restart, slug reuse waits for a terminating namespace, garbage collection, the SSRF
  exception); `tests/infra/stores-chart.sh`; dashboard tests for the Stores page; e2e **D15** on k3d.
- **Not covered / limits:** one replica per store component (no HA); no backups of store databases;
  store upgrades of WordPress/WooCommerce happen only through Retry or WordPress itself; the
  WooCommerce zip is downloaded from wordpress.org on every bootstrap (≈ a minute on the local
  network; a cached image/volume would remove the internet dependency); https storefronts need a
  TLS Secret per namespace (not managed); local-path volumes are node-bound; no per-store admin login
  to the dashboard (store admins use wp-admin with the generated password, which only a cluster admin
  can read from the `store-admin` Secret); the quota is sized for an 8 GB laptop; on a store's first start
  WordPress restarts once (the official image's `tar` cannot chmod the root of a fresh local-path
  volume as uid 33 — the built-in store has the same behaviour; the second start is clean).
- **Cost:** one store ≈ 300–450 MiB of RAM at rest (MariaDB, WordPress, woo-mcp) plus ~200 MiB
  during the bootstrap Job.
