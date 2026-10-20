#!/usr/bin/env bash
# D2 (User A, dashboard session, real Claude API):
#   1. chat: create product "E2E Mug <run>" priced 299 -> toolCalls has woo__create_product ok, and
#      the product is listed by the Store API
#   2. a shopper places a COD order for it through the Store API
#   3. chat: "What orders came in today?" -> toolCalls has woo__list_orders and the reply contains
#      the new order id
# Cleanup: the product is deleted through the admin REST API at the end (the order is kept).
set -uo pipefail
STEP=${STEP:-D2}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

name="E2E Mug $RUN_ID"
product_id=""
cleanup() {
  [ -n "$product_id" ] && woo_rest DELETE "/products/$product_id?force=true" >/dev/null
}
trap cleanup EXIT

# 1. Create the product through chat.
code=$(chat "$A_JAR" "Create a product named '$name' priced 299. Use the tools. Reply with only the product id.")
[ "$code" = 200 ] || fail "chat (create product) -> HTTP $code: $(err_of)"
expect_chat_calls A
note "chat reply: $(jq -r .reply "$LAST" | head -c 200)"
note "toolCalls: $(jq -c '[.toolCalls[] | "\(.name):\(.outcome)"]' "$LAST")"
jq -e '[.toolCalls[] | select(.name == "woo__create_product" and .outcome == "ok")] | length > 0' \
  "$LAST" >/dev/null || fail "no successful woo__create_product in toolCalls: $(jq -c '[.toolCalls[] | "\(.name):\(.outcome)"]' "$LAST")"

listed() {
  curl -sS --max-time 20 -G "$STORE_API/products" --data-urlencode "search=$name" |
    jq -c --arg n "$name" '[.[] | select(.name == $n)][0] // empty'
}
product=$(listed)
[ -n "$product" ] || fail "product '$name' not listed by the Store API"
product_id=$(printf '%s' "$product" | jq -r .id)
price=$(printf '%s' "$product" | jq -r '(.prices.price | tonumber) / pow(10; .prices.currency_minor_unit)')
[ "$price" = 299 ] || fail "product '$name' has price $price, expected 299"
note "product $product_id listed, price $price"

# 2. A shopper orders it.
order_id=$(store_order "$product_id") || fail "Store API COD checkout of '$name' failed"
note "Store API checkout: order $order_id"

# 3. "Orders today" through chat.
code=$(chat "$A_JAR" "What orders came in today? Use the tools. Reply with only the order ids, comma-separated.")
[ "$code" = 200 ] || fail "chat (orders today) -> HTTP $code: $(err_of)"
expect_chat_calls A
reply=$(jq -r .reply "$LAST")
note "chat reply: $(printf '%s' "$reply" | head -c 300)"
jq -e '[.toolCalls[] | select(.name == "woo__list_orders")] | length > 0' "$LAST" >/dev/null ||
  fail "no woo__list_orders in toolCalls: $(jq -c '[.toolCalls[].name]' "$LAST")"
printf '%s' "$reply" | grep -Eq "(^|[^0-9])$order_id([^0-9]|$)" ||
  fail "reply does not contain order $order_id: $(printf '%s' "$reply" | head -c 120)"
pass
