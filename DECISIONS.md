# Decisions

This service is a single-process, in-memory checkout and rewards backend. The interesting part is not the CRUD. It is keeping orders, inventory, coupons and the report consistent when requests are retried or overlap. Most decisions below follow from one choice, **reserve → charge → commit/release** (Decision 1).

## 1. Invariants and where they are enforced

| # | Invariant | Enforced in |
| --- | --- | --- |
| I1 | Stock never goes below zero; the system never sells more than it has | `CheckoutService.reserve`: all lines are checked before any deduction, and the deduction happens in the same synchronous block |
| I2 | A cart produces at most one order | `Cart.status`: `open → checking_out → checked_out`, checked in `reserve` and `CartService.findEditable` |
| I3 | Retrying a checkout never creates a second order or deducts stock twice | Idempotency record per key in `CheckoutService.checkout`: replay if completed, join if in flight |
| I4 | A coupon is redeemed at most once, never by two overlapping checkouts | Coupon `available → reserved → redeemed`; `CouponService.findRedeemable` rejects `reserved`/`redeemed` |
| I5 | A failed checkout loses nothing: stock, coupon, cart and idempotency key are all restored | `CheckoutService.release` on decline or provider error; validation failures throw before mutating anything |
| I6 | Each milestone (k·n successful orders) yields at most one coupon | `CouponService.generate` picks the oldest unrewarded milestone synchronously |
| I7 | An order explains itself forever: names, unit prices, quantities, discount and totals are snapshotted | `OrderLine`/`OrderDiscount` copied at reserve time; `catalog.update` never touches orders |
| I8 | Money is exact; `0 ≤ discount ≤ subtotal`, so `total ≥ 0` | `money.ts` (`percentOf` clamps), input bounds in `limits.ts` |
| I9 | The report reconciles with orders and coupons and never mutates state | `ReportService.build` derives everything from `orders`/`coupons` on each call |

Each invariant has at least one test that fails if the invariant is broken. To check this, I removed the coupon reservation, moved the stock deduction to commit time, and disabled in-flight joining. Each mutation failed 2–3 tests.

## 2. Ambiguities and the semantics I chose

| Question | Choice |
| --- | --- |
| "Every nth order": per customer or store-wide? | Store-wide. There are no customer accounts in scope. |
| Which orders count? | Only **successfully placed** orders. In-flight, declined and failed checkouts do not count. Orders that used a coupon do count. |
| Is the coupon issued automatically? | No. The brief says an admin requests generation. Reaching a milestone makes a coupon *eligible*. `POST /admin/coupons` issues it. |
| Admin missed several milestones? | Each call issues one coupon for the oldest unrewarded milestone, so the backlog can be caught up. It is never more than one per milestone. |
| Who may use a coupon? | Bearer code: whoever has it, once. Ownership needs customer identity, which is deferred. |
| Coupon expiry, stacking, minimum spend | No expiry. At most one coupon per order. No minimum. |
| Discount base | Percentage of the order subtotal, rounded down to the cent. |
| Price changes between add-to-cart and checkout | The order is charged at the price **at checkout**. The cart view flags `priceChanged`. Clients can send `expectedTotalCents` to fail with `QUOTE_CHANGED` instead of being charged a different amount. |
| Stock changes between add-to-cart and checkout | Adding to a cart reserves nothing. Checkout re-validates every line and fails all-or-nothing with `INSUFFICIENT_STOCK`, listing each short line. The cart view lists `issues` early. |
| Changing `n` or `x` at runtime | Not supported. They are configured at startup (`REWARD_EVERY_N_ORDERS`, `DISCOUNT_PERCENT`). |
| Zero-total orders (100% coupon) | Allowed. No payment call is made, and `paymentId` is `null`. |

## 3. Material decisions

## Decision: Reserve → charge → commit/release, using synchronous critical sections

**Context:** Checkout must not oversell, must not double-redeem a coupon and must not lose anything when it fails. All of that has to hold while other requests run. With a real payment step, checkout is necessarily asynchronous, so other requests *will* interleave with it.

