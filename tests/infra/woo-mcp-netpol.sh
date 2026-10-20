#!/usr/bin/env bash
# woo-mcp isolation test (W3, K5), run against the installed release:
#   1. no Ingress references woo-mcp; the woo-mcp Service is type ClusterIP
#   2. a temporary curl pod WITHOUT the gateway label cannot connect to woo-mcp (curl times out,
#      or on k3s's kube-router is rejected; see check 2)
#   3. a temporary curl pod WITH the gateway labels gets /healthz 200, POST /mcp tools/list with
#      the shared-secret header returns the 5 woo tools, and the same call without it gets 401
#   4. the real gateway pod (node) reaches /healthz and tools/list via its WOO_MCP_URL and
#      WOO_MCP_SHARED_SECRET env vars
# Idempotent: probe pods are named per run and deleted on exit. Never prints a secret: inside a
# probe pod the shared secret comes from an env var populated by secretKeyRef and is fed to curl
# as a header file on stdin (printf is a shell builtin, so it is never in any argv); in the
# gateway pod node reads it from the environment.
# Prints PASS/FAIL per check; exits non-zero if any check fails.
#   RELEASE     Helm release name, default urumi
#   ENV_SECRET  Secret holding WOO_MCP_SHARED_SECRET, default urumi-env
#   CURL_IMAGE  default curlimages/curl:8.11.1
#   tests/infra/woo-mcp-netpol.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"

RELEASE=${RELEASE:-urumi}
ENV_SECRET=${ENV_SECRET:-urumi-env}
CURL_IMAGE=${CURL_IMAGE:-curlimages/curl:8.11.1}
SVC="${RELEASE}-woo-mcp"
GW_DEPLOY="${RELEASE}-gateway"
WOO_SELECTOR="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=woo-mcp"
BASE="http://${SVC}.${NAMESPACE}.svc.cluster.local"
EXPECTED_TOOLS="create_product,get_order,list_orders,list_products,update_order_status"
RUN_ID="$(date +%s)-$$"
DENY_POD="woo-netpol-deny-$RUN_ID"
ALLOW_POD="woo-netpol-allow-$RUN_ID"
# Set here, not in run_probe: that runs in a $(...) subshell, so it cannot update the trap's list.
PROBES="$DENY_POD $ALLOW_POD"

need kubectl "Install it with: brew install kubectl"
need node "Install Node.js 22"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}

cleanup() {
  local p
  for p in $PROBES; do
    kc -n "$NAMESPACE" delete pod "$p" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# tool_names: tools/list JSON-RPC response on stdin -> sorted comma-separated names (or an error).
tool_names() {
  node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      try {
        const names = JSON.parse(s).result.tools.map((t) => t.name).sort();
        console.log(names.join(","));
      } catch {
        console.log("<not a tools/list result>");
      }
    });'
}

# run_probe <name> <labels-json> <script>: runs <script> with sh in a one-shot curl pod (env
# WOO_MCP_SHARED_SECRET from the Secret), waits for it to finish and prints its log.
run_probe() {
  local name=$1 labels=$2 script=$3 phase="" i
  kc -n "$NAMESPACE" apply -f - >/dev/null <<EOF
{
  "apiVersion": "v1",
  "kind": "Pod",
  "metadata": { "name": "$name", "labels": $labels },
  "spec": {
    "restartPolicy": "Never",
    "automountServiceAccountToken": false,
    "securityContext": {
      "runAsNonRoot": true, "runAsUser": 100, "runAsGroup": 101,
      "seccompProfile": { "type": "RuntimeDefault" }
    },
    "containers": [{
      "name": "curl",
      "image": "$CURL_IMAGE",
      "command": ["sh", "-c", $(printf '%s' "$script" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify(s)))')],
      "env": [{
        "name": "WOO_MCP_SHARED_SECRET",
        "valueFrom": { "secretKeyRef": { "name": "$ENV_SECRET", "key": "WOO_MCP_SHARED_SECRET" } }
      }],
      "securityContext": {
        "allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
        "capabilities": { "drop": ["ALL"] }
      },
      "resources": {
        "requests": { "cpu": "10m", "memory": "16Mi" },
        "limits": { "cpu": "200m", "memory": "64Mi" }
      }
    }]
  }
}
EOF
  for i in $(seq 1 90); do
    phase=$(kc -n "$NAMESPACE" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded | Failed) break ;; esac
    sleep 2
  done
  case "$phase" in
    Succeeded | Failed) kc -n "$NAMESPACE" logs "$name" 2>&1 || true ;;
    *) echo "PROBE_STUCK phase=${phase:-none} after 180s" ;;
  esac
}

# field <KEY> <log>: value after "KEY " on the probe's output line.
field() { printf '%s\n' "$2" | sed -n "s/^$1 //p" | tail -n 1; }

# Probe script shared by the labelled pod. Retries /healthz for up to ~40s: the network policy
# controller adds a new pod's IP to the allow list a moment after the pod starts.
CURL_OPTS="-sS --connect-timeout 5 --max-time 15"
MCP_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
ALLOWED_SCRIPT="
code=000
for i in 1 2 3 4 5 6 7 8; do
  code=\$(curl $CURL_OPTS -o /dev/null -w '%{http_code}' $BASE/healthz 2>/dev/null) && break
  sleep 2
