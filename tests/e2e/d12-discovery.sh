#!/usr/bin/env bash
# D12 (many tools / discovery mode, ADR 012):
#   1. registers SYNTH_COPIES (5) extra upstreams `synth-1..5` that point at the in-cluster
#      everything server, so the admin may use 100+ tools (removed again on exit);
#   2. MCP with /mcp?mode=discovery (admin key): tools/list is exactly gateway__search_tools +
#      gateway__call_tool; searches rank the right tool first ("woocommerce orders by status" →
#      woo__list_orders, "sum of two numbers" → *__get-sum) out of 100+; gateway__call_tool runs
#      woo__list_orders and everything__get-sum, and the audit log has rows for the REAL tools;
#   3. User B (member, key 2): the search never returns woo__create_product and calling it through
#      gateway__call_tool is FORBIDDEN, audited `denied` under woo/create_product;
#   4. chat as the admin (100+ permitted tools > CHAT_DISCOVERY_THRESHOLD 40) runs in discovery
#      mode: toolMode=discovery, at least one search, a *__get-sum call via discovery, reply has 42.
set -uo pipefail
STEP=${STEP:-D12}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

COPIES=${SYNTH_COPIES:-5}
KEY="$E2E_OUT/d12.key"
DISC_URL="$MCP_URL?mode=discovery"
key_id=""
synth_ids=""
cleanup() {
  for id in $synth_ids; do api "$ADMIN_JAR" DELETE "/api/upstreams/$id" >/dev/null; done
  [ -n "$key_id" ] && api "$ADMIN_JAR" DELETE "/api/keys/$key_id" >/dev/null
  rm -f "$KEY"
}
trap cleanup EXIT
dmcp() { # dmcp <keyfile> list | call <tool> <json>  — discovery mode
  local keyfile=$1
  shift
  MCP_KEY_FILE=$keyfile node "$MCP_CLIENT" "$DISC_URL" "$@"
}
# search <keyfile> <query> : the gateway__search_tools result object (JSON).
search() {
  dmcp "$1" call gateway__search_tools "$(jq -nc --arg q "$2" '{query: $q, limit: 5}')" |
    jq -c '.content[0].text | fromjson'
}

[ "$(api "$ADMIN_JAR" GET /api/auth/me)" = 200 ] || fail "admin session expired; run: tests/e2e/run.sh seed"
ADMIN_ID=$(jq -r .user.id "$LAST")
start=$(server_now) || fail "gateway not reachable at $APP_URL"

# ── 1. 100+ tools ────────────────────────────────────────────────────────────────────────────
ev_url=$(upstream_field everything url)
[ -n "$ev_url" ] && [ "$ev_url" != null ] || fail "no everything upstream to copy"
for i in $(seq 1 "$COPIES"); do
  slug="synth-$i"
  old=$(api "$ADMIN_JAR" GET /api/upstreams >/dev/null && jq -r --arg s "$slug" '.upstreams[] | select(.slug == $s) | .id' "$LAST")
  [ -n "$old" ] && api "$ADMIN_JAR" DELETE "/api/upstreams/$old" >/dev/null
  code=$(jq -n --arg s "$slug" --arg u "$ev_url" '{slug: $s, name: ("Synthetic " + $s), url: $u}' |
    api "$ADMIN_JAR" POST /api/upstreams)
  [ "$code" = 201 ] || fail "register $slug -> HTTP $code: $(err_of)"
  synth_ids="$synth_ids $(jq -r .upstream.id "$LAST")"
done
count_tools() {
  [ "$(api "$ADMIN_JAR" GET /api/tools)" = 200 ] || return 1
  n=$(jq '.tools | length' "$LAST")
  [ "$n" -ge 100 ]
}
n=0
poll 60 count_tools || fail "admin sees only $n tools after registering $COPIES copies (need 100+)"
note "admin may use $n tools ($(jq -r '[.tools[].serverSlug] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$LAST"))"

code=$(jq -n --arg n "e2e $RUN_ID d12" '{name: $n}' | api "$ADMIN_JAR" POST /api/keys)
[ "$code" = 201 ] || fail "create admin key -> HTTP $code: $(err_of)"
jq -r .secret "$LAST" >"$KEY"
chmod 600 "$KEY"
key_id=$(jq -r .key.id "$LAST")
: >"$LAST"

# ── 2. Discovery over MCP ────────────────────────────────────────────────────────────────────
list=$(dmcp "$KEY" list) || fail "discovery tools/list failed: $list"
[ "$(printf '%s' "$list" | jq -c .tools)" = '["gateway__search_tools","gateway__call_tool"]' ] ||
  fail "discovery tools/list is not exactly the two meta-tools: $list"
