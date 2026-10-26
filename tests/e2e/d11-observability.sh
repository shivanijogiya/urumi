#!/usr/bin/env bash
# D11 (observability, ADR 011):
#   1. a pod labelled urumi.io/metrics-scraper=true scrapes GET /metrics on every gateway pod's
#      internal port 9464 (Prometheus text: process metrics, tool_calls_total, histogram,
#      upstream_up{server="everything"} 1);
#   2. after 3 everything__echo calls over MCP (admin key), tool_calls_total{server="everything",
#      tool="echo",outcome="ok",source="mcp"} summed over the gateway pods grew by >= 3;
#   3. an UNlabelled pod cannot reach port 9464 (NetworkPolicy), and $APP_URL/metrics through the
#      Ingress never returns Prometheus text;
#   4. GET /api/metrics/summary (admin) reports everything's calls with p50/p95, status up and a
#      last-OK time; a call to an unknown tool shows up with reason unknown_tool.
# Uses the seed admin (D8 checks only Users A and B).
set -uo pipefail
STEP=${STEP:-D11}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

NS=${NAMESPACE:-urumi}
KCTX=${KUBE_CONTEXT:-k3d-urumi}
k() { kubectl --context "$KCTX" -n "$NS" "$@"; }
SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=gateway"
PORT=9464
SCRAPER="d11-scraper-$RUN_ID"
OUTSIDER="d11-outsider-$RUN_ID"
KEY="$E2E_OUT/d11.key"
key_id=""

cleanup() {
  k delete pod "$SCRAPER" "$OUTSIDER" --wait=false --ignore-not-found >/dev/null 2>&1
  [ -n "$key_id" ] && api "$ADMIN_JAR" DELETE "/api/keys/$key_id" >/dev/null
  rm -f "$KEY"
}
trap cleanup EXIT

# Throwaway pods from the gateway image (already on every node; busybox wget, runs as `node`).
image=$(k get deploy "$RELEASE-gateway" -o jsonpath='{.spec.template.spec.containers[0].image}')
[ -n "$image" ] || fail "cannot read the gateway image"
start_pod() { # start_pod <name> [label]
  local labels=()
  [ -n "${2:-}" ] && labels=(--labels "$2")
  k run "$1" --image "$image" --image-pull-policy IfNotPresent --restart Never "${labels[@]}" \
    --overrides '{"spec":{"automountServiceAccountToken":false,"containers":[{"name":"'"$1"'","image":"'"$image"'","command":["sleep","300"],"resources":{"requests":{"cpu":"5m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"64Mi"}},"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
    >/dev/null || fail "kubectl run $1 failed"
}
start_pod "$SCRAPER" urumi.io/metrics-scraper=true
start_pod "$OUTSIDER"
k wait --for=condition=Ready "pod/$SCRAPER" "pod/$OUTSIDER" --timeout=90s >/dev/null ||
  fail "scraper pods did not become Ready"

ips=$(k get pods -l "$SEL" -o jsonpath='{range .items[?(@.status.podIP)]}{.status.podIP}{" "}{end}')
[ -n "$ips" ] || fail "no gateway pod IPs"
scrape() { k exec "$SCRAPER" -- wget -q -T 5 -O - "http://$1:$PORT/metrics"; }
# echo_ok_total : tool_calls_total for everything/echo/ok/mcp summed over the gateway pods.
echo_ok_total() {
  local sum=0 ip v
  for ip in $ips; do
    v=$(scrape "$ip" | awk '/^tool_calls_total\{server="everything",tool="echo",outcome="ok",source="mcp"\}/ {print $2}')
    sum=$((sum + ${v:-0}))
  done
  echo "$sum"
}

# ── 1. Scrape every pod ──────────────────────────────────────────────────────────────────────
for ip in $ips; do
  body=$(scrape "$ip") || fail "scraper pod could not GET http://$ip:$PORT/metrics"
  for m in process_cpu_user_seconds_total '# TYPE tool_calls_total counter' \
    '# TYPE tool_call_duration_seconds histogram' 'upstream_up{server="everything"} 1' \
    'upstream_last_check_timestamp_seconds{server="everything"}' '# TYPE rate_limited_total counter'; do
    grep -qF -- "$m" <<<"$body" || fail "pod $ip /metrics lacks: $m"
  done
  note "pod $ip: $(printf '%s\n' "$body" | grep -c '^[a-z]') samples; $(printf '%s\n' "$body" | grep '^upstream_up' | tr '\n' ' ')"
