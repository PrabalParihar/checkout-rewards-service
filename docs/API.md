# API reference

Base URL: `http://127.0.0.1:3000`. All bodies are JSON. All money is **integer cents** (USD).

## Error envelope

Every non-2xx response has the same shape:

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Not enough stock for one or more items", "details": { "items": [{ "productId": "limited-print", "requested": 1, "available": 0 }] } } }
```

Clients should branch on `code`; `message` is for humans; `details` is code-specific.

| Status | Codes | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` | Malformed request; fix it before retrying |
| 402 | `PAYMENT_DECLINED` | Payment refused; cart reopened, stock and coupon released |
| 404 | `CART_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ITEM_NOT_IN_CART`, `ORDER_NOT_FOUND`, `ROUTE_NOT_FOUND` | Resource does not exist |
| 409 | `CART_EMPTY`, `CART_LIMIT_EXCEEDED`, `CART_CHECKOUT_IN_PROGRESS`, `CART_ALREADY_CHECKED_OUT`, `INSUFFICIENT_STOCK`, `QUOTE_CHANGED`, `COUPON_IN_USE`, `COUPON_ALREADY_REDEEMED`, `NO_ELIGIBLE_MILESTONE` | Valid request that conflicts with current state |
| 422 | `COUPON_INVALID`, `IDEMPOTENCY_KEY_REUSED` | Understood but unusable |
| 502 | `PAYMENT_FAILED` | Provider error, and the provider confirmed nothing was charged; everything released |
| 503 | `PAYMENT_PENDING` | Payment outcome not confirmed yet; stock and coupon stay held. Response has `Retry-After`. Retry with the **same** key |

## Shopper endpoints

### `GET /products`
200 → `[{ id, name, unitPriceCents, stock }]`. `stock` is units sellable right now (in-flight checkouts already subtracted).

### `POST /carts`
No body. 201 → cart view, `Location: /carts/{id}`.

### `GET /carts/{cartId}`
200 → cart view:

```json
{
  "id": "…", "status": "open", "orderId": null,
  "lines": [{ "productId": "notebook", "productName": "Dot-Grid Notebook", "quantity": 2,
              "unitPriceCents": 1299, "lineTotalCents": 2598,
              "priceChanged": false, "priceWhenAddedCents": 1299, "availableStock": 100 }],
  "subtotalCents": 2598,
  "issues": [],
  "createdAt": "…", "updatedAt": "…"
}
```

`status` is `open` | `checking_out` | `checked_out`. Open carts are priced live; `priceChanged` and `issues` warn about catalog changes since adding. A checked-out cart shows its order's snapshot. 404 `CART_NOT_FOUND`.

### `POST /carts/{cartId}/items`
Body `{ "productId": "pen", "quantity": 2 }` (integer 1–1000). Adds to an existing line if present. 200 → cart view.
Errors: 400 `VALIDATION_ERROR`, 404 `PRODUCT_NOT_FOUND`, 409 `INSUFFICIENT_STOCK` (resulting quantity exceeds current stock), `CART_LIMIT_EXCEEDED` (more than 50 products), `CART_CHECKOUT_IN_PROGRESS`, `CART_ALREADY_CHECKED_OUT`.

### `PUT /carts/{cartId}/items/{productId}`
Body `{ "quantity": 3 }` sets the absolute quantity. 200 → cart view. Errors as above, plus 404 `ITEM_NOT_IN_CART`.

### `DELETE /carts/{cartId}/items/{productId}`
200 → cart view. 404 `ITEM_NOT_IN_CART`; 409 when the cart is not open.

### `POST /carts/{cartId}/checkout`
Headers: **`Idempotency-Key: <1–128 chars of A-Z a-z 0-9 _ - : .>`** (required).
Body (optional fields):

```json
{ "couponCode": "SAVE10-1A2B3C4D5E", "expectedTotalCents": 1170 }
```

- `couponCode` — case-insensitive.
- `expectedTotalCents` — the total the client showed the customer. If the server computes a different total, the checkout fails with 409 `QUOTE_CHANGED` (details include `actualTotalCents`) and nothing is reserved.

