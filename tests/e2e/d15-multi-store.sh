#!/usr/bin/env bash
# D15 (multiple stores, ADR 015), with the whole stack deployed (2 gateway replicas, default deny):
#   1. RBAC + admission policy: the gateway's ServiceAccount can create namespaces but not read
#      Secrets in the release namespace or kube-system; the admission policy refuses it a
#      non-store namespace, deleting/relabelling another namespace, and a RoleBinding outside a
#      store namespace;
#   2. the admin creates store `shop2` via the API; both gateway pods are restarted mid-provision
#      (and the store limit set to 1 by the same rollout), and the next leader finishes the job:
#      namespace (Pod Security restricted, quota, default deny) + pods ready, bootstrap Job done,
#      phase Ready;
#   3. the storefront http://shop2.store.localtest.me answers 200 with WooCommerce;
#   4. upstream `shop2` is Connected; the admin's shop2__create_product creates a product that
#      shop2__list_products finds and woo__list_products (the built-in store) does not;
#   5. member B sees shop2__list_products but not shop2__create_product, and a direct call is
#      FORBIDDEN;
#   6. a pod in store-shop2 (with the woo-mcp label, i.e. allowed to reach its own WordPress)
#      cannot reach the built-in store's MariaDB/WordPress/woo-mcp, the gateway's Postgres, the
#      metadata IP, or a pod in another store namespace; and nothing from another store namespace
#      reaches shop2's MariaDB, WordPress or woo-mcp;
#   7. a second store is refused with the limit error;
#   8. delete shop2 (gateway pods restarted again mid-delete): the namespace and its volumes go,
#      the upstream, its permission rules and its tools go.
# No password, shared secret or Application Password appears in any API response.
set -uo pipefail
STEP=${STEP:-D15}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

NS=${NAMESPACE:-urumi}
KCTX=${KUBE_CONTEXT:-k3d-urumi}
SLUG=${D15_SLUG:-shop2}
SNS="store-$SLUG"
PEER_NS=store-d15peer
VICTIM_NS="d15-victim-$(date +%s)"
DOMAIN=${STORE_DOMAIN:-store.localtest.me}
STOREFRONT="http://$SLUG.$DOMAIN"
READY_TIMEOUT=${D15_READY_TIMEOUT:-600}
k() { kubectl --context "$KCTX" -n "$NS" "$@"; }
ks() { kubectl --context "$KCTX" -n "$SNS" "$@"; }
kc() { kubectl --context "$KCTX" "$@"; }
SA="system:serviceaccount:$NS:$RELEASE-gateway"
ADMIN_KEY="$E2E_OUT/d15-admin.key"
admin_key_id=""
orig_max=""
t0=$(date +%s)
elapsed() { echo "$(($(date +%s) - t0))s"; }

store_json() { # store_json <slug> : that store's object from GET /api/stores, or empty
  [ "$(api "$ADMIN_JAR" GET /api/stores)" = 200 ] || return 1
  jq -c --arg s "$1" '.stores[] | select(.slug == $s)' "$LAST"
}
store_field() { store_json "$1" | jq -r --arg f "$2" '.[$f] | tostring'; }
delete_store() { # delete_store <slug>
  local id
  id=$(store_field "$1" id 2>/dev/null)
  [ -n "$id" ] && api "$ADMIN_JAR" DELETE "/api/stores/$id" >/dev/null
  return 0
}
set_max() { # set_max <n> : MULTI_STORE_MAX_STORES on the gateway (a rolling restart of both pods)
  k set env "deploy/$RELEASE-gateway" "MULTI_STORE_MAX_STORES=$1" >/dev/null
}
cleanup() {
  ks delete pod -l d15=probe --wait=false --ignore-not-found >/dev/null 2>&1
  kc delete ns "$PEER_NS" "$VICTIM_NS" --wait=false --ignore-not-found >/dev/null 2>&1
  [ -n "$admin_key_id" ] && api "$ADMIN_JAR" DELETE "/api/keys/$admin_key_id" >/dev/null
  rm -f "$ADMIN_KEY"
  # Leave nothing behind, also when a check failed half-way.
  delete_store "$SLUG"
  delete_store d15lim
  if [ -n "$orig_max" ] && [ "$(k get deploy "$RELEASE-gateway" -o json | jq -r '.spec.template.spec.containers[0].env[] | select(.name == "MULTI_STORE_MAX_STORES") | .value')" != "$orig_max" ]; then
    set_max "$orig_max"
    k rollout status "deploy/$RELEASE-gateway" --timeout=180s >/dev/null 2>&1
  fi
}
trap cleanup EXIT

