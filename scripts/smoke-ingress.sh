#!/usr/bin/env bash
# Smoke test for the local cluster, run after cluster-up.sh:
#   1. ingress:        nginx behind Traefik answers 200 on http://test.localtest.me
#   2. networkpolicy:  a default-deny policy really blocks pod-to-pod traffic
# Works in a throwaway namespace `smoke` that is deleted at the end.
# Prints PASS/FAIL per check; exits non-zero if any check fails.
#   HTTP_PORT  host ingress port, default 80 (match what cluster-up.sh used)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/common.sh"

HTTP_PORT=${HTTP_PORT:-80}
NS=smoke
URL="http://test.localtest.me:${HTTP_PORT}/"
SVC_URL="http://nginx.${NS}.svc.cluster.local/"

need kubectl "Install it with: brew install kubectl"
need curl "Install it with: brew install curl"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  say "Deleting namespace $NS"
  kc delete namespace "$NS" --ignore-not-found --wait=true --timeout=120s >/dev/null ||
    warn "namespace $NS was not deleted cleanly; delete it with: kubectl delete ns $NS"
}

# client_can_reach: true when the busybox pod gets an HTTP response from the nginx Service.
client_can_reach() {
  kc -n "$NS" exec deploy/client -- wget -q -T 3 -O /dev/null "$SVC_URL" >/dev/null 2>&1
}

if kc get namespace "$NS" >/dev/null 2>&1; then
  say "Removing leftover namespace $NS from an earlier run"
  kc delete namespace "$NS" --wait=true --timeout=120s >/dev/null
fi
trap cleanup EXIT

say "Deploying nginx + client into namespace $NS"
kc create namespace "$NS" >/dev/null
kc -n "$NS" apply -f "$ROOT/tests/infra/ingress-smoke.yaml" >/dev/null
kc -n "$NS" rollout status deploy/nginx --timeout=120s
kc -n "$NS" rollout status deploy/client --timeout=120s

# --- 1. Ingress -----------------------------------------------------------------------
say "Checking $URL (up to 60s)"
code=000
i=0
while [ "$i" -lt 30 ]; do
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$URL" || true)
  [ "$code" = "200" ] && break
  i=$((i + 1))
  sleep 2
done
if [ "$code" = "200" ]; then
  pass ingress
else
  fail ingress "$URL returned HTTP $code after 60s"
fi

# --- 2. NetworkPolicy -----------------------------------------------------------------
# Control first: without a policy the client must reach nginx, otherwise a later
# failure would prove nothing about NetworkPolicy.
say "Checking client -> nginx without a policy (control)"
reachable=0
i=0
while [ "$i" -lt 10 ]; do
  if client_can_reach; then
    reachable=1
    break
  fi
  i=$((i + 1))
  sleep 2
done

if [ "$reachable" -ne 1 ]; then
  fail networkpolicy "client could not reach $SVC_URL even before the deny policy (control failed)"
else
  say "Applying default-deny ingress policy; expecting client -> nginx to time out (up to 30s)"
  kc -n "$NS" apply -f "$ROOT/tests/infra/deny-all.yaml" >/dev/null
  # Two failures in a row, so one dropped packet is not mistaken for enforcement.
  blocked=0
  i=0
  while [ "$i" -lt 10 ]; do
    if ! client_can_reach && ! client_can_reach; then
      blocked=1
      break
    fi
    i=$((i + 1))
    sleep 2
  done
  if [ "$blocked" -eq 1 ]; then
    pass networkpolicy
  else
    fail networkpolicy "client still reached $SVC_URL 30s after default-deny; is the k3s NetworkPolicy controller disabled?"
  fi
fi

exit "$failed"
