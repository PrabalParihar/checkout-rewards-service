#!/usr/bin/env bash
# End-to-end walkthrough against a running server (npm start).
# Uses REWARD_EVERY_N_ORDERS=5 defaults: places 5 orders, generates a coupon,
# races two checkouts for one coupon and two carts for the last limited print.
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:3000}"
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((o,k)=>o?.[k],v);console.log(typeof r==="object"?JSON.stringify(r):r)})' "$1"; }
post() { local body="${2:-}"; [ -n "$body" ] || body='{}'; curl -sS -X POST "$BASE$1" -H 'content-type: application/json' "${@:3}" -d "$body"; }
cart_with() { local id; id=$(curl -sS -X POST "$BASE/carts" | j id); post "/carts/$id/items" "{\"productId\":\"$1\",\"quantity\":${2:-1}}" >/dev/null; echo "$id"; }

echo "== Products";        curl -sS "$BASE/products"; echo
CART=$(cart_with notebook 2)
echo "== Cart $CART";      curl -sS "$BASE/carts/$CART"; echo
echo "== Checkout";        post "/carts/$CART/checkout" '{}' -H 'Idempotency-Key: demo-1' -i | grep -Ei '^HTTP|idempotent-replayed'
echo "== Same key again (replay, no new order)"
post "/carts/$CART/checkout" '{}' -H 'Idempotency-Key: demo-1' -i | grep -Ei '^HTTP|idempotent-replayed'
echo "== Different key, same cart"; post "/carts/$CART/checkout" '{}' -H 'Idempotency-Key: demo-2'; echo

echo "== Coupon before milestone"; post /admin/coupons; echo
for i in 2 3 4 5; do post "/carts/$(cart_with pen 1)/checkout" '{}' -H "Idempotency-Key: demo-fill-$i" >/dev/null; done
COUPON=$(post /admin/coupons | j code); echo "== Generated coupon $COUPON after 5 orders"

echo "== Two concurrent checkouts with the same coupon"
A=$(cart_with mug 1); B=$(cart_with mug 1)
post "/carts/$A/checkout" "{\"couponCode\":\"$COUPON\"}" -H 'Idempotency-Key: race-a' -o /tmp/demo-a.json -w 'A -> %{http_code}\n' &
post "/carts/$B/checkout" "{\"couponCode\":\"$COUPON\"}" -H 'Idempotency-Key: race-b' -o /tmp/demo-b.json -w 'B -> %{http_code}\n' &
wait; cat /tmp/demo-a.json; echo; cat /tmp/demo-b.json; echo

echo "== Two carts racing for the single limited print"
C=$(cart_with limited-print 1); D=$(cart_with limited-print 1)
post "/carts/$C/checkout" '{}' -H 'Idempotency-Key: print-c' -o /dev/null -w 'C -> %{http_code}\n' &
post "/carts/$D/checkout" '{}' -H 'Idempotency-Key: print-d' -o /dev/null -w 'D -> %{http_code}\n' &
wait

echo "== Report"; curl -sS "$BASE/admin/report"; echo
