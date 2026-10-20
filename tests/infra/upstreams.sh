#!/usr/bin/env bash
# Three-upstream test (G6, D4, D7), run against the installed release after
# tests/e2e/seed-upstreams.sh:
#   1. woo, everything and gitlab are `up` in GET /api/upstreams with toolCount > 0
#   2. GET /api/tools has woo__list_orders, an everything__… tool and a gitlab__… tool
#   3. scale deploy/<release>-everything to 0: everything goes `down` within MAX_DOWN_S (25 s; the
#      health loop is 15 s + 3 s timeout), woo and gitlab stay `up` with their tools listed, and
#      everything's tools are gone. If the gateway serves POST /mcp (#15), woo and gitlab are also
#      called through it (read-only tools, temporary API key revoked on exit); otherwise SKIP.
#   4. scale back to 1: everything is `up` again with its tools
# Idempotent; the EXIT trap restores 1 replica. Never prints a secret. Nothing in GitLab is changed:
# the only GitLab tool it may call is get_mcp_server_version.
# Prints PASS/FAIL/SKIP per check; exits non-zero if any check fails.
#   RELEASE     Helm release name, default urumi
#   MAX_DOWN_S  default 25
#   tests/infra/upstreams.sh
set -euo pipefail
set +x
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$ROOT/tests/e2e/lib/gateway.sh"

MAX_DOWN_S=${MAX_DOWN_S:-25}
MAX_UP_S=${MAX_UP_S:-90}
EV_DEPLOY="$RELEASE-everything"
SLUGS="woo everything gitlab"

need kubectl "Install it with: brew install kubectl"
need curl "Install curl"
need node "Install Node.js 22"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}

KEY_ID=""
cleanup() {
  if [ -n "$KEY_ID" ]; then
    gw_api DELETE "/api/keys/$KEY_ID" >/dev/null 2>&1 || warn "could not revoke test API key $KEY_ID"
  fi
  kc -n "$NAMESPACE" scale "deploy/$EV_DEPLOY" --replicas=1 >/dev/null 2>&1 || true
  gw_stop
}
trap cleanup EXIT

# state: "slug:status:toolCount ..." for every registered upstream.
state() {
  gw_api GET /api/upstreams | json 'd.upstreams.map((u) => `${u.slug}:${u.status}:${u.toolCount}`).join(" ")'
}
# field_of <state> <slug> <status|tools>
field_of() {
  local entry
  entry=$(printf '%s\n' $1 | grep "^$2:" || true)
  case "$3" in
    status) printf '%s' "$entry" | cut -d: -f2 ;;
    tools) [ -n "$entry" ] && printf '%s' "$entry" | cut -d: -f3 || printf 0 ;;
  esac
}
# tools: space-separated qualified names from GET /api/tools.
tools() { gw_api GET /api/tools | json 'd.tools.map((t) => t.name).join(" ")'; }
# count_prefix <tools> <prefix>: number of tools starting with prefix.
count_prefix() { printf '%s\n' $1 | grep -c "^$2" || true; }

# wait_for <seconds> <predicate-fn>: polls once a second; sets WAITED to the seconds taken.
WAITED=0
wait_for() {
  local limit=$1 fn=$2 start now
  start=$(date +%s)
  while :; do
    now=$(date +%s)
    WAITED=$((now - start))
    "$fn" && return 0
    [ "$WAITED" -ge "$limit" ] && return 1
    sleep 1
  done
}

all_up() {
  local s slug
  s=$(state)
  for slug in $SLUGS; do
    [ "$(field_of "$s" "$slug" status)" = up ] || return 1
    [ "$(field_of "$s" "$slug" tools)" -gt 0 ] || return 1
  done
}
everything_down() { [ "$(field_of "$(state)" everything status)" = down ]; }
everything_up() {
  local s
  s=$(state)
  [ "$(field_of "$s" everything status)" = up ] && [ "$(field_of "$s" everything tools)" -gt 0 ]
}

# check_others_up <label>: woo + gitlab up with tools, listed in /api/tools.
check_others_up() {
  local s t slug
  s=$(state)
  t=$(tools)
  for slug in woo gitlab; do
    if [ "$(field_of "$s" "$slug" status)" = up ] && [ "$(field_of "$s" "$slug" tools)" -gt 0 ]; then
      pass "$1: $slug still up (toolCount $(field_of "$s" "$slug" tools))"
    else
      fail "$1: $slug still up" "got '$(printf '%s\n' $s | grep "^$slug:" || echo missing)'"
    fi
    [ "$(count_prefix "$t" "${slug}__")" -gt 0 ] && pass "$1: /api/tools still lists ${slug}__ tools" ||
      fail "$1: /api/tools still lists ${slug}__ tools" "none listed"
  done
}