[ "$(api "$ADMIN_JAR" GET /api/auth/me)" = 200 ] || fail "admin session expired; run: tests/e2e/run.sh seed"
[ "$(api "$ADMIN_JAR" GET /api/stores)" = 200 ] || fail "GET /api/stores -> $(err_of)"
[ "$(jq -r .enabled "$LAST")" = true ] || fail "multiple stores are not enabled on the gateway (multiStore.enabled)"
note "stores config: $(jq -c '{maxStores, domainSuffix, builtIn}' "$LAST")"
orig_max=$(jq -r .maxStores "$LAST")
note "gateway ready replicas: $(k get deploy "$RELEASE-gateway" -o jsonpath='{.status.readyReplicas}'); node memory: $(kc top nodes --no-headers 2>/dev/null | awk '{print $1":"$4}' | tr '\n' ' ')"
# Leftovers of an aborted run.
delete_store "$SLUG"
delete_store d15lim
poll 240 sh -c "! kubectl --context $KCTX get ns $SNS store-d15lim >/dev/null 2>&1" ||
  fail "leftover store namespaces did not go away"

# ── 1. RBAC and the admission policy ────────────────────────────────────────────────────────
can() { kc auth can-i --as "$SA" "$@" 2>/dev/null; }
[ "$(can create namespaces)" = yes ] || fail "gateway SA cannot create namespaces"
for q in "get secrets -n $NS" "list secrets -n $NS" "get secrets -n kube-system" "list secrets -A" \
  "create pods -n $NS" "create deployments -n $NS" "delete pods -n kube-system" \
  "create clusterrolebindings" "create roles -n $NS" "escalate clusterroles" "impersonate users" \
  "create pods/exec -n $NS" "get secrets -n $SNS" "list secrets -n $SNS"; do
  # shellcheck disable=SC2086 # $q is a list of words
  [ "$(can $q)" = no ] || fail "gateway SA can: $q"
done
note "gateway SA: can create namespaces; cannot read Secrets ($NS, kube-system, store namespaces), write in $NS, or escalate"
out=$(kc create ns d15-not-a-store --as "$SA" 2>&1) && fail "admission policy allowed a non-store namespace"
printf '%s' "$out" | grep -q 'store-guard' || fail "non-store namespace refused for the wrong reason: $out"
note "admission policy: create ns d15-not-a-store -> $(printf '%s' "$out" | head -c 160)"
kc create ns "$VICTIM_NS" >/dev/null || fail "cannot create $VICTIM_NS as admin"
out=$(kc delete ns "$VICTIM_NS" --as "$SA" --wait=false 2>&1) && fail "admission policy let the gateway delete $VICTIM_NS"
printf '%s' "$out" | grep -q 'store-guard' || fail "delete of $VICTIM_NS refused for the wrong reason: $out"
out=$(kc label ns "$VICTIM_NS" urumi.io/store=true --as "$SA" 2>&1) && fail "admission policy let the gateway relabel $VICTIM_NS"
note "admission policy: delete / relabel another namespace -> refused"
out=$(kc -n "$NS" create rolebinding d15-escalate --clusterrole "$RELEASE-store-manager" \
  --serviceaccount "$NS:$RELEASE-gateway" --as "$SA" 2>&1) && fail "the gateway bound store-manager in $NS"
note "admission policy: RoleBinding to store-manager in $NS -> $(printf '%s' "$out" | head -c 160)"

# ── 2. Create shop2; restart the gateway mid-provision ───────────────────────────────────────
code=$(jq -n --arg s "$SLUG" '{slug: $s, name: "D15 Shop Two", adminEmail: "d15-owner@example.com"}' |
  api "$ADMIN_JAR" POST /api/stores)
[ "$code" = 201 ] || fail "create store -> HTTP $code: $(err_of)"
grep -qiE 'password|"secret"' "$LAST" && fail "the create response mentions a password/secret"
note "created ($(elapsed)): $(jq -c '.store | {slug, namespace, phase, reason, storefrontUrl}' "$LAST")"
poll 30 ks get statefulset mariadb >/dev/null 2>&1 || fail "no MariaDB StatefulSet in $SNS"
# Kill both gateway pods (a rolling restart that also lowers the store limit to 1, used in step 7).
set_max 1
note "gateway rollout started mid-provision ($(elapsed)); phase: $(store_field "$SLUG" phase) / $(store_field "$SLUG" reason)"
k rollout status "deploy/$RELEASE-gateway" --timeout=240s >&2 || fail "gateway rollout did not finish"
note "gateway rolled ($(elapsed)); lease holder: $(k exec "$RELEASE-postgres-0" -- psql -U gateway -d gateway -tAc "select holder from gateway_leases where name = 'stores'" 2>/dev/null)"

