#!/usr/bin/env bash
# Creates .env.local from .env.example, filling every generated secret with a random
# value from openssl. Leaves ANTHROPIC_API_KEY and GITLAB_MCP_TOKEN empty for a human to
# fill in, and keeps non-secret values (user names, emails) from the example.
# Refuses to overwrite an existing file. Never prints a value.
#   ENV_FILE / ENV_EXAMPLE override the paths (used by tests).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/common.sh"

ENV_EXAMPLE=${ENV_EXAMPLE:-$ROOT/.env.example}
ENV_FILE=${ENV_FILE:-$ROOT/.env.local}

need openssl "Install it with: brew install openssl (macOS) or apt install openssl."
[ -f "$ENV_EXAMPLE" ] || die "$ENV_EXAMPLE not found."
[ -e "$ENV_FILE" ] && die "$ENV_FILE already exists; refusing to overwrite. Delete it first if you really want new values."

# value_for <KEY> <example value> -> prints the value to write.
value_for() {
  case "$1" in
    ANTHROPIC_API_KEY | GITLAB_MCP_TOKEN) printf '' ;;
    GATEWAY_ENC_KEY) openssl rand -base64 32 ;;
    *_PASSWORD) openssl rand -hex 24 ;;
    *_SECRET) openssl rand -hex 32 ;;
    *) printf '%s' "$2" ;;
  esac
}

umask 077
TMP=$(mktemp "$ENV_FILE.XXXXXX")
trap 'rm -f "$TMP"' EXIT

generated=""
manual=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'*)
      printf '%s\n' "$line" >>"$TMP"
      continue
      ;;
  esac
  key=${line%%=*}
  value=$(value_for "$key" "${line#*=}")
  printf '%s=%s\n' "$key" "$value" >>"$TMP"
  case "$key" in
    ANTHROPIC_API_KEY | GITLAB_MCP_TOKEN) manual="$manual $key" ;;
    GATEWAY_ENC_KEY | *_PASSWORD | *_SECRET) generated="$generated $key" ;;
  esac
done <"$ENV_EXAMPLE"

chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

say "Wrote $ENV_FILE (mode 600)"
echo "generated:${generated}"
echo "fill in by hand:${manual}"