**Options considered:**
- A. Treat checkout as instant (no async step). Everything is trivially atomic in Node, but this does not show how overlap is handled, and it breaks the moment a real payment call is added.
- B. A global async mutex around checkout. It is correct, but it serialises every checkout, including the slow payment wait, and needs care with timeouts.
- C. Clone the whole state, mutate the copy, swap it in. It is atomic, but costs O(state) per request and still cannot include an async payment.
- D. **Reservations:** validate and reserve in one synchronous block, `await` the payment, then commit or release in a second synchronous block.

**Choice:** D. `CheckoutService.reserve` checks the cart, stock and coupon, then deducts stock, marks the coupon `reserved` and the cart `checking_out`, all without an `await`. Node runs that block to completion, so it is atomic with respect to other requests. The payment `await` comes next, and other requests run during it. They already see the reduced stock and the reserved coupon. `commit` and `release` are again synchronous.

**Why:** This is the same shape a database implementation would have: conditional updates in a transaction, an external call outside the transaction, then a finalising transaction. So the design maps directly to production (section 9). Checkouts for different products do not block each other. The payment fake has real latency (50 ms by default), so tests and the demo exercise genuine interleaving.

**Consequences:** Correctness depends on the reserve and commit blocks staying free of `await`. That rule is documented in `store.ts` and `checkout.ts` and must survive refactors. During payment, a competing checkout sees the stock as gone and gets `INSUFFICIENT_STOCK`, even if the first payment later fails. I accept this. The alternative is waiting, which would make the outcome depend on timing. If the process crashes mid-payment, reservations vanish together with the in-memory state. A persistent version needs reservation expiry.

## Decision: Required Idempotency-Key that replays successes, joins in-flight attempts and forgets failures

**Context:** Clients retry after timeouts. A retry must return the original result. It must not create a second order or charge stock twice, even when the retry arrives while the first attempt is still paying.

**Options considered:**
- A. Deduplicate by cart only (cart already checked out → error). This is safe, but the retrying client gets an error instead of its order.
- B. Optional key. Clients that forget it get unsafe retries.
- C. Cache every response, including errors (Stripe-style). This is predictable, but a temporary failure such as `INSUFFICIENT_STOCK` "poisons" the key.
- D. **Required key. Store a fingerprint of the request. Completed → replay the order. In flight → await the same promise. Failed → delete the record.**

**Choice:** D, plus A as a second, independent guard. A *different* key on a checked-out cart gets `CART_ALREADY_CHECKED_OUT` with the `orderId`. A different key on a cart that is mid-checkout gets `CART_CHECKOUT_IN_PROGRESS`. Reusing a key with a different cart, coupon or expected total gets `IDEMPOTENCY_KEY_REUSED` (422). Replays return 200 with `Idempotent-Replayed: true`. The first success returns 201.

**Why:** Joining the in-flight promise means N simultaneous retries cause exactly one payment call, and every caller receives the same order (tested with 5 concurrent HTTP requests). Forgetting failures lets the client fix the cause, for example remove an item or use another coupon, and retry with the same key.

**Consequences:** Keys are global and kept for the process lifetime. With authentication, keys would be scoped per customer and expire (for example after 24 h). Because the cart status also blocks double checkout, losing the idempotency map could cause errors on retry but never a duplicate order.

## Decision: Charge live prices at checkout, with an optional client-side guard

**Context:** Prices can change after an item is added to a cart.

**Options considered:**
- A. Lock the price when the item is added. Carts become stale price promises with no expiry, and admins cannot correct a mistaken price.
- B. Silently charge the new price.
- C. **Charge the live price, make the change visible, and let the client require the price it showed.**

**Choice:** C. The cart view shows the live price, `priceWhenAddedCents` and `priceChanged`. Checkout always uses the live price and snapshots it into the order. If the request includes `expectedTotalCents` and it differs from the server's total, checkout fails with `QUOTE_CHANGED` before reserving anything.

