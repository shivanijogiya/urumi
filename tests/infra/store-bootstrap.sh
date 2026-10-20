#!/usr/bin/env bash
# Store bootstrap test (W4, K6, D1), run against the installed release:
#   1. Secret urumi-woo-api exists with WOO_URL, WOO_USER, WOO_APP_PASSWORD
#   2. from a temporary in-cluster pod: GET /wp-json/wc/v3/orders with the Application Password
#      -> 200, with a wrong password -> 401; the same call through the store Ingress -> 200
#   3. COD enabled: GET /wp-json/wc/v3/payment_gateways/cod -> enabled: true
#   4. D1: Store API checkout of "Demo Tee" with COD against $STORE_URL -> order id; the admin
#      REST API returns that order (200) with payment_method cod
#   5. the bootstrap Job's logs contain neither the Application Password nor the admin password
#   6. re-runs the hook (helm upgrade) -> Job succeeds, the Application Password is unchanged and
#      still authenticates (idempotent). SKIP_UPGRADE=1 skips this step.
# Idempotent (each run places one more COD order). Never prints a secret: secrets stay in shell
# variables and reach curl as a config on stdin, never in argv.
# Prints PASS/FAIL per check; exits non-zero if any check fails.
#   RELEASE    Helm release name, default urumi
#   STORE_URL  storefront base URL, default http://store.localtest.me
#   tests/infra/store-bootstrap.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"

RELEASE=${RELEASE:-urumi}
STORE_URL=${STORE_URL:-http://store.localtest.me}
SECRET=${RELEASE}-woo-api
ENV_SECRET=${ENV_SECRET:-urumi-env}
JOB=${RELEASE}-bootstrap
CHART="$ROOT/charts/platform"

need kubectl "Install it with: brew install kubectl"
need helm "Install it with: brew install helm"
need curl "Install curl"
need jq "Install it with: brew install jq"
require_context

failed=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  failed=1
}

secret_value() { kc -n "$NAMESPACE" get secret "$1" -o "go-template={{index .data \"$2\" | base64decode}}"; }
fingerprint() { printf '%s' "$1" | shasum -a 256 | cut -c1-12; }

# curl_auth <user> <password> <curl args...>: credentials go in a config on stdin, not argv.
curl_auth() {
  local user=$1 password=$2
  shift 2
  printf 'user = "%s:%s"\n' "$user" "$password" | curl -sS --max-time 20 -K - "$@"
}

# --- 1. Secret ----------------------------------------------------------------------------------
keys=$(kc -n "$NAMESPACE" get secret "$SECRET" -o go-template='{{range $k, $_ := .data}}{{$k}} {{end}}' 2>/dev/null || true)
missing=""
for k in WOO_URL WOO_USER WOO_APP_PASSWORD; do
  case " $keys " in *" $k "*) ;; *) missing="$missing $k" ;; esac
done
if [ -z "$keys" ]; then
  fail "secret $SECRET has WOO_URL, WOO_USER, WOO_APP_PASSWORD" "secret not found"
  exit 1
elif [ -n "$missing" ]; then
  fail "secret $SECRET has WOO_URL, WOO_USER, WOO_APP_PASSWORD" "missing:$missing"
  exit 1
fi
pass "secret $SECRET has WOO_URL, WOO_USER, WOO_APP_PASSWORD"

WOO_USER=$(secret_value "$SECRET" WOO_USER)
WOO_PASS=$(secret_value "$SECRET" WOO_APP_PASSWORD)
pass_fp=$(fingerprint "$WOO_PASS")

# --- 2 + 3. In-cluster REST checks -------------------------------------------------------------
# A throwaway pod with the Secret as env; it prints only status codes. Image: the Job's kubectl
# image (already on the node, has curl + jq).
probe_image=$(helm -n "$NAMESPACE" get values "$RELEASE" --all -o json --kube-context "$KUBE_CONTEXT" |
  jq -r '.bootstrap.kubectl.image | "\(.repository):\(.tag)"')
