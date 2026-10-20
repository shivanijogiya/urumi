#!/usr/bin/env bash
# Persistence test for the store (K4), run against the installed release:
#   1. writes a marker row into MariaDB and a marker file under wp-content
#   2. deletes the MariaDB and WordPress pods and waits until the replacements are Ready
#   3. checks both markers survived
# Idempotent: each run writes a fresh marker value (the table/file are overwritten).
# Never prints a secret: the DB password is read inside the pod from its own env.
# Prints PASS/FAIL per check; exits non-zero if any check fails.
#   RELEASE    Helm release name, default urumi
#   tests/infra/persistence.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"

RELEASE=${RELEASE:-urumi}
DB_POD="${RELEASE}-mariadb-0"
WP_DEPLOY="${RELEASE}-wordpress"
WP_SELECTOR="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=wordpress"
DB_SELECTOR="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=mariadb"
MARKER_FILE=/var/www/html/wp-content/urumi-persistence-marker.txt
MARKER="persist-$(date +%s)-$$"

need kubectl "Install it with: brew install kubectl"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}

# sql <statement>: runs as the app user; the password stays inside the container.
sql() {
  kc -n "$NAMESPACE" exec "$DB_POD" -c mariadb -- \
    sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" exec mariadb -u"$MARIADB_USER" -D"$MARIADB_DATABASE" -N -B -e "$1"' \
    sh "$1"
}
wp() { kc -n "$NAMESPACE" exec "deploy/$WP_DEPLOY" -c wordpress -- "$@"; }

wait_ready() {
  kc -n "$NAMESPACE" rollout status "statefulset/${RELEASE}-mariadb" --timeout=300s
  kc -n "$NAMESPACE" rollout status "deployment/$WP_DEPLOY" --timeout=300s
  kc -n "$NAMESPACE" wait --for=condition=Ready pod -l "$DB_SELECTOR" --timeout=300s >/dev/null
  kc -n "$NAMESPACE" wait --for=condition=Ready pod -l "$WP_SELECTOR" --timeout=300s >/dev/null
}

say "Waiting for MariaDB and WordPress to be Ready"
wait_ready

say "Writing markers ($MARKER)"
sql "CREATE TABLE IF NOT EXISTS urumi_persistence_marker (id INT PRIMARY KEY, value VARCHAR(64) NOT NULL);
     REPLACE INTO urumi_persistence_marker (id, value) VALUES (1, '$MARKER');"
wp sh -c 'printf "%s\n" "$1" > "$2"' sh "$MARKER" "$MARKER_FILE"

old_db_uid=$(kc -n "$NAMESPACE" get pod "$DB_POD" -o jsonpath='{.metadata.uid}')
old_wp_uids=$(kc -n "$NAMESPACE" get pod -l "$WP_SELECTOR" -o jsonpath='{.items[*].metadata.uid}')

say "Deleting MariaDB and WordPress pods"
kc -n "$NAMESPACE" delete pod -l "$DB_SELECTOR" --wait=true --timeout=120s
kc -n "$NAMESPACE" delete pod -l "$WP_SELECTOR" --wait=true --timeout=120s
# The controllers may not have created the replacements yet; give them a moment.
sleep 3
wait_ready

new_db_uid=$(kc -n "$NAMESPACE" get pod "$DB_POD" -o jsonpath='{.metadata.uid}')
new_wp_uids=$(kc -n "$NAMESPACE" get pod -l "$WP_SELECTOR" -o jsonpath='{.items[*].metadata.uid}')
if [ "$new_db_uid" != "$old_db_uid" ] && [ "$new_wp_uids" != "$old_wp_uids" ]; then
  pass "pods replaced"
else
  fail "pods replaced" "pod UIDs unchanged after delete"
fi

got_db=$(sql "SELECT value FROM urumi_persistence_marker WHERE id = 1;" 2>/dev/null || true)
if [ "$got_db" = "$MARKER" ]; then
  pass "mariadb marker survived pod restart"
else
  fail "mariadb marker survived pod restart" "expected '$MARKER', got '$got_db'"
fi

got_wp=$(wp cat "$MARKER_FILE" 2>/dev/null || true)
if [ "$got_wp" = "$MARKER" ]; then
  pass "wp-content marker survived pod restart"
else
  fail "wp-content marker survived pod restart" "expected '$MARKER', got '$got_wp'"
fi

exit "$failed"
