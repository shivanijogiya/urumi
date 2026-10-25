#!/usr/bin/env bash
# Seeds what D1–D8 need, through the admin API only (never the DB), via the app Ingress:
#   - signs in as the seed admin (credentials from Secret urumi-env)
#   - ensures User A (usera@urumi.test) and User B (userb@urumi.test), both members. Passwords
#     exist only in the createUser response, so they are kept in .out/users.json when created and
#     reused. If a user exists but its password is not on file (or no longer works), a fresh user
#     with a run-unique email (usera-<run>@urumi.test) is created instead and recorded.
#   - registers + enables the 3 upstreams (seed-upstreams.sh) and waits until all are `up`
#     (E2E_SKIP_GITLAB=1: woo + everything only)
#   - grants User A woo__create_product (per-user tool permission; D2 creates a product as A)
#   - signs in as A and B (cookie jars in .out/)
#   - as B: revokes B's earlier e2e keys, creates key 1 (D3, revoked by D5) -> .out/userb.key and
#     key 2 (D6, D7) -> .out/userb2.key, both mode 600
# Idempotent. Prints nothing secret. Prints `PASS seed` or `FAIL seed: <reason>`.
#   tests/e2e/seed.sh      (normally via tests/e2e/run.sh)
set -euo pipefail
STEP=${STEP:-seed}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
export GW_URL=$APP_URL
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/gateway.sh"

need kubectl "Install it with: brew install kubectl"
need jq "Install it with: brew install jq"
need node "Install Node.js 22"
require_context

# shellcheck disable=SC1090
[ -f "$RUN_ENV" ] && . "$RUN_ENV"
RUN_ID=${RUN_ID:-$(date +%Y%m%d%H%M%S)}

gw_start
gw_login 2>/dev/null || fail "seed admin login failed"

[ -f "$USERS_JSON" ] || echo '{}' >"$USERS_JSON"

# login <role> <jar> : signs in with the stored password; the body is built by jq from the file.
login() {
  rm -f "$2"
  [ "$(jq -c --arg r "$1" '{email: .[$r].email, password: .[$r].password}' "$USERS_JSON" |
    api "$2" POST /api/auth/login)" = 200 ]
}

# create_user <role> <email> <name> : creates a member, stores email + temp password.
create_user() {
  local code tmp
  code=$(jq -n --arg e "$2" --arg n "$3" '{email: $e, name: $n, role: "member"}' |
    api "$ADMIN_JAR" POST /api/users)
  [ "$code" = 201 ] || fail "create user $2 -> HTTP $code: $(err_of)"
  tmp=$(mktemp "$E2E_OUT/users.XXXXXX")
  jq --arg r "$1" --slurpfile res "$LAST" \
    '.[$r] = {email: $res[0].user.email, password: $res[0].tempPassword}' "$USERS_JSON" >"$tmp"
  mv "$tmp" "$USERS_JSON"
  : >"$LAST"
  note "created user $2"
}

# ensure_user <role> <default email> <name> <jar> : ends with a signed-in session in <jar>.
ensure_user() {
  local role=$1 email=$2 name=$3 jar=$4 users stored exists
  [ "$(api "$ADMIN_JAR" GET /api/users)" = 200 ] || fail "list users failed: $(err_of)"
  users=$(cat "$LAST")
  stored=$(jq -r --arg r "$role" '.[$r].email // empty' "$USERS_JSON")
  if [ -n "$stored" ] &&
    [ -n "$(printf '%s' "$users" | jq -r --arg e "$stored" '.users[] | select(.email == $e and .disabledAt == null) | .id')" ] &&
    login "$role" "$jar"; then
    return
  fi
  exists=$(printf '%s' "$users" | jq -r --arg e "$email" '.users[] | select(.email == $e) | .id')
  if [ -n "$exists" ]; then
    # Exists but its password is not on file: no admin reset in the contracts, so use a new user.
    email="${email%@*}-$RUN_ID@${email#*@}"
    note "$2 exists without a stored password; using $email"
  fi
  create_user "$role" "$email" "$name"
  login "$role" "$jar" || fail "login as $email failed"
}

