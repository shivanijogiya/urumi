#!/usr/bin/env bash
# Default-deny NetworkPolicy test (brief item 6; docs/adr/009-network-policies.md), run against the
# installed release. Starts two throwaway busybox pods in the namespace and tries TCP connections:
#   1. "outsider" (no platform labels): DNS works (the allow-dns policy), but it can reach none of
#      woo-mcp, everything, Postgres, MariaDB, the gateway, WordPress, nor the internet.
#   2. "gateway-like" (labels instance=<release>, component=gateway, but NOT app.kubernetes.io/name,
#      so no Service routes traffic to it): it CAN reach Postgres, woo-mcp and everything (positive
#      control: the policies allow exactly the gateway's flows) and still cannot reach MariaDB or
#      WordPress.
# Prints one `PASS`/`FAIL` line per expectation; exits non-zero if any fails. Probe pods are named
# per run and deleted on exit. Uses k3s's cached busybox image (no pull needed on k3d).
#   RELEASE        Helm release name, default urumi
#   PROBE_IMAGE    default rancher/mirrored-library-busybox:1.37.0
#   tests/infra/netpol-default-deny.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"

RELEASE=${RELEASE:-urumi}
PROBE_IMAGE=${PROBE_IMAGE:-rancher/mirrored-library-busybox:1.37.0}
RUN_ID="$(date +%s)-$$"
OUTSIDER="netpol-outsider-$RUN_ID"
GWLIKE="netpol-gwlike-$RUN_ID"
NS_DOMAIN="$NAMESPACE.svc.cluster.local"

need kubectl "Install it with: brew install kubectl"
require_context

cleanup() { kubectl -n "$NAMESPACE" delete pod "$OUTSIDER" "$GWLIKE" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

# probe <pod> <labels> : runs every check inside one pod; prints `<name> open|closed` lines.
# Targets are Service names (DNS is allowed for every pod), so a `closed` is the policy, not DNS.
probe() {
  kubectl -n "$NAMESPACE" run "$1" --image="$PROBE_IMAGE" --restart=Never --labels="$2" \
    --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"'"$1"'","image":"'"$PROBE_IMAGE"'","command":["sh","-c","'"$PROBE_SCRIPT"'"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"32Mi"}}}]}}' \
    >/dev/null
  kubectl -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$1" --timeout=120s >/dev/null ||
    die "probe pod $1 did not finish: $(kubectl -n "$NAMESPACE" get pod "$1" -o jsonpath='{.status.phase}')"
  kubectl -n "$NAMESPACE" logs "$1"
}

# nc -w 3: connect within 3 s or give up (kube-router rejects or drops denied packets).
PROBE_SCRIPT=$(
  cat <<EOF | tr '\n' ';'
t() { if nc -w 3 \$2 \$3 </dev/null >/dev/null 2>&1; then echo \$1 open; else echo \$1 closed; fi; }
if nslookup $RELEASE-postgres.$NS_DOMAIN >/dev/null 2>&1; then echo dns open; else echo dns closed; fi
t woo-mcp $RELEASE-woo-mcp.$NS_DOMAIN 80
t everything $RELEASE-everything.$NS_DOMAIN 80
t postgres $RELEASE-postgres.$NS_DOMAIN 5432
t mariadb $RELEASE-mariadb.$NS_DOMAIN 3306
t gateway $RELEASE-gateway.$NS_DOMAIN 80
t wordpress $RELEASE-wordpress.$NS_DOMAIN 80
t internet 1.1.1.1 443
EOF
)

failed=0
# expect <output> <who> <target> <open|closed>
expect() {
  local got
  got=$(printf '%s\n' "$1" | awk -v t="$3" '$1 == t {print $2}')
  if [ "$got" = "$4" ]; then
    echo "PASS $2 -> $3: $got"
  else
    echo "FAIL $2 -> $3: expected $4, got ${got:-nothing}"
    failed=1
  fi
}

say "Probe 1: a pod without platform labels"
out=$(probe "$OUTSIDER" "app=netpol-probe")
expect "$out" outsider dns open
for t in woo-mcp everything postgres mariadb gateway wordpress internet; do
  expect "$out" outsider "$t" closed
done

say "Probe 2: a pod with the gateway's policy labels (not selected by any Service)"
out=$(probe "$GWLIKE" "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=gateway")
for t in dns postgres woo-mcp everything; do expect "$out" gateway-like "$t" open; done
for t in mariadb wordpress; do expect "$out" gateway-like "$t" closed; done

exit "$failed"
