#!/usr/bin/env bash
# Creates or updates the generic Secret `urumi-env` in namespace `urumi` from the
# gitignored .env.local at the repo root. Called by cluster-up.sh; also runnable alone.
# Never prints a value — only key names.
#   ENV_FILE overrides the path; SECRET_NAME, NAMESPACE, KUBE_CONTEXT override targets.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/common.sh"

ENV_FILE=${ENV_FILE:-$ROOT/.env.local}
SECRET_NAME=${SECRET_NAME:-urumi-env}

if [ ! -f "$ENV_FILE" ]; then
  {
    echo "ERROR: $ENV_FILE not found."
    echo "Create it from the template, then re-run this script:"
    echo "  scripts/gen-env.sh                 # random values for every generated secret"
    echo "  # or: cp .env.example .env.local && chmod 600 .env.local, then edit it"
    if [ -f "$ROOT/.env.example" ]; then
      echo "Keys expected (from .env.example):"
      grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ROOT/.env.example" | cut -d= -f1 | sed 's/^/  /'
    fi
  } >&2
  exit 1
fi

# Validate the format before kubectl sees it: kubectl treats a bare `KEY` line as
# "copy from my own environment", which we never want. Report line numbers, not values.
bad=0
empty=""
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  case "$line" in '' | '#'*) continue ;; esac
  if ! printf '%s\n' "$line" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*='; then
    warn "$ENV_FILE line $n is not KEY=VALUE"
    bad=1
    continue
  fi
  [ -z "${line#*=}" ] && empty="$empty ${line%%=*}"
done <"$ENV_FILE"
[ "$bad" -eq 0 ] || die "fix the lines above in $ENV_FILE (comments must start with #)."

need kubectl "Install it with: brew install kubectl"
require_context

kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f - >/dev/null
kc -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kc apply -f -

[ -n "$empty" ] && warn "empty in $ENV_FILE (fill in later, then re-run):$empty"
exit 0
