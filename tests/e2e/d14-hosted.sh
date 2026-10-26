#!/usr/bin/env bash
# D14 (hosted MCP servers, ADR 014), with the whole stack deployed (2 gateway replicas, default
# deny on):
#   1. the admin creates hosted server `d14` from the repo's own everything image via the API (with
#      a write-only env var) -> Deployment mcp-d14 becomes ready in the hosted namespace, its pod
#      runs with the hardened template, and the server's status becomes `connected`;
#   2. its tools are listed as d14__* for the admin over MCP; member B does not see them and a
#      direct call is refused (FORBIDDEN) until a permission grants d14 echo; then B's call works
#      and both are audited (denied + ok);
#   3. a pod in the hosted namespace (with the hosted labels) resolves DNS but cannot reach
#      Postgres, woo-mcp, WordPress, MariaDB, the cloud metadata IP, or the hosted server itself;
#   4. an image off the allow-list is rejected (400, clear message);
#   5. an allowed-prefix image that does not exist shows `failed` with ImagePullBackOff;
#   6. deleting both removes every Kubernetes object and the upstream rows (tools gone).
# The env var value never appears in any API response.
set -uo pipefail
STEP=${STEP:-D14}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

NS=${NAMESPACE:-urumi}
HNS=${HOSTED_NAMESPACE:-urumi-hosted}
KCTX=${KUBE_CONTEXT:-k3d-urumi}
k() { kubectl --context "$KCTX" -n "$NS" "$@"; }
kh() { kubectl --context "$KCTX" -n "$HNS" "$@"; }
IMAGE=${D14_IMAGE:-k3d-urumi-registry.localhost:5005/urumi-everything:dev}
BAD_IMAGE=k3d-urumi-registry.localhost:5005/urumi-does-not-exist:d14
SLUG=d14
BAD=d14bad
SUFFIX=$(date +%s)
PROBE="d14-probe-$SUFFIX"
ADMIN_KEY="$E2E_OUT/d14-admin.key"
ENV_VALUE="d14-env-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
admin_key_id=""
perm_id=""

hosted_id() { # hosted_id <slug> : id of that hosted server, or empty
  [ "$(api "$ADMIN_JAR" GET /api/hosted-servers)" = 200 ] || return 1
  jq -r --arg s "$1" '.servers[] | select(.slug == $s) | .id' "$LAST"
}
hosted_field() { # hosted_field <slug> <field>
  [ "$(api "$ADMIN_JAR" GET /api/hosted-servers)" = 200 ] || return 1
  jq -r --arg s "$1" --arg f "$2" '.servers[] | select(.slug == $s) | .[$f] | tostring' "$LAST"
}
delete_hosted() { # delete_hosted <slug>
  local id
  id=$(hosted_id "$1")
  [ -n "$id" ] && api "$ADMIN_JAR" DELETE "/api/hosted-servers/$id" >/dev/null
  return 0
}
cleanup() {
  kh delete pod "$PROBE" --wait=false --ignore-not-found >/dev/null 2>&1
  [ -n "$perm_id" ] && api "$ADMIN_JAR" DELETE "/api/permissions/$perm_id" >/dev/null
  [ -n "$admin_key_id" ] && api "$ADMIN_JAR" DELETE "/api/keys/$admin_key_id" >/dev/null
  rm -f "$ADMIN_KEY"
  # Leave nothing behind, also when a check failed half-way.
  delete_hosted "$SLUG"
  delete_hosted "$BAD"
}
trap cleanup EXIT

[ "$(api "$ADMIN_JAR" GET /api/auth/me)" = 200 ] || fail "admin session expired; run: tests/e2e/run.sh seed"
ADMIN_ID=$(jq -r .user.id "$LAST")
[ "$(api "$ADMIN_JAR" GET /api/hosted-servers)" = 200 ] || fail "GET /api/hosted-servers -> $(err_of)"
[ "$(jq -r .enabled "$LAST")" = true ] || fail "hosted servers are not enabled on the gateway (hosted.enabled)"
replicas=$(k get deploy "$RELEASE-gateway" -o jsonpath='{.status.readyReplicas}')
note "gateway ready replicas: $replicas; netpols in $HNS: $(kh get networkpolicy -o name | tr '\n' ' ')"
# Leftovers of an aborted run.
delete_hosted "$SLUG"
delete_hosted "$BAD"
poll 60 sh -c "! kubectl --context $KCTX -n $HNS get deploy mcp-$SLUG mcp-$BAD >/dev/null 2>&1" ||
  fail "leftover hosted objects did not go away"
