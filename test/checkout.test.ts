import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cartWith, code, flush, makeShop, ManualPaymentGateway } from './helpers.js';

describe('checkout: happy path and snapshots', () => {
  it('creates an order, deducts stock once and closes the cart', async () => {
    const shop = makeShop();
    const cartId = cartWith(shop, { book: 2, pen: 3 });

    const { order, replayed } = await shop.checkout.checkout({ cartId, idempotencyKey: 'k1' });

    assert.equal(replayed, false);
    assert.equal(order.sequence, 1);
    assert.equal(order.subtotalCents, 2 * 1299 + 3 * 100);
    assert.equal(order.totalCents, order.subtotalCents);
    assert.equal(shop.catalog.get('book').stock, 8);
    assert.equal(shop.catalog.get('pen').stock, 97);
    assert.equal(shop.carts.view(cartId).status, 'checked_out');
    assert.throws(() => shop.carts.addItem(cartId, 'pen', 1), code('CART_ALREADY_CHECKED_OUT'));
  });

  it('keeps the order explainable after the catalog changes', async () => {
    const shop = makeShop();
    const cartId = cartWith(shop, { book: 1 });
    const { order } = await shop.checkout.checkout({ cartId, idempotencyKey: 'k1' });

    shop.catalog.update('book', { unitPriceCents: 9999, name: 'Renamed' });

    const stored = shop.checkout.getOrder(order.id);
    assert.deepEqual(stored.lines, [
      { productId: 'book', productName: 'Book', unitPriceCents: 1299, quantity: 1, lineTotalCents: 1299 },
    ]);
    assert.equal(shop.carts.view(cartId).subtotalCents, 1299);
  });

  it('charges the live price at checkout, and QUOTE_CHANGED protects a stale client', async () => {
    const shop = makeShop();
    const cartId = cartWith(shop, { book: 1 });
    shop.catalog.update('book', { unitPriceCents: 1500 });

    await assert.rejects(
      shop.checkout.checkout({ cartId, idempotencyKey: 'k1', expectedTotalCents: 1299 }),
      code('QUOTE_CHANGED'),
    );
    assert.equal(shop.catalog.get('book').stock, 10, 'a rejected quote reserves nothing');
    assert.equal(shop.carts.view(cartId).status, 'open');

    const { order } = await shop.checkout.checkout({ cartId, idempotencyKey: 'k2', expectedTotalCents: 1500 });
    assert.equal(order.totalCents, 1500);
  });

  it('rejects empty carts and stock that disappeared after adding', async () => {
    const shop = makeShop();
    await assert.rejects(shop.checkout.checkout({ cartId: cartWith(shop, {}), idempotencyKey: 'a' }), code('CART_EMPTY'));

    const cartId = cartWith(shop, { book: 3, rare: 1 });
    shop.catalog.update('book', { stock: 2 });
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'b' }), (err: any) => {
      assert.equal(err.code, 'INSUFFICIENT_STOCK');
      assert.deepEqual(err.details.items, [{ productId: 'book', requested: 3, available: 2 }]);
      return true;
    });
    assert.equal(shop.catalog.get('rare').stock, 1, 'all-or-nothing: no partial deduction');
  });
});

