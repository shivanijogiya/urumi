#!/usr/bin/env bash
# Gateway database test (K3, K4), run against the installed release:
#   1. gateway and postgres are Ready; /readyz answers 200 inside the gateway pod
#   2. schema_migrations has 001 and the five contract tables exist
#   3. exactly one admin, with SEED_ADMIN_EMAIL, whose password hash starts with scrypt$
#   4. writes a marker row, deletes postgres-0 and the gateway pod, waits for the replacements:
#      the marker survived, migrations were not re-applied, and the admin is the same row with the
#      same hash (restart neither duplicates nor resets it)
#   5. gateway and postgres logs contain neither the seed admin password nor the Postgres password
# Idempotent: each run writes a fresh marker value into its own schema (infra_test), outside the
# gateway's tables. Never prints a secret: secret values stay in shell variables and are compared
# with grep -f on a file descriptor, never in argv.
# Prints PASS/FAIL per check; exits non-zero if any check fails.
#   RELEASE    Helm release name, default urumi
#   ENV_SECRET Secret with the credentials, default urumi-env
#   tests/infra/gateway-db.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"

RELEASE=${RELEASE:-urumi}
ENV_SECRET=${ENV_SECRET:-urumi-env}
PG_POD="${RELEASE}-postgres-0"
GW_DEPLOY="${RELEASE}-gateway"
GW_SELECTOR="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=gateway"
PG_SELECTOR="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=postgres"
MARKER="persist-$(date +%s)-$$"

need kubectl "Install it with: brew install kubectl"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}

secret_value() { kc -n "$NAMESPACE" get secret "$ENV_SECRET" -o "go-template={{index .data \"$1\" | base64decode}}"; }

# sql <statement> [psql -v args...]: local socket inside the pod (trust auth), so no password.
sql() {
  local stmt=$1
  shift
  printf '%s\n' "$stmt" |
    kc -n "$NAMESPACE" exec -i "$PG_POD" -c postgres -- \
      psql -X -q -t -A -v ON_ERROR_STOP=1 -U gateway -d gateway "$@"
}

wait_ready() {
  kc -n "$NAMESPACE" rollout status "statefulset/${RELEASE}-postgres" --timeout=300s >/dev/null
  kc -n "$NAMESPACE" rollout status "deployment/$GW_DEPLOY" --timeout=300s >/dev/null
  kc -n "$NAMESPACE" wait --for=condition=Ready pod -l "$PG_SELECTOR" --timeout=300s >/dev/null
  kc -n "$NAMESPACE" wait --for=condition=Ready pod -l "$GW_SELECTOR" --timeout=300s >/dev/null
}

admin_state() {
  sql "SELECT count(*) || ' ' || coalesce(min(id::text), '-') || ' ' || coalesce(min(password_hash), '-')
       FROM users WHERE role = 'admin'"
}

gateway_logs() {
  local p
  for p in $(kc -n "$NAMESPACE" get pod -l "$GW_SELECTOR" -o jsonpath='{.items[*].metadata.name}'); do
    kc -n "$NAMESPACE" logs "$p" --all-containers 2>/dev/null || true
  done
}

# --- 1. Ready -----------------------------------------------------------------------------------
say "Waiting for Postgres and the gateway to be Ready"
if wait_ready; then
  pass "gateway and postgres Ready"
else
  fail "gateway and postgres Ready" "not Ready within 300s"
  exit 1
fi
readyz=$(kc -n "$NAMESPACE" exec "deploy/$GW_DEPLOY" -c gateway -- \
  wget -q -O - http://127.0.0.1:8080/readyz 2>&1 || true)
case "$readyz" in
  *'"status":"ok"'*) pass "/readyz 200 inside the gateway pod" ;;
  *) fail "/readyz 200 inside the gateway pod" "got: $readyz" ;;
esac

# --- 2. Schema ----------------------------------------------------------------------------------
versions=$(sql "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")
case ",$versions," in
  *,001,*) pass "schema_migrations has 001 ($versions)" ;;
  *) fail "schema_migrations has 001" "got '$versions'" ;;
esac
tables=$(sql "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name IN ('users','sessions','api_keys','upstreams','audit_log')")
if [ "$tables" = "api_keys,audit_log,sessions,upstreams,users" ]; then
  pass "5 tables exist ($tables)"
else
  fail "5 tables exist" "got '$tables'"
fi