**Why:** The server stays the single source of truth. A well-behaved client can guarantee the customer is never charged an amount they did not see. Simple clients still work.

**Consequences:** A client that omits `expectedTotalCents` can be charged a different amount than it displayed. That is documented and tested.

## Decision: Validate stock when items are added, but reserve stock only during checkout

**Context:** "Invalid quantities must not silently enter a cart" and "never oversell" pull in different directions if carts hold stock.

**Options considered:** A. Reserve stock in carts with a TTL. B. **Reserve nothing in carts; validate at add time for fast feedback; re-validate at checkout.**

**Choice:** B. Add/update rejects a quantity above current stock, and above 1000 or below 1. Checkout re-validates every line atomically.

**Why:** Cart reservations need expiry jobs, and abandoned carts would block real buyers. The add-time check prevents obviously invalid carts. The checkout check is the one that protects I1.

**Consequences:** A cart that was valid when built can fail at checkout. It then gets an itemised `INSUFFICIENT_STOCK`, and `GET /carts/:id` shows `issues` before checkout.

## Decision: Coupon lifecycle `available → reserved → redeemed` and global milestones

**Context:** A coupon must be single-use. It must not be lost by a failed checkout and must not be redeemed by two concurrent checkouts.

**Options considered:**
- A. Mark the coupon redeemed when checkout starts. A failed payment would burn it.
- B. Mark it redeemed only at commit. Two concurrent checkouts could both pass validation.
- C. **A `reserved` state held by the in-flight checkout, then committed or released.**

**Choice:** C. A second checkout presenting a reserved coupon gets `COUPON_IN_USE` (409). That is a different code from `COUPON_ALREADY_REDEEMED`, so a client can tell "try again shortly" apart from "this is spent". Generation is admin-triggered and issues one coupon per milestone, oldest first. Milestones count successful orders only.

**Why:** This is the coupon version of the stock reservation. It gives the same atomicity argument and the same release path.

**Consequences:** A coupon is briefly unusable while its holder is paying. Coupon ownership and expiry are deferred.

## Decision: Integer cents, bounded inputs, discounts rounded down

**Context:** "Calculate money without floating-point rounding errors."

**Options considered:** A. Floats with rounding at the end. B. A decimal library. C. BigInt. D. **Integer cents in `number`, with input bounds that keep every intermediate value below 2^53.**

**Choice:** D. `limits.ts` caps unit price ($100,000), quantity (1000) and cart lines (50). The largest possible subtotal × 100 is 5×10^13, far below 2^53 ≈ 9×10^15. `percentOf` computes `(a·p − (a·p mod 100)) / 100`, so even the division is exact. It never relies on `Math.floor` of a float. Discounts round **down**, so the customer never gets more than x%, and are clamped to the subtotal.

**Why:** It is exact, fast and JSON-friendly, and the bounds are a business-reasonable validation anyway. BigInt would spread through the JSON layer for no practical gain at these magnitudes.

**Consequences:** Single currency (USD). Rounding down means a 10% coupon on $0.09 gives $0.00 off, which is deterministic and documented. Multi-currency needs per-currency minor units.

## Decision: A fake payment gateway behind an interface

**Context:** No real payment is required, but whether an async payment step exists changes the concurrency story completely (Decision 1).

**Options considered:** A. Treat checkout as payment success. B. **A `PaymentGateway` interface with a fake that succeeds after configurable latency.**

**Choice:** B. `charge()` can resolve `succeeded`, resolve `declined` (→ 402 `PAYMENT_DECLINED`) or throw (→ 502 `PAYMENT_FAILED`). Every failure releases the reservation. Tests use a `ManualPaymentGateway` that holds each charge until the test settles it. This makes "request B arrives while A is paying" deterministic rather than dependent on timing. The idempotency key is passed through to the provider.

**Why:** It keeps the realistic shape of the system at very low cost.

**Consequences:** One known weakness: when the provider *throws*, the outcome is unknown, because the charge may actually have gone through. I release immediately. That is fine for a fake, but wrong for a real provider. See section 9.