# shellcheck disable=SC2016 # runs in the pod
probe_script='
set -u
auth() { printf "user = \"%s:%s\"\n" "$WOO_USER" "$1"; }
code() { curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -K - "$1"; }
echo "RESULT orders=$(auth "$WOO_APP_PASSWORD" | code "$WOO_URL/wp-json/wc/v3/orders?per_page=1")"
echo "RESULT wrong=$(auth "wrong-password-$$" | code "$WOO_URL/wp-json/wc/v3/orders?per_page=1")"
echo "RESULT cod=$(auth "$WOO_APP_PASSWORD" | curl -sS --max-time 15 -K - "$WOO_URL/wp-json/wc/v3/payment_gateways/cod" | jq -r .enabled)"
'
overrides=$(jq -n --arg img "$probe_image" --arg script "$probe_script" --arg secret "$SECRET" '{
  spec: {
    automountServiceAccountToken: false,
    securityContext: {runAsNonRoot: true, runAsUser: 65534, seccompProfile: {type: "RuntimeDefault"}},
    containers: [{
      name: "probe", image: $img, command: ["bash", "-c", $script],
      envFrom: [{secretRef: {name: $secret}}],
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}},
      resources: {requests: {cpu: "10m", memory: "32Mi"}, limits: {cpu: "200m", memory: "128Mi"}}
    }]
  }
}')
say "Running in-cluster REST probe ($probe_image)"
# Detached + `kubectl logs` after it finishes: `kubectl run -i` can drop early output lines.
probe_pod="store-bootstrap-probe-$$"
trap 'kc -n "$NAMESPACE" delete pod "$probe_pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT
kc -n "$NAMESPACE" run "$probe_pod" --restart=Never --image="$probe_image" --overrides="$overrides" >/dev/null
kc -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$probe_pod" --timeout=300s >/dev/null 2>&1 || true
probe_out=$(kc -n "$NAMESPACE" logs "pod/$probe_pod" 2>&1 || true)
kc -n "$NAMESPACE" delete pod "$probe_pod" --ignore-not-found >/dev/null 2>&1 || true
result() { printf '%s\n' "$probe_out" | sed -n "s/^RESULT $1=//p" | tail -1; }

got=$(result orders)
if [ "$got" = 200 ]; then pass "in-cluster GET /wc/v3/orders with Application Password -> 200"; else
  fail "in-cluster GET /wc/v3/orders with Application Password -> 200" "got '${got:-no result}'"
  printf '%s\n' "$probe_out" | grep -v '^RESULT' | tail -5
fi
got=$(result wrong)
if [ "$got" = 401 ]; then pass "in-cluster GET /wc/v3/orders with wrong password -> 401"; else
  fail "in-cluster GET /wc/v3/orders with wrong password -> 401" "got '${got:-no result}'"
fi
got=$(result cod)
if [ "$got" = true ]; then pass "COD enabled (GET /wc/v3/payment_gateways/cod -> enabled: true)"; else
  fail "COD enabled (GET /wc/v3/payment_gateways/cod -> enabled: true)" "enabled='${got:-no result}'"
fi

got=$(curl_auth "$WOO_USER" "$WOO_PASS" -o /dev/null -w '%{http_code}' "$STORE_URL/wp-json/wc/v3/orders?per_page=1" || true)
if [ "$got" = 200 ]; then pass "ingress GET $STORE_URL/wp-json/wc/v3/orders -> 200"; else
  fail "ingress GET $STORE_URL/wp-json/wc/v3/orders -> 200" "got '$got'"
fi