done
echo \"HEALTHZ \$code\"
echo \"NOAUTH \$(curl $CURL_OPTS -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '$MCP_BODY' $BASE/mcp)\"
tools=\$(printf 'x-woo-mcp-secret: %s\n' \"\$WOO_MCP_SHARED_SECRET\" | curl $CURL_OPTS -X POST \
  -H @- -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '$MCP_BODY' $BASE/mcp)
echo \"TOOLS \$(printf '%s' \"\$tools\" | tr -d '\n')\"
"

# --- 1. No Ingress, ClusterIP -------------------------------------------------------------------
if ! kc -n "$NAMESPACE" get svc "$SVC" >/dev/null 2>&1; then
  fail "woo-mcp Service exists" "service/$SVC not found (is wooMcp.enabled?)"
  exit 1
fi
svc_type=$(kc -n "$NAMESPACE" get svc "$SVC" -o jsonpath='{.spec.type}')
if [ "$svc_type" = ClusterIP ]; then
  pass "service/$SVC is ClusterIP"
else
  fail "service/$SVC is ClusterIP" "type is $svc_type"
fi
ingress_hits=$(kc get ingress -A -o json | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const hits = JSON.parse(s).items
      .filter((i) => JSON.stringify(i.spec || {}).includes("woo-mcp"))
      .map((i) => `${i.metadata.namespace}/${i.metadata.name}`);
    console.log(hits.join(" "));
  });')
if [ -z "$ingress_hits" ]; then
  pass "no Ingress (any namespace) references woo-mcp"
else
  fail "no Ingress references woo-mcp" "found: $ingress_hits"
fi

say "Waiting for woo-mcp to be Ready"
if ! kc -n "$NAMESPACE" rollout status "deployment/$SVC" --timeout=300s >/dev/null ||
  ! kc -n "$NAMESPACE" wait --for=condition=Ready pod -l "$WOO_SELECTOR" --timeout=120s >/dev/null; then
  fail "woo-mcp Ready" "not Ready within the timeout"
  exit 1
fi

# --- 2. Unlabelled pod is blocked ---------------------------------------------------------------
say "Probing from a pod without the gateway label"
out=$(run_probe "$DENY_POD" '{"app.kubernetes.io/name": "infra-test"}' "
curl -sS --connect-timeout 5 --max-time 8 -o /dev/null $BASE/healthz 2>/dev/null
echo \"EXIT \$?\"
")
deny_exit=$(field EXIT "$out")
# How a blocked connection fails depends on the policy engine: dropping CNIs (Calico, Cilium)
# make it time out (curl 28); k3s's built-in kube-router answers with
# `REJECT --reject-with icmp-port-unreachable`, so it is refused at once (curl 7). Either way no TCP
# connection exists. Check 3 below (same Service, same port, gateway labels) is the control that
# proves woo-mcp itself is up and reachable, so this failure is the policy.
case "$deny_exit" in
  28) pass "pod without gateway label: connection to woo-mcp times out (curl exit 28, dropped)" ;;
  7) pass "pod without gateway label: connection to woo-mcp refused by policy (curl exit 7, kube-router REJECT)" ;;
  *) fail "pod without gateway label is blocked" "curl exit '${deny_exit:-?}' (want 28 timeout or 7 rejected); ${out//$'\n'/ | }" ;;
esac

# --- 3. Gateway-labelled pod is allowed ---------------------------------------------------------
# Labels match the NetworkPolicy (instance + component) but not the gateway Service selector
# (which also needs app.kubernetes.io/name), so the probe never receives gateway traffic.
say "Probing from a pod with the gateway label"
out=$(run_probe "$ALLOW_POD" \
  "{\"app.kubernetes.io/instance\": \"$RELEASE\", \"app.kubernetes.io/component\": \"gateway\"}" \
  "$ALLOWED_SCRIPT")
healthz=$(field HEALTHZ "$out")
noauth=$(field NOAUTH "$out")
tools=$(field TOOLS "$out" | tool_names)
[ "$healthz" = 200 ] && pass "gateway-labelled pod: GET /healthz 200" ||
  fail "gateway-labelled pod: GET /healthz 200" "got '${healthz:-?}'"
[ "$tools" = "$EXPECTED_TOOLS" ] && pass "gateway-labelled pod: tools/list with secret -> $tools" ||
  fail "gateway-labelled pod: tools/list with secret" "got '$tools'"
[ "$noauth" = 401 ] && pass "gateway-labelled pod: tools/list without secret -> 401" ||
  fail "gateway-labelled pod: tools/list without secret -> 401" "got '${noauth:-?}'"

# --- 4. The real gateway pod --------------------------------------------------------------------
say "Probing from the gateway pod via WOO_MCP_URL"
# shellcheck disable=SC2016 # JS source, not shell
GW_JS='
const url = process.env.WOO_MCP_URL;
const secret = process.env.WOO_MCP_SHARED_SECRET;
if (!url || !secret) { console.log("HEALTHZ missing-env"); process.exit(0); }
const t = () => AbortSignal.timeout(10000);
(async () => {
  try {
    const h = await fetch(new URL("/healthz", url), { signal: t() });
    console.log("HEALTHZ " + h.status);
    const r = await fetch(url, {
      method: "POST",
      signal: t(),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-woo-mcp-secret": secret,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    console.log("TOOLS " + (await r.text()).replace(/\n/g, ""));
  } catch (e) {
    console.log("HEALTHZ error " + (e.cause?.code || e.name));
  }
})();'
out=$(kc -n "$NAMESPACE" exec "deploy/$GW_DEPLOY" -c gateway -- node -e "$GW_JS" 2>&1 || true)
healthz=$(field HEALTHZ "$out")
tools=$(field TOOLS "$out" | tool_names)
[ "$healthz" = 200 ] && pass "gateway pod: GET \$WOO_MCP_URL/../healthz 200" ||
  fail "gateway pod: GET /healthz 200" "got '${healthz:-?}'"
[ "$tools" = "$EXPECTED_TOOLS" ] && pass "gateway pod: tools/list via WOO_MCP_URL -> $tools" ||
  fail "gateway pod: tools/list via WOO_MCP_URL" "got '$tools'"

exit "$failed"
