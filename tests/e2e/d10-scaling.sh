#!/usr/bin/env bash
# D10 (scaling, ADR 010): two gateway replicas behind the Ingress.
#   1. the stable gateway Deployment has 2 ready pods;
#   2. ONE MCP client session (official SDK, admin API key) runs initialize + 60 x (tools/list +
#      tools/call everything__echo); after 20 iterations both pods' logs show /mcp requests from
#      this run (traffic is spread over both), then one pod is deleted mid-run; every one of the
#      60 iterations must succeed (stateless /mcp + preStop drain: no sticky session to lose);
#   3. the Deployment is back to 2 ready pods, and the upstream health loop keeps writing
#      last_checked_at after the kill (the `health` lease moved or stayed; one writer);
#   4. a burst of 150 pings with a second key gets HTTP 429 with Retry-After and error code
#      RATE_LIMITED once the key's bucket (values-local: burst 100) is empty, and the audit log
#      has `rate_limited` rows for the admin. Both keys are revoked at the end.
# Uses the seed admin (D8 checks only Users A and B, so its rows do not disturb D8).
set -uo pipefail
STEP=${STEP:-D10}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

NS=${NAMESPACE:-urumi}
KCTX=${KUBE_CONTEXT:-k3d-urumi}
k() { kubectl --context "$KCTX" -n "$NS" "$@"; }
SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=gateway"
LOAD="$E2E_DIR/lib/mcp-load.mjs"
ITER=${D10_ITERATIONS:-60}

ready_pods() {
  k get pods -l "$SEL" -o json |
    jq -r '.items[] | select(.metadata.deletionTimestamp == null) |
      select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) | .metadata.name'
}
two_ready() { [ "$(ready_pods | wc -l | tr -d ' ')" -ge 2 ]; }

# ── 1. Two ready replicas ────────────────────────────────────────────────────────────────────
want=$(k get deploy "$RELEASE-gateway" -o jsonpath='{.spec.replicas}')
[ "${want:-0}" -ge 2 ] || fail "gateway Deployment has spec.replicas=$want (values-local.yaml sets 2)"
poll 120 two_ready || fail "fewer than 2 ready gateway pods: $(ready_pods | tr '\n' ' ')"
pods=$(ready_pods)
note "ready gateway pods: $(printf '%s' "$pods" | tr '\n' ' ')"

# ── Keys (admin; revoked on exit) ────────────────────────────────────────────────────────────
[ "$(api "$ADMIN_JAR" GET /api/auth/me)" = 200 ] || fail "admin session expired; run: tests/e2e/run.sh seed"
ADMIN_ID=$(jq -r .user.id "$LAST")
KEY1="$E2E_OUT/d10-load.key"
KEY2="$E2E_OUT/d10-burst.key"
key_ids=""
new_key() { # new_key <file> <label>
  local code
  code=$(jq -n --arg n "e2e $RUN_ID d10 $2" '{name: $n}' | api "$ADMIN_JAR" POST /api/keys)
  [ "$code" = 201 ] || fail "create key -> HTTP $code: $(err_of)"
  rm -f "$1"
  jq -r .secret "$LAST" >"$1"
  chmod 600 "$1"
  key_ids="$key_ids $(jq -r .key.id "$LAST")"
  : >"$LAST"
}
cleanup() {
  for id in $key_ids; do api "$ADMIN_JAR" DELETE "/api/keys/$id" >/dev/null; done
  rm -f "$KEY1" "$KEY2"
  [ -n "${load_pid:-}" ] && kill "$load_pid" 2>/dev/null
}
trap cleanup EXIT
new_key "$KEY1" load
new_key "$KEY2" burst

# ── 2. One session, many calls, a pod killed mid-run ─────────────────────────────────────────
start=$(server_now) || fail "gateway not reachable at $APP_URL"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
progress="$E2E_OUT/d10.progress"
result="$E2E_OUT/d10-load.json"
echo 0 >"$progress"
MCP_KEY_FILE=$KEY1 node "$LOAD" "$MCP_URL" session "$ITER" everything__echo '{"message":"d10"}' \
  "$progress" >"$result" &