last=""
ready() {
  local s
  s=$(store_json "$SLUG") || return 1
  local now="$(printf '%s' "$s" | jq -r '.phase + " / " + (.reason // "")')"
  [ "$now" != "$last" ] && note "  $(elapsed): $now" && last=$now
  case "$(printf '%s' "$s" | jq -r .phase)" in
    ready) return 0 ;;
    failed) fail "store failed: $(printf '%s' "$s" | jq -r .reason)" ;;
  esac
  return 1
}
poll "$READY_TIMEOUT" ready || {
  ks get pods,jobs -o wide >&2
  fail "store not ready after ${READY_TIMEOUT}s: $(store_field "$SLUG" phase) / $(store_field "$SLUG" reason)"
}
note "ready after $(elapsed)"
nsl=$(kc get ns "$SNS" -o json | jq -c '.metadata.labels | {store: .["urumi.io/store"], psa: .["pod-security.kubernetes.io/enforce"]}')
[ "$(printf '%s' "$nsl" | jq -r .psa)" = restricted ] || fail "$SNS does not enforce Pod Security restricted: $nsl"
note "namespace $SNS labels: $nsl"
note "pods: $(ks get pods --no-headers | awk '{print $1"="$3}' | tr '\n' ' ')"
note "job: $(ks get jobs --no-headers | awk '{print $1" "$2}' | tr '\n' ' ')"
note "quota: $(ks get resourcequota store-quota -o json | jq -c '.status.used | {pods, "requests.memory", "limits.memory", persistentvolumeclaims}')"
note "netpols: $(ks get networkpolicy -o name | sed 's|.*/||' | tr '\n' ' ')"
[ "$(ks get pvc --no-headers | awk '$2 == "Bound"' | wc -l | tr -d ' ')" = 2 ] || fail "store PVCs not both Bound: $(ks get pvc --no-headers)"
pvs=$(kc get pv -o json | jq -r --arg ns "$SNS" '[.items[] | select(.spec.claimRef.namespace == $ns) | .metadata.name] | join(" ")')
note "PVs of $SNS: $pvs"

# ── 3. Storefront ────────────────────────────────────────────────────────────────────────────
code=$(curl -sS -o "$E2E_OUT/d15-storefront.html" -w '%{http_code}' --max-time 30 "$STOREFRONT/")
[ "$code" = 200 ] || fail "GET $STOREFRONT/ -> HTTP $code"
grep -qi woocommerce "$E2E_OUT/d15-storefront.html" || fail "the storefront page does not look like WooCommerce"
code=$(curl -sS -o "$E2E_OUT/d15-products.json" -w '%{http_code}' --max-time 30 "$STOREFRONT/wp-json/wc/store/v1/products")
[ "$code" = 200 ] || fail "GET $STOREFRONT/wp-json/wc/store/v1/products -> HTTP $code"
note "storefront $STOREFRONT/: HTTP 200, WooCommerce; Store API products: $(jq -c '[.[].name]' "$E2E_OUT/d15-products.json")"

# ── 4. Upstream + tools (admin) ──────────────────────────────────────────────────────────────
[ "$(upstream_field "$SLUG" store)" = true ] || fail "no store upstream row for $SLUG"
up_ok() { [ "$(upstream_field "$SLUG" status)" = up ] && [ "$(upstream_field "$SLUG" enabled)" = true ]; }
poll 30 up_ok || fail "upstream $SLUG not up+enabled"
note "upstream $SLUG: $(jq -c --arg s "$SLUG" '.upstreams[] | select(.slug == $s) | {slug, enabled, status, store, toolCount}' "$LAST")"
for path in /api/stores /api/upstreams; do
  api "$ADMIN_JAR" GET "$path" >/dev/null
  grep -qiE 'password|app_password|x-woo-mcp-secret"?: *"' "$LAST" && fail "$path returns a credential"
done
code=$(jq -n --arg n "e2e $RUN_ID d15" '{name: $n}' | api "$ADMIN_JAR" POST /api/keys)
[ "$code" = 201 ] || fail "create admin key -> HTTP $code: $(err_of)"
rm -f "$ADMIN_KEY"
jq -r .secret "$LAST" >"$ADMIN_KEY"
chmod 600 "$ADMIN_KEY"
admin_key_id=$(jq -r .key.id "$LAST")
: >"$LAST"
has() { printf '%s' "$1" | jq -e --arg t "$2" '.tools | index($t) != null' >/dev/null; }
alist=$(mcp "$ADMIN_KEY" list) || fail "admin tools/list failed"
for t in create_product list_products list_orders get_order; do
  has "$alist" "${SLUG}__$t" || fail "admin's tools/list lacks ${SLUG}__$t"