describe('checkout: retries and idempotency', () => {
  it('a sequential retry with the same key returns the same order without charging again', async () => {
    const shop = makeShop();
    const cartId = cartWith(shop, { book: 1 });
    const first = await shop.checkout.checkout({ cartId, idempotencyKey: 'retry-me' });
    const second = await shop.checkout.checkout({ cartId, idempotencyKey: 'retry-me' });

    assert.equal(second.replayed, true);
    assert.equal(second.order.id, first.order.id);
    assert.equal(shop.checkout.listOrders().length, 1);
    assert.equal(shop.catalog.get('book').stock, 9);
  });

  it('a retry that arrives while the first attempt is still paying joins it', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ payment });
    const cartId = cartWith(shop, { book: 1 });

    const a = shop.checkout.checkout({ cartId, idempotencyKey: 'dup' });
    const b = shop.checkout.checkout({ cartId, idempotencyKey: 'dup' });
    await flush();
    assert.equal(payment.calls.length, 1, 'only one charge is attempted');
    payment.approve();

    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.order.id, rb.order.id);
    assert.deepEqual([ra.replayed, rb.replayed], [false, true]);
    assert.equal(shop.catalog.get('book').stock, 9);
  });

  it('a different key cannot check out the same cart twice, in flight or after', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ payment });
    const cartId = cartWith(shop, { book: 1 });

    const first = shop.checkout.checkout({ cartId, idempotencyKey: 'one' });
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'two' }), code('CART_CHECKOUT_IN_PROGRESS'));
    assert.throws(() => shop.carts.addItem(cartId, 'pen', 1), code('CART_CHECKOUT_IN_PROGRESS'));

    payment.approve();
    const { order } = await first;
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'three' }), (err: any) => {
      assert.equal(err.code, 'CART_ALREADY_CHECKED_OUT');
      assert.equal(err.details.orderId, order.id, 'tells the client where its order is');
      return true;
    });
  });

  it('reusing a key for a different request is rejected', async () => {
    const shop = makeShop();
    await shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'k' });
    await assert.rejects(
      shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'k' }),
      code('IDEMPOTENCY_KEY_REUSED'),
    );
  });
});

describe('checkout: concurrency and inventory', () => {
  it('two carts racing for the last unit: exactly one wins, stock never goes negative', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ payment });
    const cartA = cartWith(shop, { rare: 1 });
    const cartB = cartWith(shop, { rare: 1 });

    const a = shop.checkout.checkout({ cartId: cartA, idempotencyKey: 'a' });
    const b = shop.checkout.checkout({ cartId: cartB, idempotencyKey: 'b' });
    await assert.rejects(b, code('INSUFFICIENT_STOCK'), 'B sees the stock A reserved');

    payment.approve();
    await a;
    assert.equal(shop.catalog.get('rare').stock, 0);
    assert.equal(shop.checkout.listOrders().length, 1);
  });

  it('20 concurrent checkouts for 10 units sell exactly 10', async () => {
    const shop = createRealisticShop();
    const carts = Array.from({ length: 20 }, () => cartWith(shop, { book: 1 }));

    const results = await Promise.allSettled(
      carts.map((cartId, i) => shop.checkout.checkout({ cartId, idempotencyKey: `k${i}` })),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(ok.length, 10);
    assert.ok(failed.every((r) => r.reason.code === 'INSUFFICIENT_STOCK'));
    assert.equal(shop.catalog.get('book').stock, 0);
    // Sequences are dense and unique even though checkouts overlapped.
    assert.deepEqual(shop.checkout.listOrders().map((o) => o.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('checkout: payment failures release everything', () => {
  it('a declined payment restores stock and reopens the cart; the same key can retry', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ payment });
    const cartId = cartWith(shop, { rare: 1 });

    const attempt = shop.checkout.checkout({ cartId, idempotencyKey: 'k' });
    await flush();
    assert.equal(shop.catalog.get('rare').stock, 0, 'reserved while paying');
    payment.decline(0);
    await assert.rejects(attempt, code('PAYMENT_DECLINED'));

    assert.equal(shop.catalog.get('rare').stock, 1);
    assert.equal(shop.carts.view(cartId).status, 'open');
    assert.equal(shop.checkout.listOrders().length, 0);

    const retry = shop.checkout.checkout({ cartId, idempotencyKey: 'k' });
    await flush();
    payment.approve(1);
    assert.equal((await retry).replayed, false);
  });

  it('a provider error with no charge on record is PAYMENT_FAILED and releases', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ payment });
    const cartId = cartWith(shop, { book: 2 });
    const attempt = shop.checkout.checkout({ cartId, idempotencyKey: 'k' });
    await flush();
    payment.fail(0);
    await assert.rejects(attempt, code('PAYMENT_FAILED'));
    assert.equal(shop.catalog.get('book').stock, 10);
    assert.deepEqual(payment.lookups, ['k'], 'released only after the provider confirmed no charge');
  });
});