start=$(server_now) || fail "gateway not reachable at $APP_URL"

# ── 1. Create from the everything image ─────────────────────────────────────────────────────
code=$(jq -n --arg s "$SLUG" --arg i "$IMAGE" --arg v "$ENV_VALUE" \
  '{slug: $s, name: "D14 hosted everything", image: $i, port: 3001, mcpPath: "/mcp",
    preset: "small", egress: false, env: {D14_TOKEN: $v}}' | api "$ADMIN_JAR" POST /api/hosted-servers)
[ "$code" = 201 ] || fail "create hosted server -> HTTP $code: $(err_of)"
grep -q "$ENV_VALUE" "$LAST" && fail "the create response contains the env value"
note "created: $(jq -c '.server | {slug, image, phase, reason, url, envKeys}' "$LAST")"
id=$(jq -r .server.id "$LAST")

kh rollout status "deploy/mcp-$SLUG" --timeout=150s >&2 || {
  kh get pods -l "urumi.io/hosted-slug=$SLUG" -o wide >&2
  fail "deploy/mcp-$SLUG did not become ready in $HNS"
}
pod=$(kh get pods -l "urumi.io/hosted-slug=$SLUG" -o jsonpath='{.items[0].metadata.name}')
sec=$(kh get pod "$pod" -o json | jq -c '{
  automount: .spec.automountServiceAccountToken,
  runAsNonRoot: .spec.securityContext.runAsNonRoot,
  uid: .spec.securityContext.runAsUser,
  seccomp: .spec.securityContext.seccompProfile.type,
  roRoot: .spec.containers[0].securityContext.readOnlyRootFilesystem,
  privEsc: .spec.containers[0].securityContext.allowPrivilegeEscalation,
  caps: .spec.containers[0].securityContext.capabilities.drop,
  limits: .spec.containers[0].resources.limits,
  envFrom: .spec.containers[0].envFrom}')
note "pod $pod: $sec"
printf '%s' "$sec" | jq -e '.automount == false and .runAsNonRoot == true and .uid != 0 and
  .seccomp == "RuntimeDefault" and .roRoot == true and .privEsc == false and .caps == ["ALL"] and
  .limits.memory != null' >/dev/null || fail "hosted pod is not hardened: $sec"
note "namespace labels: $(kubectl --context "$KCTX" get ns "$HNS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"

connected() { [ "$(hosted_field "$SLUG" phase)" = connected ]; }
poll 90 connected || fail "hosted server never became connected: $(hosted_field "$SLUG" phase) / $(hosted_field "$SLUG" reason)"
note "status: $(jq -c --arg s "$SLUG" '.servers[] | select(.slug == $s) | {phase, reason, toolCount, url}' "$LAST")"
[ "$(upstream_field "$SLUG" hosted)" = true ] || fail "no hosted upstream row for $SLUG"
[ "$(upstream_field "$SLUG" status)" = up ] || fail "upstream $SLUG is not up"
for path in /api/hosted-servers /api/upstreams /api/tools; do
  api "$ADMIN_JAR" GET "$path" >/dev/null
  grep -q "$ENV_VALUE" "$LAST" && fail "$path returns the env value"
done

# ── 2. Tools for the admin; member B only after a grant; audited ────────────────────────────
code=$(jq -n --arg n "e2e $RUN_ID d14" '{name: $n}' | api "$ADMIN_JAR" POST /api/keys)
[ "$code" = 201 ] || fail "create admin key -> HTTP $code: $(err_of)"
rm -f "$ADMIN_KEY"
jq -r .secret "$LAST" >"$ADMIN_KEY"
chmod 600 "$ADMIN_KEY"
admin_key_id=$(jq -r .key.id "$LAST")
: >"$LAST"
has() { printf '%s' "$1" | jq -e --arg t "$2" '.tools | index($t) != null' >/dev/null; }
count_slug() { printf '%s' "$1" | jq --arg p "${SLUG}__" '[.tools[] | select(startswith($p))] | length'; }

