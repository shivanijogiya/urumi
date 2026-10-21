#!/usr/bin/env bash
# Seeds today's orders in the store for the canary (#28; scripts/canary/ci.sh step 4). verdict.py
# probes `woo__list_orders {"date": "today"}`; on an empty store that is a ~250-byte empty page, so
# a regression that only shows on a real page (size, content) would pass the canary. This places
# N shopper orders (Store API cart + Cash on delivery checkout, like tests/e2e D1) with 1-3 units
# of a published product, so the probe reads a realistic page (20 orders with line items, ~6-9 KB).
# Orders are dated now: a run that crosses midnight in Asia/Kolkata (18:30 UTC) sees fewer.
#   scripts/canary/seed-orders.sh [N]     default 24; prints `seeded N orders`
#   STORE_URL  default http://store.localtest.me
set -euo pipefail
N=${1:-24}
STORE_URL=${STORE_URL:-http://store.localtest.me}
API="$STORE_URL/wp-json/wc/store/v1"
printf '%s' "$N" | grep -Eq '^[1-9][0-9]?$' || {
  echo "seed-orders: N must be 1-99" >&2
  exit 1
}

product=$(curl -sS --max-time 20 "$API/products?per_page=1" | jq -r '.[0].id // empty')
[ -n "$product" ] || {
  echo "seed-orders: no published product in the store" >&2
  exit 1
}

names=(Aarav:Sharma Diya:Iyer Kabir:Patel Ishaan:Reddy Meera:Nair Rohan:Gupta Ananya:Rao Vihaan:Das)
for i in $(seq 1 "$N"); do
  name=${names[$((i % ${#names[@]}))]}
  address=$(jq -nc --arg f "${name%%:*}" --arg l "${name##*:}" --arg e "canary-$i@example.com" \
    '{first_name: $f, last_name: $l, address_1: "1 Janpath", city: "New Delhi", state: "DL",
      postcode: "110001", country: "IN", email: $e, phone: "9999999999"}')
  headers=$(curl -sS --max-time 20 -o /dev/null -D - "$API/cart" | tr -d '\r')
  nonce=$(printf '%s\n' "$headers" | sed -n 's/^[Nn]once: //p' | head -1)
  token=$(printf '%s\n' "$headers" | sed -n 's/^[Cc]art-[Tt]oken: //p' | head -1)
  [ -n "$nonce" ] && [ -n "$token" ] || {
    echo "seed-orders: GET /cart returned no Nonce/Cart-Token (order $i)" >&2
    exit 1
  }
  curl -sS --max-time 20 -o /dev/null -X POST "$API/cart/add-item" -H "Nonce: $nonce" \
    -H "Cart-Token: $token" -H 'Content-Type: application/json' \
    -d "{\"id\": $product, \"quantity\": $((1 + i % 3))}"
  order=$(jq -nc --argjson a "$address" '{billing_address: $a, shipping_address: $a, payment_method: "cod"}' |
    curl -sS --max-time 30 -X POST "$API/checkout" -H "Nonce: $nonce" -H "Cart-Token: $token" \
      -H 'Content-Type: application/json' -d @- | jq -r '.order_id // empty')
  [ -n "$order" ] || {
    echo "seed-orders: checkout $i placed no order" >&2
    exit 1
  }
done
echo "seeded $N orders"