load_pid=$!
at_least() { [ "$(cat "$progress" 2>/dev/null || echo 0)" -ge "$1" ]; }
poll 120 at_least 20 || fail "load session made no progress ($(cat "$progress") iterations)"

mcp_lines() { k logs "$1" --since-time="$since" 2>/dev/null | grep -c '"url":"/mcp"'; }
spread=""
for p in $pods; do
  n=$(mcp_lines "$p")
  spread="$spread $p=$n"
  [ "${n:-0}" -gt 0 ] || fail "pod $p served no /mcp request of this run (no spread over replicas):$spread"
done
note "/mcp requests per pod after $(cat "$progress") iterations:$spread"

victim=$(printf '%s\n' "$pods" | head -1)
note "deleting gateway pod $victim mid-run (iteration $(cat "$progress")/$ITER)"
killed_at=$(server_now)
k delete pod "$victim" --wait=false >/dev/null || fail "kubectl delete pod $victim failed"

wait "$load_pid"
load_pid=""
summary=$(cat "$result")
note "load: $(printf '%s' "$summary" | jq -c '{iterations, ok, failed, ms, errors: .errors[:3]}')"
[ "$(printf '%s' "$summary" | jq -r .ok)" = "$ITER" ] ||
  fail "session calls failed after/while a pod was killed: $(printf '%s' "$summary" | jq -c '{ok, failed, errors: .errors[:3]}')"
for p in $pods; do
  [ "$p" = "$victim" ] && continue
  note "survivor $p served $(mcp_lines "$p") /mcp requests in this run"
done

# ── 3. Back to two replicas; the health loop still writes ────────────────────────────────────
poll 180 two_ready || fail "gateway did not return to 2 ready pods after deleting $victim"
note "ready gateway pods after the kill: $(ready_pods | tr '\n' ' ')"
checked_after_kill() {
  local t
  t=$(upstream_field everything lastCheckedAt) || return 1
  [ -n "$t" ] && [ "$t" != null ] && [[ "$t" > "$killed_at" ]]
}
poll 75 checked_after_kill || fail "everything.lastCheckedAt did not advance after the pod kill (health loop stopped?)"
note "everything lastCheckedAt=$(upstream_field everything lastCheckedAt) (> kill at $killed_at); status=$(upstream_field everything status)"
leaders=$(for p in $(k get pods -l "$SEL" -o name); do
  k logs "$p" 2>/dev/null | grep -q 'health lease acquired' && printf '%s ' "${p#pod/}"
done)
note "pods that acquired the health lease (current pods' logs): ${leaders:-none-yet}"

# ── 4. Burst over the per-key limit ──────────────────────────────────────────────────────────
burst=$(MCP_KEY_FILE=$KEY2 node "$LOAD" "$MCP_URL" burst 150 30) || fail "burst client failed: $burst"
note "burst: $burst"
n429=$(printf '%s' "$burst" | jq -r '.statuses["429"] // 0')
n200=$(printf '%s' "$burst" | jq -r '.statuses["200"] // 0')
[ "$n429" -gt 0 ] || fail "150 requests in a burst got no 429: $burst"
[ "$n200" -gt 0 ] || fail "burst got no 200 at all: $burst"
ra=$(printf '%s' "$burst" | jq -r '.retryAfter // empty')
[ -n "$ra" ] && [ "$ra" -ge 1 ] 2>/dev/null || fail "429 without a valid Retry-After: $burst"
[ "$(printf '%s' "$burst" | jq -r .statuses.code429)" = RATE_LIMITED ] || fail "429 body is not RATE_LIMITED: $burst"

code=$(api "$ADMIN_JAR" GET "/api/audit?userId=$ADMIN_ID&outcome=rate_limited&from=$start&limit=200")
[ "$code" = 200 ] || fail "audit query -> HTTP $code"
rows=$(jq '.items | length' "$LAST")
[ "$rows" -ge 1 ] || fail "no rate_limited audit rows for the admin since $start"
note "audit: $rows rate_limited rows, e.g. $(jq -c '.items[0] | {serverSlug, tool, outcome, errorCode, source}' "$LAST")"
pass