alist=$(mcp "$ADMIN_KEY" list) || fail "admin tools/list failed: $(printf '%s' "$alist" | jq -c .error)"
has "$alist" "${SLUG}__echo" || fail "admin's tools/list lacks ${SLUG}__echo"
note "admin sees $(count_slug "$alist") ${SLUG}__* tools"
aresult=$(mcp "$ADMIN_KEY" call "${SLUG}__echo" '{"message":"hello from d14"}')
printf '%s' "$aresult" | jq -e '.isError != true and (.content[0].text | test("hello from d14"))' >/dev/null ||
  fail "admin ${SLUG}__echo failed: $(printf '%s' "$aresult" | head -c 200)"

blist=$(mcp "$B_KEY2" list) || fail "B tools/list failed"
[ "$(count_slug "$blist")" = 0 ] || fail "member B sees ${SLUG}__* tools without a grant"
bres=$(mcp "$B_KEY2" call "${SLUG}__echo" '{"message":"denied"}')
expect B mcp "$SLUG" echo denied
[ "$(printf '%s' "$bres" | jq -r '.content[0].text | fromjson | .error.code' 2>/dev/null)" = FORBIDDEN ] ||
  fail "B's ungranted ${SLUG}__echo was not FORBIDDEN: $(printf '%s' "$bres" | head -c 200)"

code=$(jq -n --arg s "$SLUG" '{role: "member", serverSlug: $s, tool: "echo", effect: "allow"}' |
  api "$ADMIN_JAR" POST /api/permissions)
case "$code" in 200 | 201) ;; *) fail "grant member $SLUG echo -> HTTP $code: $(err_of)" ;; esac
perm_id=$(jq -r .rule.id "$LAST")
blist=$(mcp "$B_KEY2" list) || fail "B tools/list failed"
has "$blist" "${SLUG}__echo" || fail "B does not see ${SLUG}__echo after the grant"
[ "$(count_slug "$blist")" = 1 ] || fail "B sees more than the granted ${SLUG} tool"
bres=$(mcp "$B_KEY2" call "${SLUG}__echo" '{"message":"granted"}')
expect B mcp "$SLUG" echo ok
printf '%s' "$bres" | jq -e '.isError != true' >/dev/null || fail "B's granted call failed: $(printf '%s' "$bres" | head -c 200)"
audit_row() { # audit_row <user-id> <outcome>
  [ "$(api "$ADMIN_JAR" GET "/api/audit?userId=$1&serverSlug=$SLUG&tool=echo&outcome=$2&from=$start&limit=1")" = 200 ] || return 1
  jq -ce '.items[0] // empty' "$LAST"
}
for o in denied ok; do
  row=$(audit_row "$B_ID" "$o") || fail "no audit row ($o) for B's ${SLUG}__echo"
  note "audit (B, $o): $(printf '%s' "$row" | jq -c '{userEmail, source, serverSlug, tool, outcome, errorCode}')"
done
row=$(audit_row "$ADMIN_ID" ok) || fail "no audit row for the admin's ${SLUG}__echo"
api "$ADMIN_JAR" DELETE "/api/permissions/$perm_id" >/dev/null
perm_id=""

# ── 3. NetworkPolicy: the hosted namespace reaches nothing internal ──────────────────────────
probe_image=$(k get deploy "$RELEASE-gateway" -o jsonpath='{.spec.template.spec.containers[0].image}')
kh run "$PROBE" --image "$probe_image" --image-pull-policy IfNotPresent --restart Never \
  --labels "app.kubernetes.io/managed-by=urumi-gateway,urumi.io/hosted-egress=none,urumi.io/hosted-slug=probe" \
  --overrides '{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"'"$PROBE"'","image":"'"$probe_image"'","command":["sleep","300"],"resources":{"requests":{"cpu":"5m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"64Mi"}},"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
  >/dev/null || fail "kubectl run $PROBE in $HNS failed (Pod Security?)"