describe('checkout: unknown payment outcomes', () => {
  it('if the charge call errors but the provider did charge, the order is placed', async () => {
    const payment = new ManualPaymentGateway();
    payment.lookup = { status: 'succeeded', paymentId: 'pay-late' };
    const shop = makeShop({ payment });
    const attempt = shop.checkout.checkout({ cartId: cartWith(shop, { rare: 1 }), idempotencyKey: 'k' });
    await flush();
    payment.fail(0);

    const { order } = await attempt;
    assert.equal(order.paymentId, 'pay-late');
    assert.equal(payment.calls.length, 1, 'never charged twice');
    assert.equal(shop.catalog.get('rare').stock, 0);
  });

  it('if the provider cannot answer, everything stays held until a retry learns the outcome', async () => {
    const payment = new ManualPaymentGateway();
    payment.autoApprove = true;
    const shop = makeShop({ payment, n: 1 });
    await shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'setup' });
    const coupon = shop.coupons.generate();
    payment.autoApprove = false;

    const cartId = cartWith(shop, { rare: 1 });
    const attempt = shop.checkout.checkout({ cartId, idempotencyKey: 'k', couponCode: coupon.code });
    await flush();
    payment.lookup = 'throw';
    payment.fail(0);
    await assert.rejects(attempt, code('PAYMENT_PENDING'));

    // Held, not released: the goods may already be paid for.
    assert.equal(shop.catalog.get('rare').stock, 0);
    assert.equal(shop.coupons.list().find((c) => c.code === coupon.code)!.status, 'reserved');
    assert.equal(shop.carts.view(cartId).status, 'checking_out');
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'other' }), code('CART_CHECKOUT_IN_PROGRESS'));
    assert.equal(shop.report.build().totalOrders, 1, 'not counted as an order yet');

    // Provider recovers and reports the charge succeeded; the client retries.
    payment.lookup = { status: 'succeeded', paymentId: 'pay-confirmed' };
    const retry = await shop.checkout.checkout({ cartId, idempotencyKey: 'k', couponCode: coupon.code });
    assert.equal(retry.order.paymentId, 'pay-confirmed');
    assert.equal(retry.order.discount?.couponCode, coupon.code);
    assert.equal(payment.calls.length, 2, 'setup charge + the one real attempt; the retry only looked it up');
    assert.equal(shop.coupons.list().find((c) => c.code === coupon.code)!.status, 'redeemed');
  });

  it('the maintenance pass settles pending checkouts without a client retry', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ payment });
    const cartId = cartWith(shop, { book: 2 });
    const attempt = shop.checkout.checkout({ cartId, idempotencyKey: 'k' });
    await flush();
    payment.lookup = 'throw';
    payment.fail(0);
    await assert.rejects(attempt, code('PAYMENT_PENDING'));
    assert.equal(shop.catalog.get('book').stock, 8);

    payment.lookup = null; // provider confirms it never received the charge
    await shop.checkout.runMaintenance();
    assert.equal(shop.catalog.get('book').stock, 10);
    assert.equal(shop.carts.view(cartId).status, 'open');

    // The key is free again, so the customer can simply retry.
    payment.autoApprove = true;
    const { order } = await shop.checkout.checkout({ cartId, idempotencyKey: 'k' });
    assert.equal(order.totalCents, 2598);
  });
});

describe('checkout: idempotency key expiry', () => {
  it('replays within the TTL; after it the cart itself still prevents a second order', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const shop = makeShop({ now: () => new Date(now), idempotencyTtlMs: 60_000 });
    const cartId = cartWith(shop, { pen: 1 });
    const { order } = await shop.checkout.checkout({ cartId, idempotencyKey: 'k' });

    now += 59_000;
    assert.equal((await shop.checkout.checkout({ cartId, idempotencyKey: 'k' })).replayed, true);

    now += 2_000;
    await shop.checkout.runMaintenance(); // prunes the expired record
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'k' }), (err: any) => {
      assert.equal(err.code, 'CART_ALREADY_CHECKED_OUT');
      assert.equal(err.details.orderId, order.id);
      return true;
    });
    assert.equal(shop.checkout.listOrders().length, 1);
  });
});

/** A shop whose fake gateway has real (tiny) latency, so checkouts interleave on the event loop. */
function createRealisticShop() {
  const payment = {
    charge: async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return { status: 'succeeded' as const, paymentId: 'p' };
    },
    getCharge: async () => null,
  };
  return makeShop({ payment });
}
