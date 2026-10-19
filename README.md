# Checkout & Rewards Service

A backend for an ecommerce store. It covers carts, idempotent checkout, inventory that cannot be oversold, and "every *n*th order unlocks an *x*% coupon" rewards. It is built for the [backend assignment](https://github.com/neustackapp/assignment/tree/main/be).

The interesting part is behaviour under **retries and concurrency**. Checkout reserves stock and the coupon atomically, awaits a (fake, latency-bearing) payment and then commits or releases. See [DECISIONS.md](DECISIONS.md).

**Stack:** TypeScript, Node.js ≥ 20, Fastify, zod. Tests use `node:test` via `tsx`. Storage is in memory.

## Run

```bash
npm install
npm test          # 49 tests: unit, concurrency and HTTP-level races
npm start         # http://127.0.0.1:3000
```

In a second terminal, with the server running:

```bash
npm run demo      # replay, coupon race, last-unit race, report
```

### Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `REWARD_EVERY_N_ORDERS` | `5` | *n*: every n-th successful order unlocks one coupon |
| `DISCOUNT_PERCENT` | `10` | *x*: coupon discount, integer 1–100 |
| `PAYMENT_LATENCY_MS` | `50` | Fake payment delay; makes concurrent checkouts really overlap |
| `IDEMPOTENCY_TTL_HOURS` | `24` | How long a checkout can be replayed by its `Idempotency-Key` |
| `MAINTENANCE_INTERVAL_MS` | `30000` | How often unconfirmed payments are settled and expired keys pruned |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address |

```bash
REWARD_EVERY_N_ORDERS=2 DISCOUNT_PERCENT=15 npm start
```

### Seed data

Each start loads a fresh catalog (`src/seed.ts`):

| id | Name | Price | Stock |
| --- | --- | ---: | ---: |
| `notebook` | Dot-Grid Notebook | $12.99 | 100 |
| `pen` | Gel Pen (3-pack) | $4.99 | 250 |
| `mug` | Ceramic Mug | $18.50 | 40 |
| `desk-lamp` | LED Desk Lamp | $49.99 | 3 |
| `limited-print` | Signed Limited Print | $120.00 | **1** |

## API at a glance

Full request/response/error reference: **[docs/API.md](docs/API.md)**.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/products` | Catalog with current stock |
| POST | `/carts` | Create cart |
| GET | `/carts/:cartId` | View cart (live prices, totals, warnings) |
| POST | `/carts/:cartId/items` | Add `{productId, quantity}` |
| PUT | `/carts/:cartId/items/:productId` | Set `{quantity}` |
| DELETE | `/carts/:cartId/items/:productId` | Remove item |
| POST | `/carts/:cartId/checkout` | Checkout; **`Idempotency-Key` header required**; optional `{couponCode, expectedTotalCents}` |
| GET | `/orders/:orderId` | Order snapshot |
| POST | `/admin/coupons` | *Admin.* Generate coupon for an eligible milestone |
| GET | `/admin/coupons` | *Admin.* List coupons |
| GET | `/admin/report` | *Admin.* Quantities, gross/discount/net revenue, coupon counts, order count |
| GET | `/admin/orders` | *Admin.* All orders |
| PATCH | `/admin/products/:productId` | *Admin.* Change price/stock (to exercise change semantics) |

There is no authentication in this exercise. Everything under `/admin` is treated as administrative.

```bash
CART=$(curl -s -X POST localhost:3000/carts | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST localhost:3000/carts/$CART/items -H 'content-type: application/json' -d '{"productId":"mug","quantity":2}'
curl -s -X POST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: order-1'          # 201
curl -s -X POST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: order-1' -i | head -1  # 200, same order
curl -s localhost:3000/admin/report
```

## Behaviour under retries and concurrency

- **Retry with the same key:** the same order comes back (200, `Idempotent-Replayed: true`). If the first attempt is still in flight, the retry waits for it and gets its result. Only one payment is attempted.
- **Two carts racing for the last unit:** exactly one 201. The others get 409 `INSUFFICIENT_STOCK`.
- **Two checkouts using one coupon at once:** one gets the discount. The other gets 409 `COUPON_IN_USE`.
- **Payment declined:** stock, coupon and cart are all released, and the key can be retried.
- **Payment provider times out:** the service asks the provider what happened instead of guessing. If it charged, the order is placed. If it never received the charge, everything is released. If it can't answer yet, everything stays held and the client gets 503 `PAYMENT_PENDING`; a retry with the same key (or the background pass) settles it. Nothing is ever charged twice.
- **Concurrent coupon generation:** at most one coupon per milestone.

## Project layout

```
src/
  money.ts      integer-cent arithmetic and rounding
  limits.ts     input bounds that keep arithmetic exact
  errors.ts     error codes -> HTTP status
  types.ts      domain model and state machines
  store.ts      in-memory state + the concurrency model explained
  catalog.ts    products
  carts.ts      cart editing and live-priced views
  checkout.ts   reserve -> charge -> commit/release, idempotency
  coupons.ts    milestone coupon generation and redeemability
  report.ts     read-only admin summary
  payment.ts    PaymentGateway interface + fake
  shop.ts       composition root
  app.ts        HTTP routes, validation, error envelope
  server.ts     process entry point
test/           unit, concurrency and HTTP tests (start with checkout.test.ts)
docs/API.md     endpoint reference
scripts/demo.sh executable walkthrough
```

## Scope

As the brief allows, state is in memory and the service runs as one process. [DECISIONS.md §7](DECISIONS.md#7-evolving-to-multiple-instances-and-production-scale) maps every invariant onto a database-backed, multi-instance design, and [§6](DECISIONS.md#6-scope-implemented-and-intentionally-out-of-scope) lists what is in and out of scope.