done

# ── 2. Counters move after tool calls ────────────────────────────────────────────────────────
before=$(echo_ok_total)
code=$(jq -n --arg n "e2e $RUN_ID d11" '{name: $n}' | api "$ADMIN_JAR" POST /api/keys)
[ "$code" = 201 ] || fail "create admin key -> HTTP $code: $(err_of)"
jq -r .secret "$LAST" >"$KEY"
chmod 600 "$KEY"
key_id=$(jq -r .key.id "$LAST")
: >"$LAST"
for i in 1 2 3; do
  r=$(mcp "$KEY" call everything__echo "{\"message\":\"d11-$i\"}")
  printf '%s' "$r" | jq -e '.isError != true and .content' >/dev/null || fail "everything__echo failed: $r"
done
bad=$(mcp "$KEY" call everything__no_such_tool_d11 '{}')
after=$(echo_ok_total)
note "tool_calls_total{server=everything,tool=echo,outcome=ok,source=mcp} summed over pods: $before -> $after"
[ "$after" -ge $((before + 3)) ] || fail "counter did not grow by 3 after 3 calls ($before -> $after)"
# Here-strings, not `scrape | grep -q`: grep -q exiting early would SIGPIPE the scrape and, under
# pipefail, turn a match into a non-match.
for ip in $ips; do
  body=$(scrape "$ip")
  grep -q '^tool_calls_total{server="_unresolved",tool="_unresolved",outcome="denied"' <<<"$body" &&
    note "pod $ip counted the unknown-tool call under _unresolved"
  if grep -q 'no_such_tool' <<<"$body"; then fail "caller input became a metric label on $ip"; fi
done

# ── 3. Not reachable from an unlabelled pod, nor through the Ingress ─────────────────────────
first=$(printf '%s' "$ips" | awk '{print $1}')
if k exec "$OUTSIDER" -- wget -q -T 4 -O - "http://$first:$PORT/metrics" >/dev/null 2>&1; then
  fail "an unlabelled pod reached the metrics port (NetworkPolicy missing)"
fi
note "unlabelled pod -> $first:$PORT blocked (as expected)"
if k exec "$OUTSIDER" -- wget -q -T 4 -O - "http://$RELEASE-gateway-metrics:$PORT/metrics" >/dev/null 2>&1; then
  fail "an unlabelled pod reached the metrics Service"
fi
ing=$(curl -sS --max-time 10 "$APP_URL/metrics" || true)
if grep -qE '^# (TYPE|HELP) |tool_calls_total' <<<"$ing"; then
  fail "$APP_URL/metrics returned Prometheus text through the Ingress"
fi
note "$APP_URL/metrics via Ingress: no Prometheus text ($(printf '%s' "$ing" | head -c 60 | tr '\n' ' ')…)"

# ── 4. Dashboard summary (from audit_log, all replicas) ──────────────────────────────────────
code=$(api "$ADMIN_JAR" GET "/api/metrics/summary?windowMinutes=15")
[ "$code" = 200 ] || fail "GET /api/metrics/summary -> HTTP $code: $(err_of)"
ev=$(jq -c '.servers[] | select(.serverSlug == "everything")' "$LAST")
[ -n "$ev" ] || fail "summary has no everything row"
printf '%s' "$ev" | jq -e '.calls >= 3 and .p50Ms != null and .p95Ms != null and .upstream.status == "up" and .upstream.lastOkAt != null' >/dev/null ||
  fail "everything summary row is incomplete: $ev"
printf '%s' "$ev" | jq -e '[.topErrors[] | select(.reason == "unknown_tool")] | length >= 1' >/dev/null ||
  fail "the unknown-tool call is not in everything's topErrors: $ev"
note "summary: leader=$(jq -r .healthLeader "$LAST") totals=$(jq -c .totals "$LAST")"
note "everything: $(printf '%s' "$ev" | jq -c '{calls, errorRate, p50Ms, p95Ms, topErrors: [.topErrors[] | {errorDetail, reason, count}], status: .upstream.status, lastOkAt: .upstream.lastOkAt}')"
printf '%s' "$bad" | jq -e '.isError == true' >/dev/null || fail "unknown tool did not fail: $bad"
pass
