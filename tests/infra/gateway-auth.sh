#!/usr/bin/env bash
# Gateway auth test (T1, T2), run against the installed release through a port-forward:
#   1. seed admin signs in (200, HttpOnly SameSite=Lax cookie); /api/auth/me is 200 and admin
#   2. wrong password 401; no cookie 401; cross-origin POST 403
#   3. admin creates member-b@example.com (201, or 409 when an earlier run created it); on 201 the
#      member signs in with the one-time password and gets 403 on an admin route
#   4. admin creates an API key for itself (201, secret shape checked), lists it (200, no secret in
#      the list), revokes it (204), sees revokedAt set, revokes again (204, idempotent)
#   5. logout 204, then the old cookie is 401
#   6. gateway logs contain neither the seed password, the temp password, nor the key secret
# Idempotent: member creation accepts 409; each run makes and revokes its own key.
# Never prints a secret: credentials come from the Secret into shell variables, reach curl on
# stdin (never argv), and are compared with grep -f on a file descriptor. Only status codes print.
# Prints PASS/FAIL per check; exits non-zero if any check fails.
#   RELEASE    Helm release name, default urumi
#   ENV_SECRET Secret with the credentials, default urumi-env
#   LOCAL_PORT port-forward port, default 18082
#   tests/infra/gateway-auth.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"

RELEASE=${RELEASE:-urumi}
ENV_SECRET=${ENV_SECRET:-urumi-env}
LOCAL_PORT=${LOCAL_PORT:-18082}
GW_SELECTOR="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=gateway"
BASE="http://127.0.0.1:${LOCAL_PORT}"
ORIGIN=${PUBLIC_ORIGIN:-http://app.localtest.me}
MEMBER_EMAIL=member-b@example.com

need kubectl "Install it with: brew install kubectl"
need curl "Install curl"
need jq "Install it with: brew install jq"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}
# check <name> <actual> <expected...>: PASS if actual equals one of the expected values.
check() {
  local name=$1 actual=$2
  shift 2
  local e
  for e in "$@"; do
    if [ "$actual" = "$e" ]; then
      pass "$name ($actual)"
      return 0
    fi
  done
  fail "$name" "got $actual, want $*"
}

secret_value() { kc -n "$NAMESPACE" get secret "$ENV_SECRET" -o "go-template={{index .data \"$1\" | base64decode}}"; }
contains_secret() { printf '%s\n' "$1" | grep -qF -f <(printf '%s\n' "$2"); }

TMP=$(mktemp -d)
PF_PID=""
cleanup() {
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# api <method> <path> <jar> [extra curl args...]: JSON request; pass the body as
# `--data-binary @<(cmd)` so its content never appears in argv. Not used in a pipeline (that would
# run it in a subshell). Sets CODE, BODY and HEADERS; BODY may hold a secret and is never printed.
api() {
  local method=$1 path=$2 jar=$3
  shift 3
  local out
  out=$(curl -sS --max-time 10 -X "$method" -D "$TMP/headers" -b "$jar" -c "$jar" \
    -H 'content-type: application/json' "$@" -w '\n%{http_code}' "$BASE$path")
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
  HEADERS=$(cat "$TMP/headers")
}
# Same, without a request body.
api_nobody() {
  local method=$1 path=$2 jar=$3
  shift 3
  local out
  out=$(curl -sS --max-time 10 -X "$method" -D "$TMP/headers" -b "$jar" -c "$jar" "$@" \
    -w '\n%{http_code}' "$BASE$path")
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
  HEADERS=$(cat "$TMP/headers")
}
login_body() { E=$1 P=$2 jq -nc '{email: env.E, password: env.P}'; }

# --- Port-forward ---------------------------------------------------------------------------------
say "Waiting for the gateway to be Ready"
kc -n "$NAMESPACE" rollout status "deployment/${RELEASE}-gateway" --timeout=300s >/dev/null
kc -n "$NAMESPACE" port-forward "svc/${RELEASE}-gateway" "${LOCAL_PORT}:80" >/dev/null 2>&1 &
PF_PID=$!
for _ in $(seq 1 30); do
  curl -s -o /dev/null --max-time 1 "$BASE/healthz" && break
  sleep 0.5
done
if ! curl -s -o /dev/null --max-time 2 "$BASE/healthz"; then
  fail "port-forward to svc/${RELEASE}-gateway" "no answer on :$LOCAL_PORT"
  exit 1
fi

SEED_EMAIL=$(secret_value SEED_ADMIN_EMAIL)
SEED_PASSWORD=$(secret_value SEED_ADMIN_PASSWORD)
ADMIN_JAR="$TMP/admin.jar"
MEMBER_JAR="$TMP/member.jar"
NO_JAR="$TMP/none.jar"
TEMP_PASSWORD=""
KEY_SECRET=""

# --- 1. Admin login -------------------------------------------------------------------------------
api POST /api/auth/login "$ADMIN_JAR" --data-binary @<(login_body "$SEED_EMAIL" "$SEED_PASSWORD")
check "admin login" "$CODE" 200
if [ "$CODE" != 200 ]; then
  echo "cannot continue without an admin session"
  exit 1
fi
cookie_line=$(printf '%s\n' "$HEADERS" | grep -i '^set-cookie: urumi_session=' || true)
case "$(printf '%s' "$cookie_line" | tr 'A-Z' 'a-z')" in
  *httponly*samesite=lax* | *samesite=lax*httponly*) pass "session cookie is HttpOnly, SameSite=Lax" ;;
  *) fail "session cookie is HttpOnly, SameSite=Lax" "attributes missing" ;;