kh wait --for=condition=Ready "pod/$PROBE" --timeout=90s >/dev/null || fail "probe pod not Ready"
reach() { kh exec "$PROBE" -- nc -z -w 3 "$1" "$2" >/dev/null 2>&1; }
kh exec "$PROBE" -- nslookup "$RELEASE-postgres.$NS.svc.cluster.local" >/dev/null 2>&1 ||
  fail "probe cannot resolve DNS (DNS egress must stay allowed)"
for target in "$RELEASE-postgres.$NS.svc.cluster.local:5432" "$RELEASE-woo-mcp.$NS.svc.cluster.local:8080" \
  "$RELEASE-wordpress.$NS.svc.cluster.local:80" "$RELEASE-mariadb.$NS.svc.cluster.local:3306" \
  "$RELEASE-gateway.$NS.svc.cluster.local:8080" "169.254.169.254:80" "mcp-$SLUG.$HNS.svc.cluster.local:3001"; do
  if reach "${target%:*}" "${target##*:}"; then fail "hosted-namespace pod reached $target"; fi
  note "blocked from $HNS: $target"
done

# ── 4. Disallowed image ──────────────────────────────────────────────────────────────────────
code=$(jq -n '{slug: "d14evil", name: "evil", image: "ghcr.io/evil/mcp-server:latest", port: 8080}' |
  api "$ADMIN_JAR" POST /api/hosted-servers)
[ "$code" = 400 ] || fail "disallowed image -> HTTP $code (expected 400)"
note "disallowed image: $(err_of)"
err_of | grep -q 'not allowed' || fail "disallowed image error is unclear: $(err_of)"
kh get deploy mcp-d14evil >/dev/null 2>&1 && fail "a Deployment was created for the disallowed image"

# ── 5. Bad image -> Failed (ImagePullBackOff) ───────────────────────────────────────────────
code=$(jq -n --arg s "$BAD" --arg i "$BAD_IMAGE" '{slug: $s, name: "D14 bad image", image: $i, port: 8080}' |
  api "$ADMIN_JAR" POST /api/hosted-servers)
[ "$code" = 201 ] || fail "create bad-image server -> HTTP $code: $(err_of)"
backoff() { [ "$(hosted_field "$BAD" phase)" = failed ] && hosted_field "$BAD" reason | grep -q '^ImagePullBackOff'; }
poll 150 backoff || fail "bad image not failed with ImagePullBackOff: $(hosted_field "$BAD" phase) / $(hosted_field "$BAD" reason)"
note "bad image: $(jq -c --arg s "$BAD" '.servers[] | select(.slug == $s) | {phase, reason}' "$LAST")"
[ "$(upstream_field "$BAD" enabled)" = false ] || fail "a failed hosted server was registered as an enabled upstream"

# ── 6. Delete removes everything ─────────────────────────────────────────────────────────────
for s in "$SLUG" "$BAD"; do
  hid=$(hosted_id "$s")
  [ "$(api "$ADMIN_JAR" DELETE "/api/hosted-servers/$hid")" = 204 ] || fail "delete $s -> $(err_of)"
done
gone() { [ -z "$(kh get deploy,svc,secret,pods -l "urumi.io/hosted-slug in ($SLUG,$BAD)" -o name 2>/dev/null)" ]; }
poll 90 gone || fail "objects left after delete: $(kh get deploy,svc,secret,pods -l "urumi.io/hosted-slug in ($SLUG,$BAD)" -o name | tr '\n' ' ')"
[ "$(api "$ADMIN_JAR" GET /api/upstreams)" = 200 ] || fail "list upstreams failed"
jq -e --arg a "$SLUG" --arg b "$BAD" '[.upstreams[] | select(.slug == $a or .slug == $b)] | length == 0' "$LAST" >/dev/null ||
  fail "upstream rows left after delete"
alist=$(mcp "$ADMIN_KEY" list) || fail "admin tools/list failed"
[ "$(count_slug "$alist")" = 0 ] || fail "${SLUG}__* tools still listed after delete"
note "deleted: no Deployment/Service/Secret/Pod and no upstream row for $SLUG, $BAD"
pass
