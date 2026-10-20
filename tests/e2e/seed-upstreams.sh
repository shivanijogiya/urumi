#!/usr/bin/env bash
# Registers the three upstreams (G6) with the gateway through its admin API, as the seed admin:
#   woo         in-cluster woo-mcp            header x-woo-mcp-secret = WOO_MCP_SHARED_SECRET
#   everything  in-cluster server-everything  no credential
#   gitlab      https://gitlab.com/api/v4/mcp bearer = GITLAB_MCP_TOKEN (fine-grained PAT)
# Idempotent: an existing slug is PATCHed (name, url, enabled, credential re-sent, so a rotated
# Secret is picked up); a missing one is POSTed. Never prints a secret: credential values go from
# the Secret into a subshell's environment, node builds the JSON body from it, and curl reads the
# body on stdin. The gateway stores each credential encrypted and never returns it.
#   RELEASE     Helm release name, default urumi
#   ENV_SECRET  Secret with the credentials, default urumi-env
#   GITLAB_MCP_URL  default https://gitlab.com/api/v4/mcp
#   tests/e2e/seed-upstreams.sh
set -euo pipefail
set +x
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/gateway.sh"

GITLAB_MCP_URL=${GITLAB_MCP_URL:-https://gitlab.com/api/v4/mcp}
SVC_DOMAIN="$NAMESPACE.svc.cluster.local"

need kubectl "Install it with: brew install kubectl"
need curl "Install curl"
need node "Install Node.js 22"
require_context
trap gw_stop EXIT

say "Signing in to the gateway as the seed admin"
gw_start
gw_login

existing=$(gw_api GET /api/upstreams)

# upsert <slug> <name> <url> <credential-kind> [secret-key] [header-name]
#   credential-kind: none | bearer | header
upsert() {
  local slug=$1 name=$2 url=$3 kind=$4 key=${5:-} header=${6:-} id method path
  id=$(printf '%s' "$existing" | json "(d.upstreams.find((u) => u.slug === '$slug') || {}).id || ''")
  if [ -n "$id" ]; then
    method=PATCH path="/api/upstreams/$id"
  else
    method=POST path=/api/upstreams
  fi
  (
    if [ "$kind" != none ]; then
      CRED_VALUE=$(secret_value "$key")
      [ -n "$CRED_VALUE" ] || die "$key is empty in Secret $ENV_SECRET"
      export CRED_VALUE
    fi
    SLUG=$slug NAME=$name URL=$url KIND=$kind HEADER=$header METHOD=$method node -e '
      const e = process.env;
      const body = { name: e.NAME, url: e.URL, enabled: true };
      if (e.METHOD === "POST") body.slug = e.SLUG;
      if (e.KIND === "bearer") body.credential = { type: "bearer", value: e.CRED_VALUE };
      if (e.KIND === "header")
        body.credential = { type: "header", headerName: e.HEADER, value: e.CRED_VALUE };
      // PATCH with credential null removes a stale one (credential-less upstream).
      if (e.KIND === "none" && e.METHOD === "PATCH") body.credential = null;
      process.stdout.write(JSON.stringify(body));'
  ) | gw_api "$method" "$path" >/dev/null || die "$method upstream '$slug' failed"
  if [ "$method" = POST ]; then
    say "Created upstream '$slug' ($url)"
  else
    say "Updated upstream '$slug' ($url)"
  fi
}

upsert woo "WooCommerce store" "http://$RELEASE-woo-mcp.$SVC_DOMAIN/mcp" \
  header WOO_MCP_SHARED_SECRET x-woo-mcp-secret
upsert everything "MCP everything (reference)" "http://$RELEASE-everything.$SVC_DOMAIN/mcp" none
upsert gitlab "GitLab" "$GITLAB_MCP_URL" bearer GITLAB_MCP_TOKEN

say "Registered upstreams (status is set by the 15 s health loop):"
gw_api GET /api/upstreams |
  json 'd.upstreams.map((u) => `  ${u.slug.padEnd(11)} ${u.status.padEnd(8)} tools=${u.toolCount} credential=${u.credentialType}`).join("\n")'
echo