esac
api_nobody GET /api/auth/me "$ADMIN_JAR"
check "GET /api/auth/me as admin" "$CODE" 200
role=$(printf '%s' "$BODY" | jq -r '.user.role')
check "me.role" "$role" admin

# --- 2. Rejections ----------------------------------------------------------------------------------
api POST /api/auth/login "$NO_JAR" --data-binary @<(login_body "$SEED_EMAIL" "wrong-password-$$")
check "wrong password" "$CODE" 401
api_nobody GET /api/users "$NO_JAR"
check "GET /api/users without a session" "$CODE" 401
api POST /api/keys "$ADMIN_JAR" -H "origin: http://evil.example" --data-binary '{"name":"cross-origin"}'
check "cross-origin POST /api/keys" "$CODE" 403

# --- 3. Member ----------------------------------------------------------------------------------------
api POST /api/users "$ADMIN_JAR" \
  --data-binary "{\"email\":\"$MEMBER_EMAIL\",\"name\":\"Member B\",\"role\":\"member\"}"
check "create $MEMBER_EMAIL (201 new, 409 from an earlier run)" "$CODE" 201 409
if [ "$CODE" = 201 ]; then
  TEMP_PASSWORD=$(printf '%s' "$BODY" | jq -r '.tempPassword')
  api POST /api/auth/login "$MEMBER_JAR" \
    --data-binary @<(login_body "$MEMBER_EMAIL" "$TEMP_PASSWORD")
  check "member login with the one-time password" "$CODE" 200
  api_nobody GET /api/users "$MEMBER_JAR"
  check "member GET /api/users" "$CODE" 403
else
  echo "SKIP member login: created by an earlier run; its one-time password is not retrievable"
fi
api_nobody GET /api/users "$ADMIN_JAR"
check "admin GET /api/users" "$CODE" 200
listed=$(printf '%s' "$BODY" | jq --arg e "$MEMBER_EMAIL" '[.users[] | select(.email == $e)] | length')
check "users list contains $MEMBER_EMAIL" "$listed" 1

# --- 4. API key -------------------------------------------------------------------------------------
api POST /api/keys "$ADMIN_JAR" --data-binary "{\"name\":\"infra-test-$(date +%s)\"}"
check "create API key" "$CODE" 201
KEY_SECRET=$(printf '%s' "$BODY" | jq -r '.secret')
KEY_ID=$(printf '%s' "$BODY" | jq -r '.key.id')
if [[ $KEY_SECRET =~ ^urk_[A-Za-z0-9_-]{43}$ ]]; then
  pass "key secret is urk_ + 43 base64url chars"
else
  fail "key secret shape" "unexpected format"
fi
api_nobody GET /api/keys "$ADMIN_JAR"
check "list keys" "$CODE" 200
present=$(printf '%s' "$BODY" | jq --arg id "$KEY_ID" '[.keys[] | select(.id == $id)] | length')
check "new key in the list" "$present" 1
if contains_secret "$BODY" "$KEY_SECRET" || contains_secret "$BODY" "${KEY_SECRET:8}"; then
  fail "key list has no secret" "secret found in the list"
else
  pass "key list has no secret"
fi
api_nobody DELETE "/api/keys/$KEY_ID" "$ADMIN_JAR"
check "revoke key" "$CODE" 204
api_nobody GET /api/keys "$ADMIN_JAR"
revoked=$(printf '%s' "$BODY" | jq -r --arg id "$KEY_ID" '.keys[] | select(.id == $id) | .revokedAt != null')
check "key shows revokedAt" "$revoked" true
api_nobody DELETE "/api/keys/$KEY_ID" "$ADMIN_JAR"
check "revoke again (idempotent)" "$CODE" 204

# --- 5. Logout ----------------------------------------------------------------------------------------
cp "$ADMIN_JAR" "$TMP/old.jar"
api_nobody POST /api/auth/logout "$ADMIN_JAR"
check "logout" "$CODE" 204
api_nobody GET /api/auth/me "$TMP/old.jar"
check "old session after logout" "$CODE" 401

# --- 6. No secrets in logs ------------------------------------------------------------------------
logs=""
for p in $(kc -n "$NAMESPACE" get pod -l "$GW_SELECTOR" -o jsonpath='{.items[*].metadata.name}'); do
  logs="$logs
$(kc -n "$NAMESPACE" logs "$p" --all-containers 2>/dev/null || true)"
done
leaked=""
contains_secret "$logs" "$SEED_PASSWORD" && leaked="$leaked SEED_ADMIN_PASSWORD"
[ -n "$TEMP_PASSWORD" ] && contains_secret "$logs" "$TEMP_PASSWORD" && leaked="$leaked tempPassword"
contains_secret "$logs" "${KEY_SECRET:8}" && leaked="$leaked api-key-secret"
if [ -z "$leaked" ]; then
  pass "gateway logs contain no password or key secret"
else
  fail "no secrets in gateway logs" "found:$leaked"
fi

exit "$failed"
