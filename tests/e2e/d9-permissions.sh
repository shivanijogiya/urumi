#!/usr/bin/env bash
# D9 (tool permissions, ADR 008): User B is a member, so with the default policy
#   - MCP tools/list (B's key 2) shows the read tools (woo__list_orders) but hides the write tools
#     woo__create_product and woo__update_order_status;
#   - calling woo__create_product directly anyway returns an isError result with error code
#     FORBIDDEN, and the audit log has that call under B as outcome `denied`, error FORBIDDEN;
#   - the seed admin, with an API key of its own, sees woo__create_product and can call it (a draft
#     product, so the storefront is not cluttered); its audit row is `ok`. The key is revoked after.
# B's denied call is also added to expected-audit.jsonl, so D8 stays exact if run after D9.
set -uo pipefail
STEP=${STEP:-D9}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

ADMIN_KEY="$E2E_OUT/admin.key"
start=$(server_now) || fail "gateway not reachable at $APP_URL"

# ── Member (User B) ──────────────────────────────────────────────────────────────────────────
list=$(mcp "$B_KEY2" list) || fail "B tools/list failed: $(printf '%s' "$list" | jq -c .error)"
has() { printf '%s' "$1" | jq -e --arg t "$2" '.tools | index($t) != null' >/dev/null; }
has "$list" woo__list_orders || fail "B's tools/list lacks woo__list_orders"
for t in woo__create_product woo__update_order_status; do
  has "$list" "$t" && fail "B's tools/list shows $t (members must not see write tools)"
done
note "B sees $(printf '%s' "$list" | jq '.tools | length') tools; woo: $(printf '%s' "$list" | jq -c '[.tools[] | select(startswith("woo__"))]')"

result=$(mcp "$B_KEY2" call woo__create_product '{"name":"e2e-d9-should-not-exist","regular_price":"1"}')
expect B mcp woo create_product denied
printf '%s' "$result" | jq -e '.isError == true' >/dev/null ||
  fail "B's direct woo__create_product call was not rejected: $(printf '%s' "$result" | head -c 200)"
code=$(printf '%s' "$result" | jq -r '.content[0].text | fromjson | .error.code' 2>/dev/null)
[ "$code" = FORBIDDEN ] || fail "B's rejected call has error code '$code', expected FORBIDDEN"
note "B woo__create_product -> $(printf '%s' "$result" | jq -r '.content[0].text' | head -c 200)"

# audit_row <user-id> <tool> <outcome> : the newest matching row since $start (as admin), or fail.
audit_row() {
  local q="userId=$1&serverSlug=woo&tool=$2&outcome=$3&from=$start&limit=1"
  [ "$(api "$ADMIN_JAR" GET "/api/audit?$q")" = 200 ] || return 1
  jq -ce '.items[0] // empty' "$LAST"
}
row=$(audit_row "$B_ID" create_product denied) || fail "no audit row (denied) for B's woo__create_product call"
[ "$(printf '%s' "$row" | jq -r '[.source, .errorCode, .userEmail] | join(" ")')" = "mcp FORBIDDEN $B_EMAIL" ] ||
  fail "B's audit row is wrong: $row"
note "audit (B): $(printf '%s' "$row" | jq -c '{userEmail, source, serverSlug, tool, outcome, errorCode}')"

# ── Admin ────────────────────────────────────────────────────────────────────────────────────
[ "$(api "$ADMIN_JAR" GET /api/auth/me)" = 200 ] || fail "admin session expired; run: tests/e2e/run.sh seed"
ADMIN_ID=$(jq -r .user.id "$LAST")
[ "$(jq -r .user.role "$LAST")" = admin ] || fail "seed admin is not an admin"
code=$(jq -n --arg n "e2e $RUN_ID d9" '{name: $n}' | api "$ADMIN_JAR" POST /api/keys)
[ "$code" = 201 ] || fail "create admin key -> HTTP $code: $(err_of)"
rm -f "$ADMIN_KEY"
jq -r .secret "$LAST" >"$ADMIN_KEY"
chmod 600 "$ADMIN_KEY"
admin_key_id=$(jq -r .key.id "$LAST")
: >"$LAST"
revoke_admin_key() {
  api "$ADMIN_JAR" DELETE "/api/keys/$admin_key_id" >/dev/null
  rm -f "$ADMIN_KEY"
}
trap revoke_admin_key EXIT

alist=$(mcp "$ADMIN_KEY" list) || fail "admin tools/list failed: $(printf '%s' "$alist" | jq -c .error)"
has "$alist" woo__create_product || fail "admin's tools/list lacks woo__create_product"
name="e2e-d9-$RUN_ID"
aresult=$(mcp "$ADMIN_KEY" call woo__create_product \
  "$(jq -nc --arg n "$name" '{name: $n, regular_price: "1", status: "draft"}')")
printf '%s' "$aresult" | jq -e '.isError != true and (.content | length > 0)' >/dev/null ||
  fail "admin woo__create_product failed: $(printf '%s' "$aresult" | head -c 200)"
note "admin woo__create_product -> $(printf '%s' "$aresult" | jq -r '.content[0].text' | head -c 200)"
row=$(audit_row "$ADMIN_ID" create_product ok) || fail "no audit row (ok) for the admin's woo__create_product call"
note "audit (admin): $(printf '%s' "$row" | jq -c '{userEmail, source, serverSlug, tool, outcome}')"
pass
