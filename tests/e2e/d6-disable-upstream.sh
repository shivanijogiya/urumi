#!/usr/bin/env bash
# D6: the admin disables the `everything` upstream (PATCH enabled=false): its tools disappear from
# MCP tools/list (User B, key 2) and from the chat tool set (GET /api/tools as User A: the same
# registry list the chat agent gets). Re-enabled, they come back (polled up to 35 s for the tool
# cache). The upstream is always re-enabled, also on failure.
set -uo pipefail
STEP=${STEP:-D6}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

upstream_id=$(upstream_field everything id)
[ -n "$upstream_id" ] || fail "upstream 'everything' not registered"

set_enabled() {
  printf '{"enabled": %s}' "$1" | api "$ADMIN_JAR" PATCH "/api/upstreams/$upstream_id"
}
restore() { set_enabled true >/dev/null; }
trap restore EXIT

# count_everything <mcp|api> : number of everything__ tools in that tool list.
count_everything() {
  if [ "$1" = mcp ]; then
    mcp "$B_KEY2" list | jq '[.tools[] | select(startswith("everything__"))] | length'
  else
    [ "$(api "$A_JAR" GET /api/tools)" = 200 ] || return 1
    jq '[.tools[] | select(.serverSlug == "everything")] | length' "$LAST"
  fi
}
has_everything() { [ "$(count_everything mcp)" -gt 0 ] 2>/dev/null && [ "$(count_everything api)" -gt 0 ] 2>/dev/null; }
no_everything() { [ "$(count_everything mcp)" = 0 ] && [ "$(count_everything api)" = 0 ]; }

has_everything || fail "everything__ tools missing before disabling (mcp=$(count_everything mcp), api=$(count_everything api))"

code=$(set_enabled false)
[ "$code" = 200 ] || fail "PATCH enabled=false -> HTTP $code: $(err_of)"
[ "$(jq -r .upstream.enabled "$LAST")" = false ] || fail "upstream still enabled after PATCH"
poll 35 no_everything ||
  fail "everything__ tools still listed after disabling (mcp=$(count_everything mcp), api=$(count_everything api))"
note "disabled: no everything__ tools in MCP tools/list or GET /api/tools"
# The rest is still there.
[ "$(mcp "$B_KEY2" list | jq '[.tools[] | select(startswith("woo__"))] | length')" -gt 0 ] ||
  fail "woo__ tools missing while everything is disabled"

code=$(set_enabled true)
[ "$code" = 200 ] || fail "PATCH enabled=true -> HTTP $code: $(err_of)"
poll 35 has_everything ||
  fail "everything__ tools not back within 35 s of re-enabling (mcp=$(count_everything mcp), api=$(count_everything api))"
note "re-enabled: everything__ tools back"
pass