Responses:

| Status | When |
| --- | --- |
| 201 | Order placed. `Idempotent-Replayed: false`, `Location: /orders/{id}` |
| 200 | Same key + same request seen before (or still in flight): the **same** order is returned. `Idempotent-Replayed: true` |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `VALIDATION_ERROR` |
| 402 | `PAYMENT_DECLINED` |
| 404 | `CART_NOT_FOUND` |
| 409 | `CART_EMPTY`, `INSUFFICIENT_STOCK` (details list every short line), `QUOTE_CHANGED`, `COUPON_IN_USE`, `COUPON_ALREADY_REDEEMED`, `CART_CHECKOUT_IN_PROGRESS` (different key while another attempt is paying), `CART_ALREADY_CHECKED_OUT` (different key after success; details contain `orderId`) |
| 422 | `COUPON_INVALID`, `IDEMPOTENCY_KEY_REUSED` (same key, different cart/coupon/expected total) |
| 502 | `PAYMENT_FAILED` (provider confirmed no charge) |
| 503 | `PAYMENT_PENDING` + `Retry-After: 5`: outcome unknown, everything held; retry with the same key, which looks the charge up and never charges twice |

A failed checkout does **not** consume the key: the client may fix the problem and retry with the same key. A completed checkout can be replayed for `IDEMPOTENCY_TTL_HOURS` (default 24). After that, the cart itself still prevents a second order (`CART_ALREADY_CHECKED_OUT` with the `orderId`).

Order body:

```json
{
  "id": "…", "sequence": 6, "cartId": "…",
  "lines": [{ "productId": "mug", "productName": "Ceramic Mug", "unitPriceCents": 1850, "quantity": 1, "lineTotalCents": 1850 }],
  "subtotalCents": 1850,
  "discount": { "couponCode": "SAVE10-CA3475DDCA", "percent": 10, "amountCents": 185 },
  "totalCents": 1665,
  "paymentId": "pay_…",
  "placedAt": "2026-10-19T11:52:04.153Z"
}
```

`sequence` is the order's position among successfully placed orders (drives coupon milestones). `paymentId` is `null` when the total is 0.

### `GET /orders/{orderId}`
200 → order. 404 `ORDER_NOT_FOUND`.

## Admin endpoints (`/admin/*`)

Not authenticated in this exercise; in production these sit behind admin auth.

### `POST /admin/coupons`
No body. Issues one coupon for the oldest reached milestone that has none.
201 → `{ code, milestone, percent, status: "available", createdAt, redeemedByOrderId: null, redeemedAt: null }`.
409 `NO_ELIGIBLE_MILESTONE` with `details: { placedOrders, unrewardedMilestones: [], nextMilestone }`.

### `GET /admin/coupons`
200 → all coupons with `status` `available` | `reserved` | `redeemed`.

### `GET /admin/report`
Read-only. 200 →

```json
{
  "totalOrders": 7,
  "purchasedByProduct": [{ "productId": "mug", "productName": "Ceramic Mug", "quantity": 1, "grossCents": 1850 }],
  "grossRevenueCents": 18444,
  "totalDiscountCents": 185,
  "netRevenueCents": 18259,
  "coupons": { "generated": 1, "available": 0, "reserved": 0, "redeemed": 1, "codes": [ … ] },
  "rewards": { "everyNOrders": 5, "discountPercent": 10, "unrewardedMilestones": [], "nextMilestone": 10 }
}
```

`netRevenueCents == grossRevenueCents - totalDiscountCents == Σ order.totalCents`.

### `GET /admin/orders`
200 → all placed orders in placement order.

### `PATCH /admin/products/{productId}`
Body: any of `{ "unitPriceCents": 1500, "stock": 2, "name": "…" }`. Sets absolute values. Used to demonstrate price/stock changes between add-to-cart and checkout. 200 → product.

## Executable example

`scripts/demo.sh` (with the server running) covers replay, a coupon raced by two checkouts, two carts racing for the last unit and the final report.
