# ADR 009 — Default-deny NetworkPolicies and a non-root WordPress

Status: accepted, merged to `main` (was proposed: G3: NetworkPolicy + securityContext changes; needs Aadi) · Brief stand-out item 6
("NetworkPolicies that deny by default, and containers that run as non-root") · Amends DESIGN §10,
THREAT_MODEL 3.4 / 3.7

## Context

Before this change only woo-mcp, server-everything and Postgres had (ingress-only) policies.
MariaDB, WordPress, the gateway and the dashboard accepted connections from any pod, and every
pod could open any outbound connection — a compromised WordPress plugin could reach Postgres'
port, a compromised gateway could reach MariaDB, and `everything`'s URL-fetching tool could reach
the internet. WordPress was the only workload whose main container started as root (the official
apache image binds port 80 as root, then Apache drops to www-data).

k3s (local k3d and the VPS target) enforces NetworkPolicy with its embedded kube-router
controller, ingress and egress.

## Decision

**Default deny, then one allow per real flow** (`charts/platform/templates/networkpolicy/`),
toggled by `networkPolicy.enabled` (default `true`; set explicitly in `values-local.yaml` and
`values-prod.yaml`):

| Policy                                                  | Selects            | Allows                                                                                                    |
| ------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `urumi-default-deny`                                    | every pod          | nothing (Ingress + Egress)                                                                                |
| `urumi-allow-dns`                                       | every pod          | egress UDP/TCP 53 to CoreDNS (`kube-system`, `k8s-app=kube-dns`)                                          |
| `urumi-{dashboard,gateway,gateway-canary}-from-ingress` | that component     | ingress TCP 8080 from Traefik (`kube-system`, `app.kubernetes.io/name=traefik`)                           |
| `urumi-wordpress-from-ingress`                          | WordPress          | ingress TCP 80 from Traefik                                                                               |
| `urumi-gateway-egress`                                  | gateway (+ canary) | Postgres 5432, woo-mcp 8080, everything 3001, internet 80/443 (private ranges excluded)                   |
| `urumi-woo-mcp-egress`                                  | woo-mcp            | WordPress 80                                                                                              |
| `urumi-wordpress`                                       | WordPress          | ingress 80 from woo-mcp + bootstrap; egress MariaDB 3306 (+ internet 80/443 if `wordpressInternetEgress`) |
| `urumi-mariadb`                                         | MariaDB            | ingress 3306 from WordPress + bootstrap                                                                   |
| `urumi-bootstrap-egress`                                | bootstrap Job      | MariaDB 3306, WordPress 80, Kubernetes API (`kubeApi.cidr`, 443/6443), internet 80/443                    |
| existing `urumi-{woo-mcp,everything,postgres}`          | that component     | ingress from gateway pods only (unchanged)                                                                |

Postgres, MariaDB, everything and the dashboard get **no egress** beyond DNS. "Internet" is
`0.0.0.0/0` minus 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 (cloud metadata) and 127/8,
so the internet rules cannot be used to reach in-cluster or VPC addresses. Pod-to-pod rules use
`podSelector` within the namespace; Traefik and CoreDNS are matched by namespace + pod labels,
configurable in `networkPolicy.ingressController` / `networkPolicy.dns` for other distributions.

Kubelet probes are not affected: kube-router accepts traffic from the node to its local pods.
`kubectl port-forward` (used by the e2e seed) enters the pod's network namespace through the
kubelet and is not subject to NetworkPolicy either.

**Non-root WordPress** (`wordpress.runAsNonRoot`, default `true`): the pod runs as uid/gid 33
(www-data, the docroot owner) with `runAsNonRoot`, `fsGroup: 33` (`OnRootMismatch`),
`allowPrivilegeEscalation: false` and all capabilities dropped. Port 80 stays: the pod sets the
namespaced sysctl `net.ipv4.ip_unprivileged_port_start=0`, which Kubernetes classifies as safe
(allowed without kubelet flags, permitted by the `restricted` Pod Security Standard). Alternatives
rejected: moving Apache to 8080 needs a mounted `ports.conf` + vhost override and a Service
targetPort change; `NET_BIND_SERVICE` keeps a capability. With this, every long-running container
in the chart is non-root (MariaDB 999, Postgres 70, gateway/woo-mcp/everything node 1000,
dashboard 101, WordPress 33; the bootstrap Job already ran as 33).

**Tests.** `tests/infra/chart-checks.sh` (offline) now fails if a default deny for Ingress +
Egress is missing or any Deployment/StatefulSet/Job is not selected by at least one allow policy.
`tests/infra/netpol-default-deny.sh` (live) runs two busybox pods: one without platform labels
reaches nothing (DNS only), one with the gateway's policy labels reaches exactly Postgres,
woo-mcp and everything but not MariaDB or WordPress. The full e2e (D1–D8) runs with the policies
on. Evidence: `docs/NETWORK_POLICIES.md`.

## Consequences

- An admin-registered upstream inside the cluster (other than woo-mcp/everything) is unreachable
  from the gateway even if allow-listed for the SSRF guard; add an egress rule for it.
- The bootstrap Job's API rule is wide by default (`kubeApi.cidr: 0.0.0.0/0` on 443/6443): the API
  server endpoint is a node address that differs per cluster. Narrow it per environment.
- Clusters whose CNI ignores NetworkPolicy (e.g. plain flannel without a policy controller) render
  the objects but enforce nothing; k3s enforces them.
- Rollback: `helm rollback` removes the new policies (they are ordinary chart resources);
  `--set networkPolicy.enabled=false` disables them without a rollback.
