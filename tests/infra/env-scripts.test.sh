#!/usr/bin/env bash
# Offline tests for scripts/gen-env.sh and scripts/secrets-apply.sh (no cluster needed).
# Works in a temp dir; never prints a generated value.
#   tests/infra/env-scripts.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

failed=0
ok() { echo "ok   $1"; }
bad() {
  echo "FAIL $1"
  failed=1
}
check() { # check <name> <command...>
  local name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}

mode_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
value_of() { grep -E "^$1=" "$2" | head -1 | cut -d= -f2-; }
keys_of() { grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | cut -d= -f1; }
# not_in <text> <file>, without printing <text>. Called through check().
# shellcheck disable=SC2329
not_in() { ! grep -qF -- "$1" "$2"; }

GENERATED="WP_ADMIN_PASSWORD MARIADB_ROOT_PASSWORD MARIADB_PASSWORD POSTGRES_PASSWORD
GATEWAY_ENC_KEY GATEWAY_SESSION_SECRET WOO_MCP_SHARED_SECRET SEED_ADMIN_PASSWORD"
MANUAL="ANTHROPIC_API_KEY GITLAB_MCP_TOKEN"
KEPT="WP_ADMIN_USER WP_ADMIN_EMAIL SEED_ADMIN_EMAIL"
EXAMPLE="$ROOT/.env.example"

# --- .env.example documents every variable ---------------------------------------------
for k in $GENERATED $MANUAL $KEPT; do
  check ".env.example documents $k" grep -Eq "^$k=" "$EXAMPLE"
done

# --- gen-env.sh -----------------------------------------------------------------------
A="$TMPD/a.env"
B="$TMPD/b.env"
ENV_EXAMPLE="$EXAMPLE" ENV_FILE="$A" "$ROOT/scripts/gen-env.sh" >"$TMPD/gen.out"
ENV_EXAMPLE="$EXAMPLE" ENV_FILE="$B" "$ROOT/scripts/gen-env.sh" >/dev/null

check "gen-env writes mode 600" [ "$(mode_of "$A")" = "600" ]
check "gen-env keeps every key from .env.example" \
  [ "$(keys_of "$EXAMPLE" | tr '\n' ' ')" = "$(keys_of "$A" | tr '\n' ' ')" ]
for k in $GENERATED; do
  v=$(value_of "$k" "$A")
  check "gen-env fills $k" [ "${v:-change-me}" != "change-me" ]
  check "gen-env randomises $k" [ "$v" != "$(value_of "$k" "$B")" ]
  check "gen-env does not print $k" not_in "$v" "$TMPD/gen.out"
done
for k in $MANUAL; do
  check "gen-env leaves $k empty" [ -z "$(value_of "$k" "$A")" ]
done
for k in $KEPT; do
  check "gen-env keeps $k from example" [ "$(value_of "$k" "$A")" = "$(value_of "$k" "$EXAMPLE")" ]
done
enc_len=$(value_of GATEWAY_ENC_KEY "$A" | openssl base64 -d -A | wc -c | tr -d ' ')
check "GATEWAY_ENC_KEY decodes to 32 bytes" [ "$enc_len" = "32" ]

before=$(cksum <"$A")
if ENV_EXAMPLE="$EXAMPLE" ENV_FILE="$A" "$ROOT/scripts/gen-env.sh" >/dev/null 2>&1; then
  bad "gen-env refuses to overwrite (it exited 0)"
else
  check "gen-env refuses to overwrite" [ "$before" = "$(cksum <"$A")" ]
fi

# --- secrets-apply.sh (fails before touching any cluster) -----------------------------
# A context that cannot exist, so a bug here can never reach a real cluster.
export KUBE_CONTEXT=does-not-exist-urumi-test

if ENV_FILE="$TMPD/missing.env" "$ROOT/scripts/secrets-apply.sh" >/dev/null 2>"$TMPD/err"; then
  bad "secrets-apply exits non-zero when the env file is missing"
else
  ok "secrets-apply exits non-zero when the env file is missing"
fi
check "secrets-apply points to gen-env.sh" grep -q 'scripts/gen-env.sh' "$TMPD/err"
check "secrets-apply lists expected keys" grep -q 'GATEWAY_ENC_KEY' "$TMPD/err"

printf '# comment\n\nGOOD=1\nnot-a-key-line-sekrit\n' >"$TMPD/badfmt.env"
if ENV_FILE="$TMPD/badfmt.env" "$ROOT/scripts/secrets-apply.sh" >/dev/null 2>"$TMPD/err"; then
  bad "secrets-apply rejects a non KEY=VALUE line"
else
  ok "secrets-apply rejects a non KEY=VALUE line"
fi
check "secrets-apply reports the bad line number" grep -q 'line 4' "$TMPD/err"
check "secrets-apply does not echo the bad line" not_in sekrit "$TMPD/err"

if [ "$failed" -eq 0 ]; then echo "PASS env-scripts"; else echo "FAIL env-scripts"; fi
exit "$failed"