done
PRODUCT="D15 Tee $RUN_ID"
res=$(mcp "$ADMIN_KEY" call "${SLUG}__create_product" "$(jq -nc --arg n "$PRODUCT" '{name: $n, regular_price: "321"}')")
pid=$(printf '%s' "$res" | jq -r '.content[0].text | fromjson | .product.id' 2>/dev/null)
[ -n "$pid" ] && [ "$pid" != null ] || fail "${SLUG}__create_product failed: $(printf '%s' "$res" | head -c 300)"
note "admin ${SLUG}__create_product -> product $pid ($PRODUCT)"
found() { # found <slug> : the product name appears in that store's list_products
  mcp "$ADMIN_KEY" call "$1__list_products" "$(jq -nc --arg n "$PRODUCT" '{search: $n}')" |
    jq -e --arg n "$PRODUCT" '.content[0].text | fromjson | .products | map(.name) | index($n) != null' >/dev/null
}
found "$SLUG" || fail "${SLUG}__list_products does not find $PRODUCT"
found woo && fail "the built-in store (woo__list_products) shows a product created in $SLUG"
note "$PRODUCT: in ${SLUG}__list_products, not in woo__list_products"

# ── 5. Member defaults ───────────────────────────────────────────────────────────────────────
blist=$(mcp "$B_KEY2" list) || fail "B tools/list failed"
has "$blist" "${SLUG}__list_products" || fail "member B does not see ${SLUG}__list_products"
has "$blist" "${SLUG}__create_product" && fail "member B sees ${SLUG}__create_product"
bres=$(mcp "$B_KEY2" call "${SLUG}__create_product" '{"name":"denied","regular_price":"1"}')
expect B mcp "$SLUG" create_product denied
[ "$(printf '%s' "$bres" | jq -r '.content[0].text | fromjson | .error.code' 2>/dev/null)" = FORBIDDEN ] ||
  fail "B's ${SLUG}__create_product was not FORBIDDEN: $(printf '%s' "$bres" | head -c 200)"
note "member B: sees $(printf '%s' "$blist" | jq -c --arg p "${SLUG}__" '[.tools[] | select(startswith($p))]'); create_product FORBIDDEN"

# ── 6. Isolation ─────────────────────────────────────────────────────────────────────────────
probe_image=$(k get deploy "$RELEASE-gateway" -o jsonpath='{.spec.template.spec.containers[0].image}')
podspec() { # podspec <name> <command json>
  printf '{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"%s","image":"%s","command":%s,"resources":{"requests":{"cpu":"5m","memory":"16Mi"},"limits":{"cpu":"100m","memory":"64Mi"}},"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' "$1" "$probe_image" "$2"
}
# Another store namespace with a pod listening on 8080, and NO NetworkPolicy of its own (worst case).
kc create ns "$PEER_NS" >/dev/null 2>&1
kc label ns "$PEER_NS" urumi.io/store=true pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
kc -n "$PEER_NS" run d15-peer --image "$probe_image" --restart Never --labels "d15=probe,app.kubernetes.io/component=woo-mcp" \
  --overrides "$(podspec d15-peer '["node","-e","require(\"net\").createServer((s)=>s.end()).listen(8080)"]')" >/dev/null ||
  fail "cannot start the peer pod in $PEER_NS"
ks run d15-probe --image "$probe_image" --restart Never --labels "d15=probe,app.kubernetes.io/component=woo-mcp" \
  --overrides "$(podspec d15-probe '["sleep","300"]')" >/dev/null || fail "kubectl run d15-probe in $SNS failed (Pod Security? quota?)"
