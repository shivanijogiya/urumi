#!/usr/bin/env bash
# D13 (OAuth for MCP clients, ADR 013), through the Ingress against the 2 gateway replicas:
#   1. discovery: POST /mcp without credentials → 401 whose WWW-Authenticate names the protected
#      resource metadata; both metadata documents (RFC 9728, RFC 8414: S256 only) are served;
#   2. abuse checks: DCR refuses a non-loopback http redirect URI; /authorize refuses PKCE plain
#      and a foreign `resource` (error redirected with the state) and never redirects to an
#      unregistered redirect URI;
#   3. the official MCP SDK client, given only the URL, signs in as User B (member): DCR,
#      /authorize with PKCE S256 + state + resource, consent with B's dashboard session, code →
#      tokens, then initialize + tools/list = exactly B's PERMITTED tools (= GET /api/tools as B,
#      no woo__create_product) and tools/call woo__list_products;
#   4. the same access token calling woo__create_product is FORBIDDEN; the audit log has both
#      calls under B with authMethod oauth and the client's name;
#   5. refresh: rotation returns new tokens that work;
#   6. B disconnects the app with the dashboard API (DELETE /api/connected-apps/:id): the access
#      token gets 401 on the next /mcp request and the refresh token is invalid_grant.
# Tokens live only in files under .out (mode 600), never in argv or logs.
set -uo pipefail
STEP=${STEP:-D13}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

OAUTH_CLIENT="$E2E_DIR/lib/oauth-client.mjs"
STATE="$E2E_OUT/d13-oauth.json"
TOK="$E2E_OUT/d13.token"
HDR="$E2E_OUT/d13.hdr"
REDIRECT=http://127.0.0.1:43913/callback
CLIENT_NAME='Urumi e2e (MCP SDK client)'
grant_id=""
cleanup() {
  [ -n "$grant_id" ] && api "$B_JAR" DELETE "/api/connected-apps/$grant_id" >/dev/null
  rm -f "$STATE" "$TOK" "$HDR"
}
trap cleanup EXIT

[ "$(api "$B_JAR" GET /api/auth/me)" = 200 ] || fail "User B session expired; run: tests/e2e/run.sh seed"
start=$(server_now) || fail "gateway not reachable at $APP_URL"
note "gateway pods: $(kubectl get pods -n "${NAMESPACE:-urumi}" -l app.kubernetes.io/component=gateway --no-headers 2>/dev/null | awk '{print $1"("$2")"}' | tr '\n' ' ')"

# write_token <access token> : $TOK (for the SDK client) and $HDR (for curl -H @file).
write_token() {
  printf '%s' "$1" >"$TOK"
  printf 'Authorization: Bearer %s\n' "$1" >"$HDR"
  chmod 600 "$TOK" "$HDR"
}
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"d13","version":"1"}}}'
# mcp_status : HTTP status of an MCP initialize with the token in $HDR.
mcp_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$MCP_URL" -H @"$HDR" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data "$INIT" 2>/dev/null || echo 000
}
# token_req <jq filter over the state file> : POST /oauth/token (form body from jq on stdin).
token_req() {
  jq -j "$1" "$STATE" | curl -sS --max-time 20 -o "$LAST" -w '%{http_code}' -X POST \
    "$APP_URL/oauth/token" -H 'content-type: application/x-www-form-urlencoded' --data-binary @- \
    2>/dev/null || echo 000
}

