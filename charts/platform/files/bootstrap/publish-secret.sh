#!/usr/bin/env bash
# Store bootstrap, step 2 of 2: the Job's `publish` container (kubectl, uid 33).
#   1. applies the Secret $SECRET_NAME (WOO_URL, WOO_USER, WOO_APP_PASSWORD), with the new
#      Application Password from the `wp` step if it made one, else the existing one
#   2. checks the stored password: GET $WOO_URL/wp-json/wc/v3/orders must return 200, else the
#      Job fails
# The password never appears in argv or output: kubectl reads it with --from-file, curl reads its
# credentials as a config on stdin.
set -euo pipefail
umask 077

for var in SECRET_NAME WOO_URL WOO_USER SECRET_LABELS; do
  [ -n "${!var:-}" ] || {
    echo "ERROR: $var is not set" >&2
    exit 1
  }
done

NEW_PASSWORD_FILE=/shared/WOO_APP_PASSWORD
EXISTING_PASSWORD_FILE=/existing/WOO_APP_PASSWORD

say() { printf '==> %s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [ -s "$NEW_PASSWORD_FILE" ]; then
  password_file=$NEW_PASSWORD_FILE
  say "Using the new Application Password"
elif [ -s "$EXISTING_PASSWORD_FILE" ]; then
  password_file=$EXISTING_PASSWORD_FILE
  say "Keeping the existing Application Password"
else
  die "no Application Password from the wp step and no existing Secret"
fi

# Server-side apply: no last-applied-configuration annotation (which would copy the data).
say "Applying Secret $SECRET_NAME"
IFS=, read -ra labels <<<"$SECRET_LABELS"
kubectl create secret generic "$SECRET_NAME" \
  --from-literal=WOO_URL="$WOO_URL" \
  --from-literal=WOO_USER="$WOO_USER" \
  --from-file=WOO_APP_PASSWORD="$password_file" \
  --dry-run=client -o yaml |
  kubectl label --local -f - "${labels[@]}" -o yaml |
  kubectl apply --server-side --field-manager=urumi-bootstrap --force-conflicts -f -

# Without `local`, WordPress accepts Application Passwords only over HTTPS; the official image's
# wp-config.php turns this header into $_SERVER['HTTPS'] = 'on'.
extra=()
[ "${WP_ENVIRONMENT_TYPE:-}" = local ] || extra=(-H 'X-Forwarded-Proto: https')

url="$WOO_URL/wp-json/wc/v3/orders?per_page=1"
say "Checking GET $url with the stored Application Password"
status=000
for _ in 1 2 3 4 5; do
  # `user` comes from a curl config on stdin, not the command line.
  status=$(printf 'user = "%s:%s"\n' "$WOO_USER" "$(cat "$password_file")" |
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -K - "${extra[@]}" "$url" || true)
  [ "$status" = 200 ] && break
  sleep 3
done
[ "$status" = 200 ] || die "GET /wp-json/wc/v3/orders returned HTTP $status (want 200)"
say "PASS: GET /wp-json/wc/v3/orders returned HTTP 200 for $WOO_USER"
