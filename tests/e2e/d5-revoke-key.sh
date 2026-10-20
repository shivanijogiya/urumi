#!/usr/bin/env bash
# D5: the admin revokes User B's key 1 (the one D3 used) with DELETE /api/users/:id/keys/:keyId;
# B's next MCP request (tools/call woo__list_orders) gets HTTP 401, and the key is listed as
# revoked. The rejected request's time window goes to .out/d5-window for D8 (no audit row).
set -uo pipefail
STEP=${STEP:-D5}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

code=$(api "$ADMIN_JAR" DELETE "/api/users/$B_ID/keys/$B_KEY_ID")
[ "$code" = 204 ] || fail "admin DELETE /api/users/:id/keys/:keyId -> HTTP $code: $(err_of)"

code=$(api "$ADMIN_JAR" GET "/api/users/$B_ID/keys")
[ "$code" = 200 ] || fail "admin GET /api/users/:id/keys -> HTTP $code"
jq -e --arg k "$B_KEY_ID" '.keys[] | select(.id == $k) | .revokedAt != null' "$LAST" >/dev/null ||
  fail "key $B_KEY_ID is not listed as revoked"

# B's next MCP request, as a raw Streamable HTTP POST (the key goes in a curl config on stdin).
# The window uses the gateway's second-precision clock: wait 1 s so no earlier call falls inside.
sleep 1
before=$(server_now)
body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"woo__list_orders","arguments":{"date":"today"}}}'
status=$(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$B_KEY")" |
  curl -sS --max-time 20 -K - -o "$LAST" -w '%{http_code}' -X POST "$MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data-binary "$body" 2>/dev/null) || true
after=$(server_now)
printf '%s %s\n' "$before" "$after" >"$E2E_OUT/d5-window"
[ "$status" = 401 ] || fail "MCP request with the revoked key -> HTTP ${status:-000}, expected 401"

# The SDK client sees the same.
result=$(mcp "$B_KEY" list)
[ "$(printf '%s' "$result" | jq -r '.error.status // empty')" = 401 ] ||
  fail "SDK client with the revoked key did not get 401: $(printf '%s' "$result" | head -c 200)"
pass
