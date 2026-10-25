# Network policies and non-root containers — evidence

Design and rationale: [ADR 009](adr/009-network-policies.md). Templates:
`charts/platform/templates/networkpolicy/`. Recorded on the local k3d cluster (`k3d-urumi`, k3s
v1.35.5, kube-router policy controller) on 2026-10-26, release `urumi` revision 21 (chart from
branch `feat/default-deny-netpol`, gateway/dashboard images as deployed from `main`).

## Install

```sh
helm upgrade --install urumi charts/platform -n urumi -f charts/platform/values-local.yaml --wait
kubectl -n urumi get netpol
```

```
NAME                           POD-SELECTOR
urumi-allow-dns                <none>
urumi-bootstrap-egress         app.kubernetes.io/component=bootstrap,...
urumi-dashboard-from-ingress   app.kubernetes.io/component=dashboard,...
urumi-default-deny             <none>
urumi-everything               app.kubernetes.io/component=everything,...
urumi-gateway-egress           app.kubernetes.io/component in (gateway),app.kubernetes.io/instance=urumi
urumi-gateway-from-ingress     app.kubernetes.io/component=gateway,...
urumi-mariadb                  app.kubernetes.io/component=mariadb,...
urumi-postgres                 app.kubernetes.io/component=postgres,...
urumi-woo-mcp                  app.kubernetes.io/component=woo-mcp,...
urumi-woo-mcp-egress           app.kubernetes.io/component=woo-mcp,...
urumi-wordpress                app.kubernetes.io/component=wordpress,...
urumi-wordpress-from-ingress   app.kubernetes.io/component=wordpress,...
```

The bootstrap hook Job (MariaDB, WordPress, Kubernetes API, wordpress.org) completed under the
policies: `Existing Application Password still authenticates; keeping it`.

## Negative test: a pod in the namespace reaches nothing

`tests/infra/netpol-default-deny.sh` runs two throwaway busybox pods and opens TCP connections
(`nc -w 3`) to each Service by DNS name:

```
$ tests/infra/netpol-default-deny.sh
==> Probe 1: a pod without platform labels
PASS outsider -> dns: open
PASS outsider -> woo-mcp: closed
PASS outsider -> everything: closed
PASS outsider -> postgres: closed
PASS outsider -> mariadb: closed
PASS outsider -> gateway: closed
PASS outsider -> wordpress: closed
PASS outsider -> internet: closed
==> Probe 2: a pod with the gateway's policy labels (not selected by any Service)
PASS gateway-like -> dns: open
PASS gateway-like -> postgres: open
PASS gateway-like -> woo-mcp: open
PASS gateway-like -> everything: open
PASS gateway-like -> mariadb: closed
PASS gateway-like -> wordpress: closed
```

Probe 2 is the positive control: the same pod image and checks succeed exactly where a policy
allows the flow, so the `closed` results are the policies, not DNS or the probe.

The older woo-mcp isolation test still passes with default deny on:

```
$ tests/infra/woo-mcp-netpol.sh
PASS service/urumi-woo-mcp is ClusterIP
PASS no Ingress (any namespace) references woo-mcp
PASS pod without gateway label: connection to woo-mcp refused by policy (curl exit 7, kube-router REJECT)
PASS gateway-labelled pod: GET /healthz 200
PASS gateway-labelled pod: tools/list with secret -> create_product,get_order,list_orders,list_products,update_order_status
PASS gateway-labelled pod: tools/list without secret -> 401
PASS gateway pod: GET $WOO_MCP_URL/../healthz 200
PASS gateway pod: tools/list via WOO_MCP_URL -> create_product,get_order,list_orders,list_products,update_order_status
```

## Every real flow still works: full e2e with the policies on

Traefik → dashboard/gateway/WordPress (D1–D8 all go through the Ingress), gateway → Postgres,
woo-mcp, everything, Anthropic (D2, D4) and GitLab (D3 lists `gitlab__` tools), woo-mcp →
WordPress (every `woo__` call):

```
$ tests/e2e/run.sh all
PASS seed
PASS D1
PASS D2
PASS D3
PASS D4
PASS D5
PASS D6
PASS D7
PASS D8
```

## Offline check

`tests/infra/chart-checks.sh` renders both values files (with and without the canary) and fails if
the default deny is missing or a workload is selected by no allow policy:

```
$ tests/infra/chart-checks.sh
PASS chart-checks (values-local.yaml)
PASS chart-checks (values-prod.yaml)
PASS chart-checks (values-local.yaml+canary)
PASS chart-checks (values-prod.yaml+canary)
$ tests/infra/chart-checks.sh --set networkPolicy.enabled=false   # proves the check bites
  Deployment/urumi-dashboard: no allow NetworkPolicy selects its pods
  Deployment/urumi-gateway: no allow NetworkPolicy selects its pods
  ...
FAIL chart-checks (values-local.yaml)
```

## Non-root WordPress

```
$ kubectl -n urumi exec deploy/urumi-wordpress -- sh -c 'id; grep -E "^(Uid|CapEff)" /proc/1/status; ps -o user,pid,cmd | head -3'
uid=33(www-data) gid=33(www-data) groups=33(www-data)
Uid:	33	33	33	33
CapEff:	0000000000000000
USER         PID CMD
www-data       1 apache2 -DFOREGROUND
www-data      19 apache2 -DFOREGROUND
```

Apache is PID 1 as www-data with no effective capabilities; it binds port 80 through the pod sysctl
`net.ipv4.ip_unprivileged_port_start=0`. All other long-running containers already ran non-root
(MariaDB 999, Postgres 70, gateway / woo-mcp / everything 1000, dashboard 101).

## Turning it off

`--set networkPolicy.enabled=false` removes every policy added here (the three older per-component
ingress policies keep their own toggles); `--set wordpress.runAsNonRoot=false` restores the image's
root start.