# --- 4. D1: storefront checkout with COD -------------------------------------------------------
d1="D1 storefront COD checkout creates an order visible via admin REST"
d1_check() {
  local store="$STORE_URL/wp-json/wc/store/v1" product_id headers nonce token body order_id order
  product_id=$(curl -sS --max-time 20 "$store/products?search=Demo%20Tee" | jq -r '[.[] | select(.name == "Demo Tee")][0].id // empty')
  [ -n "$product_id" ] || {
    fail "$d1" "product 'Demo Tee' not found via Store API"
    return
  }
  headers=$(curl -sS --max-time 20 -o /dev/null -D - "$store/cart")
  nonce=$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/^[Nn]once: //p' | head -1)
  token=$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's/^[Cc]art-[Tt]oken: //p' | head -1)
  [ -n "$nonce" ] && [ -n "$token" ] || {
    fail "$d1" "GET /cart returned no Nonce/Cart-Token header"
    return
  }
  body=$(curl -sS --max-time 20 -X POST "$store/cart/add-item" -H "Nonce: $nonce" -H "Cart-Token: $token" \
    -H 'Content-Type: application/json' -d "{\"id\": $product_id, \"quantity\": 1}")
  [ "$(printf '%s' "$body" | jq -r '.items_count // 0')" -ge 1 ] || {
    fail "$d1" "add-item failed: $(printf '%s' "$body" | jq -c '{code, message}')"
    return
  }
  local address='{"first_name":"Test","last_name":"Buyer","address_1":"1 Janpath","city":"New Delhi","state":"DL","postcode":"110001","country":"IN","email":"buyer@example.com","phone":"9999999999"}'
  body=$(curl -sS --max-time 30 -X POST "$store/checkout" -H "Nonce: $nonce" -H "Cart-Token: $token" \
    -H 'Content-Type: application/json' \
    -d "{\"billing_address\": $address, \"shipping_address\": $address, \"payment_method\": \"cod\"}")
  order_id=$(printf '%s' "$body" | jq -r '.order_id // empty')
  [ -n "$order_id" ] || {
    fail "$d1" "checkout failed: $(printf '%s' "$body" | jq -c '{code, message}')"
    return
  }
  echo "  checkout: order $order_id, Store API status '$(printf '%s' "$body" | jq -r .status)'"
  order=$(curl_auth "$WOO_USER" "$WOO_PASS" -w '\n%{http_code}' "$STORE_URL/wp-json/wc/v3/orders/$order_id")
  local code=${order##*$'\n'}
  order=${order%$'\n'*}
  if [ "$code" = 200 ] && [ "$(printf '%s' "$order" | jq -r .payment_method)" = cod ]; then
    echo "  admin REST: order $order_id status '$(printf '%s' "$order" | jq -r .status)'," \
      "payment_method cod, total $(printf '%s' "$order" | jq -r '"\(.total) \(.currency)"')"
    pass "$d1"
  else
    fail "$d1" "GET /wc/v3/orders/$order_id -> $code, payment_method '$(printf '%s' "$order" | jq -r '.payment_method // empty')'"
  fi
}
d1_check

# --- 5. No secret in the Job's logs ------------------------------------------------------------
logs_check() {
  local name="bootstrap Job logs contain no secret" logs admin_pass
  if ! logs=$(kc -n "$NAMESPACE" logs "job/$JOB" --all-containers 2>/dev/null); then
    echo "SKIP $name: job/$JOB not found (deleted by its TTL?)"
    return
  fi
  admin_pass=$(secret_value "$ENV_SECRET" WP_ADMIN_PASSWORD 2>/dev/null || true)
  if printf '%s' "$logs" | grep -qF -- "$WOO_PASS"; then
    fail "$name" "Application Password found in logs"
  elif [ -n "$admin_pass" ] && printf '%s' "$logs" | grep -qF -- "$admin_pass"; then
    fail "$name" "admin password found in logs"
  else
    pass "$name"
  fi
}
logs_check

# --- 6. Re-run the hook ------------------------------------------------------------------------
if [ "${SKIP_UPGRADE:-}" = 1 ]; then
  echo "SKIP re-run hook (SKIP_UPGRADE=1)"
else
  say "Re-running the bootstrap hook (helm upgrade)"
  if helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" --kube-context "$KUBE_CONTEXT" \
    -f "$CHART/values-local.yaml" --wait --timeout 15m >/dev/null; then
    pass "re-run: helm upgrade succeeded"
  else
    fail "re-run: helm upgrade succeeded" "helm upgrade failed (see: kubectl -n $NAMESPACE logs job/$JOB --all-containers)"
  fi
  succeeded=$(kc -n "$NAMESPACE" get job "$JOB" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
  if [ "$succeeded" = 1 ]; then pass "re-run: bootstrap Job succeeded"; else
    fail "re-run: bootstrap Job succeeded" "status.succeeded='$succeeded'"
  fi
  new_pass=$(secret_value "$SECRET" WOO_APP_PASSWORD)
  got=$(curl_auth "$WOO_USER" "$new_pass" -o /dev/null -w '%{http_code}' "$STORE_URL/wp-json/wc/v3/orders?per_page=1" || true)
  if [ "$(fingerprint "$new_pass")" = "$pass_fp" ] && [ "$got" = 200 ]; then
    pass "re-run: Application Password unchanged and still authenticates (200)"
  else
    fail "re-run: Application Password unchanged and still authenticates (200)" \
      "changed=$([ "$(fingerprint "$new_pass")" = "$pass_fp" ] && echo no || echo yes), status $got"
  fi
fi

exit "$failed"