ks wait --for=condition=Ready pod/d15-probe --timeout=90s >/dev/null || fail "probe pod not Ready"
kc -n "$PEER_NS" wait --for=condition=Ready pod/d15-peer --timeout=90s >/dev/null || fail "peer pod not Ready"
peer_ip=$(kc -n "$PEER_NS" get pod d15-peer -o jsonpath='{.status.podIP}')
reach() { kubectl --context "$KCTX" -n "$1" exec "$2" -- nc -z -w 3 "$3" "$4" >/dev/null 2>&1; }
# Positive controls: the probe (woo-mcp label) reaches its own WordPress; the peer reaches DNS.
reach "$SNS" d15-probe wordpress 80 || fail "probe cannot reach its own WordPress (control)"
reach "$PEER_NS" d15-peer kube-dns.kube-system.svc.cluster.local 53 || fail "peer cannot reach DNS (control)"
for target in "$RELEASE-mariadb.$NS.svc.cluster.local:3306" "$RELEASE-wordpress.$NS.svc.cluster.local:80" \
  "$RELEASE-woo-mcp.$NS.svc.cluster.local:8080" "$RELEASE-postgres.$NS.svc.cluster.local:5432" \
  "$RELEASE-gateway.$NS.svc.cluster.local:8080" "169.254.169.254:80" "$peer_ip:8080" "mariadb:3306"; do
  if reach "$SNS" d15-probe "${target%:*}" "${target##*:}"; then fail "a pod in $SNS reached $target"; fi
  note "blocked from $SNS (woo-mcp label): $target"
done
for target in "mariadb.$SNS.svc.cluster.local:3306" "wordpress.$SNS.svc.cluster.local:80" "woo-mcp.$SNS.svc.cluster.local:80"; do
  if reach "$PEER_NS" d15-peer "${target%:*}" "${target##*:}"; then fail "another store namespace reached $target"; fi
  note "blocked from $PEER_NS: $target"
done
ks delete pod d15-probe --wait=false >/dev/null 2>&1
kc delete ns "$PEER_NS" --wait=false >/dev/null 2>&1

# ── 7. Limit ─────────────────────────────────────────────────────────────────────────────────
code=$(jq -n '{slug: "d15lim", name: "Over the limit", adminEmail: "x@example.com"}' | api "$ADMIN_JAR" POST /api/stores)
[ "$code" = 400 ] || fail "second store with limit 1 -> HTTP $code (expected 400)"
err_of | grep -q 'Store limit reached (1 of 1)' || fail "limit error is unclear: $(err_of)"
kc get ns store-d15lim >/dev/null 2>&1 && fail "a namespace was created over the limit"
note "limit: $(err_of)"
code=$(jq -n '{slug: "woo", name: "x", adminEmail: "x@example.com"}' | api "$ADMIN_JAR" POST /api/stores)
[ "$code" = 400 ] || fail "reserved slug woo -> HTTP $code"
note "reserved slug: $(err_of)"

# ── 8. Delete (gateway restarted mid-delete) ─────────────────────────────────────────────────
id=$(store_field "$SLUG" id)
td=$(date +%s)
[ "$(api "$ADMIN_JAR" DELETE "/api/stores/$id")" = 202 ] || fail "delete store -> $(err_of)"
note "delete requested: $(jq -c '.store | {phase, reason, upstreamEnabled}' "$LAST")"
alist=$(mcp "$ADMIN_KEY" list) || fail "admin tools/list failed"
has "$alist" "${SLUG}__list_products" && fail "${SLUG}__* tools still listed right after delete"
set_max "$orig_max"
k rollout status "deploy/$RELEASE-gateway" --timeout=240s >&2 || fail "gateway rollout (restore) did not finish"
gone() { ! kc get ns "$SNS" >/dev/null 2>&1; }
poll 300 gone || fail "namespace $SNS still there after delete: $(kc get ns "$SNS" -o jsonpath='{.status.phase}')"
rows_gone() { [ -z "$(store_json "$SLUG")" ] && [ -z "$(upstream_field "$SLUG" id)" ]; }
poll 60 rows_gone || fail "store/upstream rows left after the namespace went"
note "namespace + rows gone $(($(date +%s) - td))s after delete"
for pv in $pvs; do
  pv_gone() { ! kc get pv "$pv" >/dev/null 2>&1; }
  poll 120 pv_gone || fail "PV $pv of $SNS still exists"
done
note "PVs deleted: $pvs"
[ "$(api "$ADMIN_JAR" GET /api/permissions)" = 200 ] || fail "list permissions failed"
jq -e --arg s "$SLUG" '[.rules[] | select(.serverSlug == $s)] | length == 0' "$LAST" >/dev/null ||
  fail "permission rules for $SLUG left after delete"
alist=$(mcp "$ADMIN_KEY" list) || fail "admin tools/list failed"
printf '%s' "$alist" | jq -e --arg p "${SLUG}__" '[.tools[] | select(startswith($p))] | length == 0' >/dev/null ||
  fail "${SLUG}__* tools listed after delete"
note "deleted: no namespace, PVs, upstream, rules or tools for $SLUG (total $(elapsed))"
pass