ensure_user A usera@urumi.test "User A" "$A_JAR"
ensure_user B userb@urumi.test "User B" "$B_JAR"

[ "$(api "$A_JAR" GET /api/auth/me)" = 200 ] || fail "GET /api/auth/me as A failed"
A_ID=$(jq -r .user.id "$LAST") A_EMAIL=$(jq -r .user.email "$LAST")
[ "$(jq -r .user.role "$LAST")" = member ] || fail "User A is not a member"
[ "$(api "$B_JAR" GET /api/auth/me)" = 200 ] || fail "GET /api/auth/me as B failed"
B_ID=$(jq -r .user.id "$LAST") B_EMAIL=$(jq -r .user.email "$LAST")
[ "$(jq -r .user.role "$LAST")" = member ] || fail "User B is not a member"

# Upstreams: seed-upstreams.sh (also through the Ingress) re-sends each one with enabled: true.
"$E2E_DIR/seed-upstreams.sh" >&2 || fail "seed-upstreams.sh failed"
gw_login 2>/dev/null || fail "seed admin login failed"
# E2E_SKIP_GITLAB=1 (no GitLab token, e.g. the CI canary job): only woo + everything. D3/D4 need gitlab.
SLUGS='["woo", "everything", "gitlab"]'
[ "${E2E_SKIP_GITLAB:-0}" = 1 ] && SLUGS='["woo", "everything"]'
all_up() {
  [ "$(api "$ADMIN_JAR" GET /api/upstreams)" = 200 ] &&
    [ "$(jq --argjson s "$SLUGS" '[.upstreams[] | select((.slug | IN($s[]))
      and .enabled and .status == "up")] | length' "$LAST")" = "$(printf '%s' "$SLUGS" | jq length)" ]
}
poll 45 all_up || fail "upstreams not all up+enabled: $(jq -c '[.upstreams[] | {slug, enabled, status, lastError}]' "$LAST")"

# Tool permissions (ADR 008): members are read-only by default, and D2 has User A (a member)
# create a product through chat, so A gets a per-user grant for woo__create_product (upsert, so
# idempotent). HTTP 404 = a gateway without tool permissions (an older canary baseline): skip.
code=$(jq -n --arg u "$A_ID" '{userId: $u, serverSlug: "woo", tool: "create_product", effect: "allow"}' |
  api "$ADMIN_JAR" POST /api/permissions)
case "$code" in
  200) note "User A: per-user allow woo__create_product" ;;
  404) note "gateway has no /api/permissions (no tool permissions): nothing to grant" ;;
  *) fail "grant User A woo__create_product -> HTTP $code: $(err_of)" ;;
esac

# B's keys: revoke leftovers from earlier runs, then create this run's two keys.
[ "$(api "$B_JAR" GET /api/keys)" = 200 ] || fail "list B's keys failed: $(err_of)"
for id in $(jq -r '.keys[] | select(.revokedAt == null and (.name | startswith("e2e "))) | .id' "$LAST"); do
  [ "$(api "$B_JAR" DELETE "/api/keys/$id")" = 204 ] || fail "revoke old key failed: $(err_of)"
done
# new_key <name> <file> : prints the key id; the secret goes only to <file>.
new_key() {
  local code
  code=$(jq -n --arg n "$1" '{name: $n}' | api "$B_JAR" POST /api/keys)
  [ "$code" = 201 ] || return 1
  rm -f "$2"
  jq -r .secret "$LAST" >"$2"
  chmod 600 "$2"
  jq -r .key.id "$LAST"
  : >"$LAST"
}
B_KEY_ID=$(new_key "e2e $RUN_ID d3" "$B_KEY") || fail "create B key 1 failed"
B_KEY2_ID=$(new_key "e2e $RUN_ID d6" "$B_KEY2") || fail "create B key 2 failed"

cat >"$SEED_ENV" <<EOF
A_ID=$A_ID
A_EMAIL=$A_EMAIL
B_ID=$B_ID
B_EMAIL=$B_EMAIL
B_KEY_ID=$B_KEY_ID
B_KEY2_ID=$B_KEY2_ID
EOF
pass