# mcp_call <tool> <args-json>: tools/call through the gateway's POST /mcp with $API_KEY (from env,
# never in argv). Prints "ok", "error <code/message>" or "http <status>".
mcp_call() {
  TOOL=$1 ARGS=$2 GW_BASE=$GW_BASE node -e '
    const e = process.env;
    (async () => {
      try {
        const r = await fetch(e.GW_BASE + "/mcp", {
          method: "POST",
          signal: AbortSignal.timeout(20000),
          headers: {
            authorization: "Bearer " + e.API_KEY,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: e.TOOL, arguments: JSON.parse(e.ARGS) } }),
        });
        const text = await r.text();
        if (!r.ok) return console.log("http " + r.status);
        // JSON, or one SSE "data:" line.
        const body = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:")).slice(5));
        if (body.error) return console.log("error " + body.error.code);
        console.log(body.result && !body.result.isError ? "ok" : "error isError");
      } catch (err) {
        console.log("error " + (err.name || "exception"));
      }
    })();'
}

say "Signing in to the gateway as the seed admin"
gw_start
gw_login
kc -n "$NAMESPACE" scale "deploy/$EV_DEPLOY" --replicas=1 >/dev/null
kc -n "$NAMESPACE" rollout status "deploy/$EV_DEPLOY" --timeout=180s >/dev/null

# --- 1. All three up ----------------------------------------------------------------------------
say "Waiting for woo, everything and gitlab to be up with tools (<= ${MAX_UP_S}s)"
if wait_for "$MAX_UP_S" all_up; then
  pass "3 upstreams up with toolCount > 0: $(state)"
else
  fail "3 upstreams up with toolCount > 0" "after ${MAX_UP_S}s: $(state)"
  exit 1
fi

# --- 2. Tools from all three --------------------------------------------------------------------
t=$(tools)
printf '%s\n' $t | grep -qx woo__list_orders && pass "/api/tools has woo__list_orders" ||
  fail "/api/tools has woo__list_orders" "missing"
for slug in everything gitlab; do
  n=$(count_prefix "$t" "${slug}__")
  [ "$n" -gt 0 ] && pass "/api/tools has $n ${slug}__ tools" || fail "/api/tools has ${slug}__ tools" "none"
done

# --- 3. Kill everything -------------------------------------------------------------------------
say "Scaling deploy/$EV_DEPLOY to 0"
kc -n "$NAMESPACE" scale "deploy/$EV_DEPLOY" --replicas=0 >/dev/null
if wait_for "$MAX_DOWN_S" everything_down; then
  pass "everything down ${WAITED}s after scale-to-0 (limit ${MAX_DOWN_S}s)"
else
  fail "everything down within ${MAX_DOWN_S}s" "still: $(state)"
fi
check_others_up "everything killed"
n=$(count_prefix "$(tools)" "everything__")
[ "$n" -eq 0 ] && pass "everything killed: /api/tools has no everything__ tools" ||
  fail "everything killed: everything__ tools gone" "$n still listed"

# Calls through the gateway's callTool path need POST /mcp (#15). An unauthenticated request gets
# 401 once it exists, 404 before.
mcp_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$GW_BASE/mcp" \
  -H 'content-type: application/json' --data '{}' || echo 000)
if [ "$mcp_status" = 404 ]; then
  echo "SKIP everything killed: woo/gitlab tool calls (gateway has no POST /mcp yet, #15)"
else
  created=$(printf '{"name":"infra upstreams test"}' | gw_api POST /api/keys)
  KEY_ID=$(printf '%s' "$created" | json 'd.key.id')
  API_KEY=$(printf '%s' "$created" | json 'd.secret')
  export API_KEY
  unset created
  for call in 'woo__list_orders {}' 'gitlab__get_mcp_server_version {}'; do
    name=${call%% *}
    res=$(mcp_call "$name" "${call#* }")
    [ "$res" = ok ] && pass "everything killed: $name callable via POST /mcp" ||
      fail "everything killed: $name callable via POST /mcp" "$res"
  done
  unset API_KEY
fi

# --- 4. Bring it back ---------------------------------------------------------------------------
say "Scaling deploy/$EV_DEPLOY back to 1"
kc -n "$NAMESPACE" scale "deploy/$EV_DEPLOY" --replicas=1 >/dev/null
if wait_for "$MAX_UP_S" everything_up; then
  pass "everything up again ${WAITED}s after scale-to-1 (toolCount $(field_of "$(state)" everything tools))"
else
  fail "everything up again within ${MAX_UP_S}s" "$(state)"
fi
n=$(count_prefix "$(tools)" "everything__")
[ "$n" -gt 0 ] && pass "everything restored: /api/tools has $n everything__ tools" ||
  fail "everything restored: everything__ tools listed" "none"

exit "$failed"