## Decision: Error model, a stable `code` with a status class

**Context:** "Return errors that are distinguishable and useful to an API client."

**Choice:** One `AppError(code, message, details)` type. Each code maps to one status in a single table (`errors.ts`). 400 means fix your request. 404 means no such resource. 409 means valid but conflicts with current state. 422 means understood but unusable (bad coupon, reused key). 402/502 are payment outcomes. `details` carries actionable data, such as the short lines for `INSUFFICIENT_STOCK`, the `orderId` for `CART_ALREADY_CHECKED_OUT`, `nextMilestone` for `NO_ELIGIBLE_MILESTONE` and `actualTotalCents` for `QUOTE_CHANGED`. Anything that is not an `AppError` is a bug and becomes a generic 500.

**Alternative considered:** RFC 7807 `application/problem+json`. It is a reasonable choice. I kept a smaller envelope, and the codes would map one-to-one onto problem `type`s.

## Decision: Report computed on read

**Options considered:** A. Maintain running counters on every commit. B. **Derive the report from orders and coupons on each request.**

**Choice:** B. It cannot drift from the data it summarises and is obviously read-only. Repeated calls are tested to be identical and to issue no coupons. The cost is O(orders) per call, acceptable in memory. In production it would be SQL aggregates or a projection (section 9).

## 4. Transaction, concurrency and idempotency strategy (summary)

```
request ──► idempotency lookup (sync)
              ├─ completed  → 200 replay
              ├─ in flight  → await same promise → 200 replay
              └─ new
                   reserve (sync, all-or-nothing)
                     check cart open & non-empty, stock for every line, coupon available, expected total
                     then: stock -= qty, coupon=reserved, cart=checking_out, record key=in_progress
                   await payment.charge()          ◄── other requests interleave here
                   commit (sync): order(sequence = placed+1), coupon=redeemed, cart=checked_out, key=completed
                or release (sync): stock += qty, coupon=available, cart=open, key deleted
```

Coupon generation and every cart edit are single synchronous blocks. The tests that exercise competing or repeated operations:

- `checkout.test.ts`: last-unit race; 20 concurrent checkouts for 10 units (exactly 10 sold, sequences 1–10); in-flight retry joins with a single charge; a different key during and after checkout.
- `coupons.test.ts`: two checkouts racing for one coupon; coupon not consumed by a validation failure or a declined payment.
- `api.test.ts`: the same scenarios over real HTTP with real payment latency: 5 concurrent identical retries → one order; 5 carts for 1 unit → one 201 and four 409s; concurrent coupon generation → one coupon per milestone; report equals Σ order totals.

## 5. Money and rounding rules

- All amounts are integer cents (`Cents = number`), validated with `Number.isSafeInteger`.
- `lineTotal = unitPrice × quantity`, `subtotal = Σ lineTotal`, `discount = floor(subtotal × percent / 100)` computed exactly with integers, `total = subtotal − discount`.
- Discount is clamped to `[0, subtotal]`, so `total ≥ 0`.
- The order stores every component, so `total` can be recomputed and explained from the order alone.

## 6. Implemented vs intentionally deferred

**Implemented:** all required endpoints; product price/stock admin updates (to demonstrate change semantics); idempotent checkout; fake payment with decline and error paths; coupon lifecycle; reconciling report; 44 tests including concurrent HTTP tests; demo script; API docs.

**Deferred (deliberately):**
- Authentication and authorization. `/admin/*` is administrative by convention only, and idempotency keys are global rather than per customer.
- Persistence and recovery. A restart loses everything.
- Expiry of idempotency records and coupons. Memory grows with the number of keys.
- Reservation timeouts. Not needed in-process, because reservations end when the payment promise settles. A persistent design needs them.
- Payment reconciliation for unknown outcomes.
- Customer-owned coupons, multiple currencies, taxes and shipping.
- A frontend. The brief makes it optional, and `scripts/demo.sh` plus `docs/API.md` cover evaluation.

