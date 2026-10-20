# shellcheck shell=bash disable=SC2034
# Shared helpers for tests/e2e/seed.sh and the D1–D8 step scripts. Source it after
# scripts/lib/common.sh; do not run it. Works with macOS's bash 3.2.
# (SC2034: the variables here are used by the scripts that source this file.)
#
# Every request goes through the Ingress: $APP_URL (gateway: /api, /mcp) and $STORE_URL (store).
# kubectl is used only to read Secrets and, in D7, to scale the everything Deployment.
#
# State under tests/e2e/.out/ (gitignored, files created mode 600):
#   run.env              RUN_ID, RUN_START (gateway clock, ISO-8601) of the current run (run.sh)
#   seed.env             user ids/emails and key ids written by seed.sh (no secrets)
#   users.json           User A/B emails + passwords, written once when seed.sh creates them
#   userb.key userb2.key B's API keys (D3/D5 and D6/D7), recreated by every seed
#   *.jar                session cookie jars (admin, A, B)
#   expected-audit.jsonl one line per tool call a step made, checked by D8
# Secrets never reach argv, stdout or logs: bodies with passwords are built by jq from files and
# go to curl on stdin; keys reach the MCP client through a file path.

APP_URL=${APP_URL:-http://app.localtest.me}
STORE_URL=${STORE_URL:-http://store.localtest.me}
RELEASE=${RELEASE:-urumi}
ENV_SECRET=${ENV_SECRET:-urumi-env}
WOO_SECRET=${WOO_SECRET:-$RELEASE-woo-api}

E2E_DIR="$ROOT/tests/e2e"
E2E_OUT="$E2E_DIR/.out"
RUN_ENV="$E2E_OUT/run.env"
SEED_ENV="$E2E_OUT/seed.env"
USERS_JSON="$E2E_OUT/users.json"
EXPECT="$E2E_OUT/expected-audit.jsonl"
ADMIN_JAR="$E2E_OUT/gateway-cookies.txt" # the same jar tests/e2e/lib/gateway.sh uses
A_JAR="$E2E_OUT/usera.jar"
B_JAR="$E2E_OUT/userb.jar"
B_KEY="$E2E_OUT/userb.key"
B_KEY2="$E2E_OUT/userb2.key"
LAST="$E2E_OUT/last.json"
MCP_CLIENT="$E2E_DIR/lib/mcp-client.mjs"
MCP_URL="$APP_URL/mcp"

umask 077
mkdir -p "$E2E_OUT"
set +x

STEP=${STEP:-step}

# Result line on stdout (the only stdout a step prints); diagnostics go to stderr.
pass() {
  echo "PASS $STEP"
  exit 0
}
fail() {
  echo "FAIL $STEP: $*"
  exit 1
}
note() { printf '  %s\n' "$*" >&2; }

load_state() {
  # shellcheck disable=SC1090
  [ -f "$RUN_ENV" ] && . "$RUN_ENV"
  # shellcheck disable=SC1090
  [ -f "$SEED_ENV" ] && . "$SEED_ENV"
  [ -n "${RUN_ID:-}" ] || fail "no run state ($RUN_ENV); start with: tests/e2e/run.sh all"
  [ -n "${B_ID:-}" ] || fail "no seed state ($SEED_ENV); run: tests/e2e/run.sh seed"
}

# api <jar> <METHOD> <path> : request to the gateway through the Ingress with that session. A body,
# if any, comes on stdin (JSON). Sends the dashboard's Origin like a browser would (CSRF check).
# The response body goes to $LAST; prints the HTTP status (000 = no answer).
API_TIMEOUT=${API_TIMEOUT:-30}
api() {
  local jar=$1 method=$2 path=$3 code
  if [ "$method" = GET ] || [ "$method" = DELETE ]; then
    code=$(curl -sS --max-time "$API_TIMEOUT" -b "$jar" -c "$jar" -H "Origin: $APP_URL" \
      -o "$LAST" -w '%{http_code}' -X "$method" "$APP_URL$path" 2>/dev/null) || true
  else
    code=$(curl -sS --max-time "$API_TIMEOUT" -b "$jar" -c "$jar" -H "Origin: $APP_URL" \
      -H 'content-type: application/json' --data-binary @- \
      -o "$LAST" -w '%{http_code}' -X "$method" "$APP_URL$path" 2>/dev/null) || true
  fi
  echo "${code:-000}"
}

# err_of: the error message of the last response, for FAIL reasons (never contains secrets).
err_of() { jq -r '(.error.message // .message // .) | tostring' "$LAST" 2>/dev/null | head -c 200; }

# chat <jar> <prompt> : POST /api/chat with a one-message history; prints the HTTP status.
chat() {
  jq -n --arg p "$2" '{messages: [{role: "user", content: $p}]}' | API_TIMEOUT=240 api "$1" POST /api/chat
}

# mcp <keyfile> list | call <tool> <json> : the official SDK client against $MCP_URL.
mcp() {
  local keyfile=$1
  shift
  MCP_KEY_FILE=$keyfile node "$MCP_CLIENT" "$MCP_URL" "$@"
}

# expect <A|B> <source> <server> <tool> <outcome> : a tool call D8 must find in the audit log.
expect() {
  jq -nc --arg u "$1" --arg s "$2" --arg srv "$3" --arg t "$4" --arg o "$5" \
    '{user: $u, source: $s, serverSlug: $srv, tool: $t, outcome: $o}' >>"$EXPECT"
}

# expect_chat_calls <A|B> : every toolCalls entry of the chat response in $LAST.
expect_chat_calls() {
  jq -c --arg u "$1" '.toolCalls[] | {user: $u, source: "chat", serverSlug,
    tool: (.name | sub("^[a-z0-9-]+__"; "")), outcome}' "$LAST" >>"$EXPECT"
}

# server_now : the gateway's clock (HTTP Date header), ISO-8601 UTC, second precision.
server_now() {
  local date
  date=$(curl -sS -o /dev/null -D - --max-time 10 "$APP_URL/api/auth/me" | tr -d '\r' |
    sed -n 's/^[Dd]ate: //p' | head -1)
  [ -n "$date" ] || return 1
  node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' "$date"
}

# poll <seconds> <command...> : runs the command every 2 s until it succeeds or time runs out.
poll() {
  local deadline=$(($(date +%s) + $1))
  shift
  while :; do
    "$@" && return 0
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 2
  done
}

# upstream_field <slug> <field> : one field of an upstream from GET /api/upstreams (as admin).
upstream_field() {
  [ "$(api "$ADMIN_JAR" GET /api/upstreams)" = 200 ] || return 1
  jq -r --arg s "$1" --arg f "$2" '.upstreams[] | select(.slug == $s) | .[$f] | tostring' "$LAST"
}

# ── Store ─────────────────────────────────────────────────────────────────────────────────────
STORE_API="$STORE_URL/wp-json/wc/store/v1"
STORE_ADDRESS='{"first_name":"E2E","last_name":"Buyer","address_1":"1 Janpath","city":"New Delhi","state":"DL","postcode":"110001","country":"IN","email":"e2e-buyer@example.com","phone":"9999999999"}'

# store_order <product_id> : Store API cart + COD checkout as a shopper; prints the order id.
store_order() {
  local product_id=$1 headers nonce token body order_id
  headers=$(curl -sS --max-time 20 -o /dev/null -D - "$STORE_API/cart") || return 1
  nonce=$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/^[Nn]once: //p' | head -1)
  token=$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/^[Cc]art-[Tt]oken: //p' | head -1)
  if [ -z "$nonce" ] || [ -z "$token" ]; then
    note "GET /cart returned no Nonce/Cart-Token header"
    return 1
  fi
  body=$(curl -sS --max-time 20 -X POST "$STORE_API/cart/add-item" -H "Nonce: $nonce" \
    -H "Cart-Token: $token" -H 'Content-Type: application/json' \
    -d "{\"id\": $product_id, \"quantity\": 1}") || return 1
  if [ "$(printf '%s' "$body" | jq -r '.items_count // 0')" -lt 1 ]; then
    note "add-item failed: $(printf '%s' "$body" | jq -c '{code, message}' 2>/dev/null)"
    return 1
  fi
  body=$(curl -sS --max-time 30 -X POST "$STORE_API/checkout" -H "Nonce: $nonce" \
    -H "Cart-Token: $token" -H 'Content-Type: application/json' \
    -d "{\"billing_address\": $STORE_ADDRESS, \"shipping_address\": $STORE_ADDRESS, \"payment_method\": \"cod\"}") ||
    return 1
  order_id=$(printf '%s' "$body" | jq -r '.order_id // empty')
  if [ -z "$order_id" ]; then
    note "checkout failed: $(printf '%s' "$body" | jq -c '{code, message}' 2>/dev/null)"
    return 1
  fi
  echo "$order_id"
}

# woo_rest <METHOD> <path> : WooCommerce admin REST API through the store Ingress, authenticated
# with the Application Password from the bootstrap Secret (credentials go in a curl config on
# stdin, never argv). Response body -> $LAST; prints the HTTP status.
woo_rest() {
  local method=$1 path=$2 code
  (
    WOO_USER=$(kc -n "$NAMESPACE" get secret "$WOO_SECRET" -o 'go-template={{.data.WOO_USER | base64decode}}')
    WOO_PASS=$(kc -n "$NAMESPACE" get secret "$WOO_SECRET" -o 'go-template={{.data.WOO_APP_PASSWORD | base64decode}}')
    printf 'user = "%s:%s"\n' "$WOO_USER" "$WOO_PASS"
  ) | {
    code=$(curl -sS --max-time 20 -K - -o "$LAST" -w '%{http_code}' -X "$method" \
      "$STORE_URL/wp-json/wc/v3$path" 2>/dev/null) || true
    echo "${code:-000}"
  }
}