# --- 3. Seeded admin ----------------------------------------------------------------------------
SEED_EMAIL=$(secret_value SEED_ADMIN_EMAIL)
SEED_PASSWORD=$(secret_value SEED_ADMIN_PASSWORD)
PG_PASSWORD=$(secret_value POSTGRES_PASSWORD)

read -r admins admin_id admin_hash <<<"$(admin_state)"
with_email=$(sql "SELECT count(*) FROM users WHERE role = 'admin' AND email = lower(:'email')" \
  -v "email=$SEED_EMAIL")
if [ "$admins" = 1 ] && [ "$with_email" = 1 ]; then
  pass "exactly one admin, with SEED_ADMIN_EMAIL"
else
  fail "exactly one admin, with SEED_ADMIN_EMAIL" "admins=$admins with_email=$with_email"
fi
case "$admin_hash" in
  'scrypt$16384$8$1$'*) pass "admin password hash is scrypt\$16384\$8\$1\$..." ;;
  *) fail "admin password hash is scrypt" "unexpected format" ;;
esac

# --- 4. Persistence + restart -------------------------------------------------------------------
say "Writing marker ($MARKER)"
sql "CREATE SCHEMA IF NOT EXISTS infra_test;
     CREATE TABLE IF NOT EXISTS infra_test.marker (id int PRIMARY KEY, value text NOT NULL);
     INSERT INTO infra_test.marker VALUES (1, :'marker')
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;" -v "marker=$MARKER"
migrations_before=$(sql "SELECT count(*) || ' ' || max(applied_at)::text FROM schema_migrations")
# The pods about to be deleted take their logs with them; keep them for check 5.
logs_before=$(gateway_logs)
pg_logs_before=$(kc -n "$NAMESPACE" logs "$PG_POD" -c postgres 2>/dev/null || true)

say "Deleting $PG_POD and the gateway pod"
kc -n "$NAMESPACE" delete pod "$PG_POD" --wait=true --timeout=120s >/dev/null
kc -n "$NAMESPACE" delete pod -l "$GW_SELECTOR" --wait=true --timeout=120s >/dev/null
say "Waiting for the replacements"
if wait_ready; then
  pass "replacement pods Ready"
else
  fail "replacement pods Ready" "not Ready within 300s"
  exit 1
fi

got=$(sql "SELECT value FROM infra_test.marker WHERE id = 1")
if [ "$got" = "$MARKER" ]; then
  pass "marker row survived deleting $PG_POD (PVC)"
else
  fail "marker row survived deleting $PG_POD" "got '$got'"
fi
migrations_after=$(sql "SELECT count(*) || ' ' || max(applied_at)::text FROM schema_migrations")
if [ "$migrations_after" = "$migrations_before" ]; then
  pass "restart did not re-apply migrations"
else
  fail "restart did not re-apply migrations" "schema_migrations changed"
fi
read -r admins2 admin_id2 admin_hash2 <<<"$(admin_state)"
if [ "$admins2" = 1 ] && [ "$admin_id2" = "$admin_id" ] && [ "$admin_hash2" = "$admin_hash" ]; then
  pass "restart kept exactly one admin, same row and password hash"
else
  fail "restart kept the admin" "admins=$admins2 same_id=$([ "$admin_id2" = "$admin_id" ] && echo y || echo n) same_hash=$([ "$admin_hash2" = "$admin_hash" ] && echo y || echo n)"
fi

# --- 5. No secrets in logs ----------------------------------------------------------------------
# contains_secret <text> <secret>: the secret reaches grep as a pattern file, not an argument.
contains_secret() { printf '%s\n' "$1" | grep -qF -f <(printf '%s\n' "$2"); }
all_logs="$logs_before
$(gateway_logs)
$pg_logs_before
$(kc -n "$NAMESPACE" logs "$PG_POD" -c postgres 2>/dev/null || true)"
if [ -z "$(gateway_logs)" ]; then
  fail "gateway logs readable" "no log lines"
fi
leaked=""
contains_secret "$all_logs" "$SEED_PASSWORD" && leaked="$leaked SEED_ADMIN_PASSWORD"
contains_secret "$all_logs" "$PG_PASSWORD" && leaked="$leaked POSTGRES_PASSWORD"
if [ -z "$leaked" ]; then
  pass "gateway and postgres logs contain neither the seed password nor the Postgres password"
else
  fail "no secrets in logs" "found:$leaked"
fi

exit "$failed"