# ── 1. Discovery ─────────────────────────────────────────────────────────────────────────────
www=$(curl -sS -o /dev/null -D - --max-time 10 -X POST "$MCP_URL" -H 'content-type: application/json' \
  --data '{}' | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p')
[ "$www" = "Bearer resource_metadata=\"$APP_URL/.well-known/oauth-protected-resource/mcp\"" ] ||
  fail "401 WWW-Authenticate is '$www'"
note "401 WWW-Authenticate: $www"
code=$(curl -sS -o "$LAST" -w '%{http_code}' --max-time 10 "$APP_URL/.well-known/oauth-protected-resource/mcp")
[ "$code" = 200 ] && [ "$(jq -r .resource "$LAST")" = "$MCP_URL" ] &&
  [ "$(jq -r '.authorization_servers[0]' "$LAST")" = "$APP_URL" ] || fail "protected resource metadata -> $code $(head -c 200 "$LAST")"
code=$(curl -sS -o "$LAST" -w '%{http_code}' --max-time 10 "$APP_URL/.well-known/oauth-authorization-server")
[ "$code" = 200 ] || fail "authorization server metadata -> HTTP $code"
jq -e --arg i "$APP_URL" '.issuer == $i and .code_challenge_methods_supported == ["S256"]
  and (.grant_types_supported | index("refresh_token")) and .registration_endpoint' "$LAST" >/dev/null ||
  fail "authorization server metadata: $(head -c 300 "$LAST")"
note "metadata: $(jq -c '{issuer, code_challenge_methods_supported, grant_types_supported, token_endpoint_auth_methods_supported}' "$LAST")"

# ── 2. Abuse checks ──────────────────────────────────────────────────────────────────────────
code=$(curl -sS -o "$LAST" -w '%{http_code}' --max-time 10 -X POST "$APP_URL/oauth/register" \
  -H 'content-type: application/json' --data '{"client_name":"evil","redirect_uris":["http://evil.example.com/cb"]}')
[ "$code" = 400 ] && [ "$(jq -r .error "$LAST")" = invalid_redirect_uri ] || fail "DCR accepted http://evil.example.com: $code"
code=$(jq -n --arg r "$REDIRECT" '{client_name: "d13 raw", redirect_uris: [$r], token_endpoint_auth_method: "none"}' |
  curl -sS -o "$LAST" -w '%{http_code}' --max-time 10 -X POST "$APP_URL/oauth/register" -H 'content-type: application/json' --data-binary @-)
[ "$code" = 201 ] || fail "DCR (loopback) -> HTTP $code: $(head -c 200 "$LAST")"
raw_id=$(jq -r .client_id "$LAST")
CH=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update("d13-verifier-".repeat(4)).digest("base64url"))')
authz() { # authz <extra query> : prints "status location"
  curl -sS -o /dev/null -D - --max-time 10 "$APP_URL/oauth/authorize?response_type=code&client_id=$raw_id&state=d13st&$1" |
    tr -d '\r' | awk 'NR==1{s=$2} tolower($1)=="location:"{l=$2} END{print s, l}'
}
enc() { jq -rn --arg v "$1" '$v|@uri'; }
r=$(authz "redirect_uri=$(enc "$REDIRECT")&code_challenge=$CH&code_challenge_method=plain")
case "$r" in "302 $REDIRECT?error=invalid_request"*"state=d13st"*) ;; *) fail "PKCE plain not refused: $r" ;; esac
r=$(authz "redirect_uri=$(enc "$REDIRECT")&code_challenge=$CH&code_challenge_method=S256&resource=$(enc https://evil.example.com/mcp)")
case "$r" in "302 $REDIRECT?error=invalid_target"*) ;; *) fail "foreign resource not refused: $r" ;; esac
r=$(authz "redirect_uri=$(enc https://evil.example.com/cb)&code_challenge=$CH&code_challenge_method=S256")
[ "$r" = "400 " ] || fail "unregistered redirect_uri: $r (must be 400, no Location)"
note "abuse: DCR http://evil → invalid_redirect_uri; PKCE plain → invalid_request; foreign resource → invalid_target; unregistered redirect → 400, no redirect"

# ── 3. The MCP SDK client signs in as User B ─────────────────────────────────────────────────
res=$(OAUTH_JAR="$B_JAR" OAUTH_STATE="$STATE" node "$OAUTH_CLIENT" "$MCP_URL" woo__list_products '{"per_page":1}')
rc=$?
note "SDK flow: $(printf '%s' "$res" | jq -c 'del(.tools, .result) + {toolCount: (.tools | length?)}')"
[ "$rc" = 0 ] || fail "SDK OAuth flow failed: $(printf '%s' "$res" | jq -c .error)"
printf '%s' "$res" | jq -e --arg r "$MCP_URL" --arg n "$CLIENT_NAME" --arg i "$APP_URL" '
  .authorize.code_challenge_method == "S256" and .authorize.resource == $r and .authorize.has_state
  and .consentPage == "/consent" and .consent.client == $n and .stateRoundTrip and .iss == $i
  and .tokenType == "Bearer" and .expiresIn == 3600' >/dev/null || fail "SDK flow details wrong: $res"
expect B mcp woo list_products ok
printf '%s' "$res" | jq -e '.result.isError != true and (.result.content | length > 0)' >/dev/null ||
  fail "woo__list_products via OAuth failed: $(printf '%s' "$res" | jq -c .result | head -c 200)"
