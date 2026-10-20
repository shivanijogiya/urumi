#!/usr/bin/env bash
# D7: the in-cluster `everything` upstream is killed (Deployment scaled to 0). Within 25 s
# GET /api/upstreams shows it `down`; woo__list_orders through MCP (User B, key 2) still works.
# Then it is scaled back to 1 and must be `up` again within 60 s. The scale-up always runs (trap).
set -uo pipefail
STEP=${STEP:-D7}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

DEPLOY="deploy/$RELEASE-everything"
restore() { kc -n "$NAMESPACE" scale "$DEPLOY" --replicas=1 >/dev/null 2>&1; }
trap restore EXIT

[ "$(upstream_field everything status)" = up ] ||
  fail "everything is not up before the test (status $(upstream_field everything status))"

kc -n "$NAMESPACE" scale "$DEPLOY" --replicas=0 >&2 || fail "kubectl scale --replicas=0 failed"
is_down() { [ "$(upstream_field everything status)" = down ]; }
poll 25 is_down || fail "everything not 'down' within 25 s (status $(upstream_field everything status))"
note "everything down: $(upstream_field everything lastError)"

result=$(mcp "$B_KEY2" call woo__list_orders '{"date":"today"}')
rc=$?
if [ "$rc" = 0 ] && printf '%s' "$result" | jq -e '.isError != true' >/dev/null; then
  expect B mcp woo list_orders ok
else
  [ "$rc" = 0 ] && expect B mcp woo list_orders error
  fail "woo__list_orders failed while everything is down: $(printf '%s' "$result" | head -c 200)"
fi
list=$(mcp "$B_KEY2" list)
[ "$(printf '%s' "$list" | jq '[.tools[] | select(startswith("everything__"))] | length')" = 0 ] ||
  fail "everything__ tools still listed while it is down"

kc -n "$NAMESPACE" scale "$DEPLOY" --replicas=1 >&2 || fail "kubectl scale --replicas=1 failed"
is_up() { [ "$(upstream_field everything status)" = up ]; }
poll 60 is_up || fail "everything not 'up' within 60 s of restoring (status $(upstream_field everything status))"
note "everything up again"
pass