direct=$(mcp "$KEY" list | jq '.tools | length')
note "tools/list: discovery=2 meta-tools, direct=$direct tools"

s1=$(search "$KEY" "woocommerce orders by status") || fail "search failed"
note "search 'woocommerce orders by status' (of $(printf '%s' "$s1" | jq .totalTools)): $(printf '%s' "$s1" | jq -c '[.results[].name]')"
[ "$(printf '%s' "$s1" | jq -r '.results[0].name')" = woo__list_orders ] || fail "top hit is not woo__list_orders: $s1"
[ "$(printf '%s' "$s1" | jq .totalTools)" -ge 100 ] || fail "search covered fewer than 100 tools: $s1"
s2=$(search "$KEY" "sum of two numbers") || fail "search failed"
note "search 'sum of two numbers': $(printf '%s' "$s2" | jq -c '[.results[].name]')"
printf '%s' "$s2" | jq -e '.results[0].name | test("__get-sum$")' >/dev/null || fail "top hit is not *__get-sum: $s2"

r=$(dmcp "$KEY" call gateway__call_tool '{"name":"woo__list_orders","arguments":{}}')
printf '%s' "$r" | jq -e '.isError != true and (.content | length > 0)' >/dev/null ||
  fail "gateway__call_tool woo__list_orders failed: $(printf '%s' "$r" | head -c 200)"
r=$(dmcp "$KEY" call gateway__call_tool '{"name":"everything__get-sum","arguments":{"a":17,"b":25}}')
[ "$(printf '%s' "$r" | jq -r '.content[0].text' | grep -c 42)" -gt 0 ] || fail "get-sum via discovery did not return 42: $(printf '%s' "$r" | head -c 200)"
note "gateway__call_tool everything__get-sum -> $(printf '%s' "$r" | jq -r '.content[0].text' | head -c 80)"
audit_has() { # audit_has <user> <server> <tool> <outcome>
  [ "$(api "$ADMIN_JAR" GET "/api/audit?userId=$1&serverSlug=$2&tool=$3&outcome=$4&from=$start&limit=1")" = 200 ] &&
    [ "$(jq '.items | length' "$LAST")" -ge 1 ]
}
audit_has "$ADMIN_ID" woo list_orders ok || fail "no audit row woo/list_orders ok for the discovery call"
audit_has "$ADMIN_ID" everything get-sum ok || fail "no audit row everything/get-sum ok for the discovery call"
note "audit: real tools recorded (woo/list_orders, everything/get-sum), source mcp"

# ── 3. Member: permissions still apply ───────────────────────────────────────────────────────
sb=$(search "$B_KEY2" "create a woocommerce product") || fail "member search failed"
note "member search 'create a woocommerce product' (of $(printf '%s' "$sb" | jq .totalTools)): $(printf '%s' "$sb" | jq -c '[.results[].name]')"
printf '%s' "$sb" | jq -e '[.results[].name] | index("woo__create_product") == null' >/dev/null ||
  fail "member search returned woo__create_product"
rb=$(dmcp "$B_KEY2" call gateway__call_tool '{"name":"woo__create_product","arguments":{"name":"e2e-d12-should-not-exist","regular_price":"1"}}')
expect B mcp woo create_product denied
[ "$(printf '%s' "$rb" | jq -r '.content[0].text | fromjson | .error.code' 2>/dev/null)" = FORBIDDEN ] ||
  fail "member gateway__call_tool woo__create_product was not FORBIDDEN: $(printf '%s' "$rb" | head -c 200)"
audit_has "$B_ID" woo create_product denied || fail "no denied audit row for B's discovery call"
note "member gateway__call_tool woo__create_product -> FORBIDDEN, audited denied"

# ── 4. Chat switches to discovery mode ───────────────────────────────────────────────────────
code=$(chat "$ADMIN_JAR" "Use your tools to compute the sum of 17 and 25 with the get-sum tool of the everything server, then reply with just the number.")
[ "$code" = 200 ] || fail "chat -> HTTP $code: $(err_of)"
note "chat: $(jq -c '{toolMode, discoverySearches, toolCalls: [.toolCalls[] | {name, outcome, via}], reply: (.reply | .[0:80])}' "$LAST")"
[ "$(jq -r .toolMode "$LAST")" = discovery ] || fail "chat did not run in discovery mode"
jq -e '(.discoverySearches | length) >= 1' "$LAST" >/dev/null || fail "chat made no tool search"
jq -e '[.toolCalls[] | select((.name | test("__get-sum$")) and .outcome == "ok" and .via == "discovery")] | length >= 1' "$LAST" >/dev/null ||
  fail "chat did not run a get-sum tool via discovery"
[ "$(jq -r .reply "$LAST" | grep -c 42)" -gt 0 ] || fail "chat reply lacks 42"
pass
