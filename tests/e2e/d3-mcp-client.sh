#!/usr/bin/env bash
# D3 (User B, external MCP client with only the gateway URL + B's API key): tools/list shows tools
# of all three upstreams (woo__, everything__, gitlab__), and tools/call woo__list_orders
# {date: "today"} succeeds (not isError).
set -uo pipefail
STEP=${STEP:-D3}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

list=$(mcp "$B_KEY" list) || fail "MCP tools/list failed: $(printf '%s' "$list" | jq -c .error)"
note "tools/list: $(printf '%s' "$list" | jq -c '.tools | group_by(split("__")[0]) | map({(.[0] | split("__")[0]): length}) | add')"
for slug in woo everything gitlab; do
  printf '%s' "$list" | jq -e --arg p "${slug}__" '[.tools[] | select(startswith($p))] | length > 0' >/dev/null ||
    fail "tools/list has no ${slug}__ tools"
done
printf '%s' "$list" | jq -e '.tools | index("woo__list_orders")' >/dev/null || fail "tools/list has no woo__list_orders"

result=$(mcp "$B_KEY" call woo__list_orders '{"date":"today"}')
rc=$?
expect B mcp woo list_orders "$([ "$rc" = 0 ] && printf '%s' "$result" | jq -e '.isError != true' >/dev/null && echo ok || echo error)"
[ "$rc" = 0 ] || fail "MCP tools/call woo__list_orders failed: $(printf '%s' "$result" | jq -c .error)"
printf '%s' "$result" | jq -e '.isError != true' >/dev/null ||
  fail "woo__list_orders returned isError: $(printf '%s' "$result" | jq -r '.content[0].text' | head -c 200)"
note "woo__list_orders: $(printf '%s' "$result" | jq -r '.content[0].text' | head -c 200)"
pass