[ "$(api "$B_JAR" GET /api/tools)" = 200 ] || fail "GET /api/tools as B"
want=$(jq -c '[.tools[].name] | sort' "$LAST")
got=$(printf '%s' "$res" | jq -c '.tools | sort')
[ "$got" = "$want" ] || fail "OAuth tools/list != B's permitted tools: got $got want $want"
printf '%s' "$res" | jq -e '.tools | index("woo__create_product") == null' >/dev/null || fail "member sees woo__create_product"
note "tools/list via OAuth = B's $(printf '%s' "$got" | jq length) permitted tools (no woo__create_product); woo__list_products ok"

# ── 4. Permissions + audit ───────────────────────────────────────────────────────────────────
write_token "$(jq -r .access_token "$STATE")"
rb=$(mcp "$TOK" call woo__create_product '{"name":"e2e-d13-should-not-exist","regular_price":"1"}')
expect B mcp woo create_product denied
[ "$(printf '%s' "$rb" | jq -r '.content[0].text | fromjson | .error.code' 2>/dev/null)" = FORBIDDEN ] ||
  fail "woo__create_product via OAuth was not FORBIDDEN: $(printf '%s' "$rb" | head -c 200)"
audit_oauth() { # audit_oauth <tool> <outcome>
  [ "$(api "$B_JAR" GET "/api/audit?serverSlug=woo&tool=$1&outcome=$2&from=$start&limit=1")" = 200 ] &&
    jq -e --arg u "$B_ID" --arg n "$CLIENT_NAME" '.items[0] | .userId == $u and .source == "mcp"
      and .authMethod == "oauth" and .oauthClientName == $n' "$LAST" >/dev/null
}
audit_oauth list_products ok || fail "no oauth-attributed audit row for list_products: $(head -c 300 "$LAST")"
audit_oauth create_product denied || fail "no oauth-attributed denied audit row: $(head -c 300 "$LAST")"
note "audit: $(jq -c '.items[0] | {userEmail, source, tool, outcome, authMethod, oauthClientName}' "$LAST") (+ list_products ok)"

# ── 5. Refresh rotation ──────────────────────────────────────────────────────────────────────
code=$(token_req '"grant_type=refresh_token&client_id=\(.client_id)&refresh_token=\(.refresh_token)"')
[ "$code" = 200 ] || fail "refresh -> HTTP $code: $(head -c 200 "$LAST")"
old_refresh_hash=$(jq -r .refresh_token "$STATE" | shasum -a 256 | cut -c1-12)
jq -s '.[0] + {access_token: .[1].access_token, refresh_token: .[1].refresh_token}' "$STATE" "$LAST" >"$STATE.new" &&
  mv "$STATE.new" "$STATE" && chmod 600 "$STATE"
: >"$LAST"
[ "$(jq -r .refresh_token "$STATE" | shasum -a 256 | cut -c1-12)" != "$old_refresh_hash" ] || fail "refresh token was not rotated"
write_token "$(jq -r .access_token "$STATE")"
[ "$(mcp_status)" = 200 ] || fail "refreshed access token rejected by /mcp"
note "refresh: new access + rotated refresh token; /mcp initialize 200"

# ── 6. Disconnect in the dashboard API → 401 ─────────────────────────────────────────────────
[ "$(api "$B_JAR" GET /api/connected-apps)" = 200 ] || fail "GET /api/connected-apps"
grant_id=$(jq -r --arg n "$CLIENT_NAME" '[.apps[] | select(.clientName == $n)][0].id // empty' "$LAST")
[ -n "$grant_id" ] || fail "connected apps does not list '$CLIENT_NAME'"
note "connected app: $(jq -c --arg n "$CLIENT_NAME" '[.apps[] | select(.clientName == $n)][0] | {clientName, userEmail, redirectHosts, lastUsedAt: (.lastUsedAt != null)}' "$LAST")"
code=$(api "$B_JAR" DELETE "/api/connected-apps/$grant_id")
[ "$code" = 204 ] || fail "revoke connected app -> HTTP $code"
grant_id=""
s=$(mcp_status)
[ "$s" = 401 ] || fail "/mcp with a revoked token -> HTTP $s (want 401)"
code=$(token_req '"grant_type=refresh_token&client_id=\(.client_id)&refresh_token=\(.refresh_token)"')
[ "$code" = 400 ] && [ "$(jq -r .error "$LAST")" = invalid_grant ] || fail "refresh after revoke -> $code $(head -c 200 "$LAST")"
note "revoked via DELETE /api/connected-apps/:id: /mcp 401, refresh invalid_grant"
pass