## 7. Evolving to multiple instances and production scale

In-memory state and "synchronous block = critical section" only work in **one process**. Two instances would each hold separate stock. The same invariants move into the database:

| Concern | Production design (PostgreSQL) |
| --- | --- |
| Stock reservation (I1) | `UPDATE products SET stock = stock - $q WHERE id = $id AND stock >= $q` per line inside one transaction; any 0-row update → rollback → `INSUFFICIENT_STOCK`. No read-then-write race. |
| Coupon reservation (I4) | `UPDATE coupons SET status='reserved', attempt_id=$a WHERE code=$c AND status='available'`; 0 rows → in use or redeemed. |
| Idempotency (I3) | `idempotency_keys(customer_id, key)` unique; `INSERT … status='in_progress'` in the reserve transaction. A conflict on insert means replay (completed) or `409 in progress` / poll (in flight, since another instance holds it). Store the response for replay; expire after 24 h. |
| One order per cart (I2) | Unique `orders.cart_id`; cart status transition guarded by `WHERE status='open'`. |
| Milestones (I6) | Order `sequence` from a DB sequence assigned at commit; `UNIQUE(coupons.milestone)` so concurrent admin calls cannot double-issue. |
| Payment | Never inside a DB transaction: reserve tx → charge → commit tx. Persist the attempt first. On an unknown outcome (timeout), mark `payment_unknown` and **query the provider by idempotency key** before releasing. A sweeper releases reservations whose attempts are stale (crashed instance). |
| Reporting (I9) | SQL aggregates over `orders`/`order_lines` with read-replica tolerance, or a projection updated in the commit transaction / via an outbox if it gets expensive. |
| Hot products | Row-level contention on one product's stock row. If that matters: stock buckets/sharded counters or a queue per SKU. |

Instances become stateless and can scale horizontally behind a load balancer. Correctness rests on DB constraints and conditional updates, not process memory.

## 8. How I used AI tools

I used AI coding assistants (OpenAI Codex earlier, Claude Code for this version) to draft code, tests and documentation. I reviewed, ran and changed what they produced. Specific places where AI output was corrected, rejected or redirected:

1. **Rejected an earlier AI-generated design.** A first Codex attempt made every mutation clone the entire state and swap it in, with no asynchronous step. Under the brief's concurrency requirements it was "safe" only because nothing could ever interleave. That does not demonstrate overlap handling and does not survive adding a payment call. I discarded it and rebuilt around explicit reservations (Decision 1).
2. **Mutation testing exposed a weak test harness.** After deliberately removing the coupon reservation, the suite *hung* instead of failing: the second checkout waited forever on a held fake payment. I added `--test-timeout` so a broken implementation fails fast. I then confirmed that three separate deliberate bugs each fail 2–3 tests.
3. **Rounding.** The first `percentOf` used `Math.floor((a * p) / 100)`. This relies on float division and is only exact while `a·p/100` is small. It was replaced with exact integer division (subtract the remainder first), with a test at the largest amount the limits allow.
4. **Test shortcut removed.** A generated coupon test reached into a private field (`(shop.checkout as any).payment = …`) to swap gateways mid-test. It was replaced by an explicit `autoApprove` switch on the test gateway.
5. **A bug found only by running the live server.** `POST /admin/coupons` with `content-type: application/json` and an empty body was rejected by Fastify's default parser. All `inject`-based tests had passed. A custom parser now treats an empty body as `{}`, with a test.

## 9. With two more hours, I would examine first

1. **Unknown payment outcomes.** Model `payment_unknown` and reconcile it with the provider, instead of releasing on any thrown error. This is the most likely real-money bug.
2. **A property-based / randomised concurrency test.** Random interleavings of add/update/checkout/decline/generate, asserting I1–I9 after every step. This would complement the scenario tests.
3. **A SQLite/Postgres-backed store behind the same service interfaces**, to prove the section 7 mapping with real conditional updates and two app instances.
4. **Idempotency key scoping and expiry**, plus response storage so replays return the byte-identical original response.
