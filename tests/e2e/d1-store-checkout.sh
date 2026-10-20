#!/usr/bin/env bash
# D1: a shopper buys "Demo Tee" through the WooCommerce Store API (cart -> COD checkout) on
# http://store.localtest.me, and the order is visible via the admin REST API (Application Password
# from the bootstrap Secret) with payment_method cod. Places one order per run.
set -uo pipefail
STEP=${STEP:-D1}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

product_id=$(curl -sS --max-time 20 "$STORE_API/products?search=Demo%20Tee" |
  jq -r '[.[] | select(.name == "Demo Tee")][0].id // empty')
[ -n "$product_id" ] || fail "product 'Demo Tee' not found via the Store API"

order_id=$(store_order "$product_id") || fail "Store API COD checkout failed (see $E2E_OUT/$STEP.log)"
note "Store API checkout: order $order_id"

code=$(woo_rest GET "/orders/$order_id")
[ "$code" = 200 ] || fail "admin REST GET /orders/$order_id -> HTTP $code"
method=$(jq -r .payment_method "$LAST")
[ "$method" = cod ] || fail "order $order_id has payment_method '$method', expected cod"
note "admin REST: order $order_id status $(jq -r .status "$LAST"), total $(jq -r '"\(.total) \(.currency)"' "$LAST")"
pass
