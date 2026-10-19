import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cartWith, code, flush, makeShop, ManualPaymentGateway, placeOrders } from './helpers.js';
import type { CheckoutRequest } from '../src/checkout.js';
import type { Shop } from '../src/shop.js';

describe('coupon generation (n = 3)', () => {
  it('refuses before the first milestone and says when it unlocks', async () => {
    const shop = makeShop({ n: 3 });
    await placeOrders(shop, 2);
    assert.throws(() => shop.coupons.generate(), (err: any) => {
      assert.equal(err.code, 'NO_ELIGIBLE_MILESTONE');
      assert.equal(err.details.nextMilestone, 3);
      return true;
    });
  });

  it('issues exactly one coupon per milestone', async () => {
    const shop = makeShop({ n: 3, percent: 10 });
    await placeOrders(shop, 3);
    const coupon = shop.coupons.generate();
    assert.equal(coupon.milestone, 3);
    assert.equal(coupon.percent, 10);
    assert.equal(coupon.status, 'available');
    assert.throws(() => shop.coupons.generate(), code('NO_ELIGIBLE_MILESTONE'));

    await placeOrders(shop, 3, 'more');
    assert.equal(shop.coupons.generate().milestone, 6);
  });

  it('catches up on missed milestones oldest first, then stops', async () => {
    const shop = makeShop({ n: 3 });
    await placeOrders(shop, 7);
    assert.deepEqual([shop.coupons.generate().milestone, shop.coupons.generate().milestone], [3, 6]);
    assert.throws(() => shop.coupons.generate(), code('NO_ELIGIBLE_MILESTONE'));
  });

  it('only successful orders count toward milestones', async () => {
    const payment = new ManualPaymentGateway();
    const shop = makeShop({ n: 1, payment });
    const attempt = shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'x' });
    await flush();
    assert.throws(() => shop.coupons.generate(), code('NO_ELIGIBLE_MILESTONE'), 'in-flight is not placed');
    payment.decline();
    await assert.rejects(attempt);
    assert.throws(() => shop.coupons.generate(), code('NO_ELIGIBLE_MILESTONE'), 'declined is not placed');
  });
});

describe('coupon redemption', () => {
  /** n = 1, one order placed, one coupon generated; payment is held from then on. */
  async function shopWithCoupon(opts: { percent?: number } = {}) {
    const payment = new ManualPaymentGateway();
    payment.autoApprove = true;
    const shop = makeShop({ n: 1, payment, ...opts });
    await placeOrders(shop, 1);
    payment.autoApprove = false;
    return { shop, payment, coupon: shop.coupons.generate() };
  }
  /** Most redemption tests don't care about payment timing. */
  async function checkoutNow(shop: Shop, payment: ManualPaymentGateway, req: CheckoutRequest) {
    payment.autoApprove = true;
    try { return await shop.checkout.checkout(req); } finally { payment.autoApprove = false; }
  }

  it('applies x% off the subtotal, rounded down, and records it on the order', async () => {
    const { shop, payment, coupon } = await shopWithCoupon({ percent: 10 });
    const cartId = cartWith(shop, { book: 1 }); // 1299
    const { order } = await checkoutNow(shop, payment, { cartId, idempotencyKey: 'k', couponCode: coupon.code.toLowerCase() });

    assert.deepEqual(order.discount, { couponCode: coupon.code, percent: 10, amountCents: 129 });
    assert.equal(order.totalCents, 1170);
    const stored = shop.coupons.list().find((c) => c.code === coupon.code)!;
    assert.equal(stored.status, 'redeemed');
    assert.equal(stored.redeemedByOrderId, order.id);
  });

  it('can be redeemed only once', async () => {
    const { shop, payment, coupon } = await shopWithCoupon();
    await checkoutNow(shop, payment, { cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'a', couponCode: coupon.code });
    await assert.rejects(
      shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'b', couponCode: coupon.code }),
      code('COUPON_ALREADY_REDEEMED'),
    );
  });

  it('two concurrent checkouts with one coupon: one gets it, the other is told it is in use', async () => {
    const { shop, payment, coupon } = await shopWithCoupon();

    const a = shop.checkout.checkout({ cartId: cartWith(shop, { book: 1 }), idempotencyKey: 'a', couponCode: coupon.code });
    const b = shop.checkout.checkout({ cartId: cartWith(shop, { book: 1 }), idempotencyKey: 'b', couponCode: coupon.code });
    await assert.rejects(b, code('COUPON_IN_USE'));

    payment.approve();
    const { order } = await a;
    assert.equal(order.discount?.couponCode, coupon.code);
    assert.equal(shop.coupons.list().filter((c) => c.status === 'redeemed').length, 1);
  });

  it('is not consumed by a checkout that fails validation', async () => {
    const { shop, coupon } = await shopWithCoupon();
    const cartId = cartWith(shop, { book: 2 });
    shop.catalog.update('book', { stock: 1 });
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'k', couponCode: coupon.code }), code('INSUFFICIENT_STOCK'));
    assert.equal(shop.coupons.list()[0]!.status, 'available');
  });

  it('is released when payment is declined, and can then be used', async () => {
    const { shop, payment, coupon } = await shopWithCoupon();

    const attempt = shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'k', couponCode: coupon.code });
    await flush();
    assert.equal(shop.coupons.list()[0]!.status, 'reserved');
    payment.decline();
    await assert.rejects(attempt, code('PAYMENT_DECLINED'));
    assert.equal(shop.coupons.list()[0]!.status, 'available');

    const retry = shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'k2', couponCode: coupon.code });
    await flush();
    payment.approve(1);
    assert.equal((await retry).order.discount?.amountCents, 10);
  });

  it('a 100% coupon makes the total zero (never negative) and skips payment', async () => {
    const { shop, payment, coupon } = await shopWithCoupon({ percent: 100 });
    const callsBefore = payment.calls.length;
    const { order } = await shop.checkout.checkout({ cartId: cartWith(shop, { book: 1 }), idempotencyKey: 'k', couponCode: coupon.code });
    assert.equal(order.totalCents, 0);
    assert.equal(order.paymentId, null);
    assert.equal(payment.calls.length, callsBefore, 'no charge for a zero total');
  });

  it('rejects unknown codes, and a retried checkout never redeems twice', async () => {
    const { shop, payment, coupon } = await shopWithCoupon();
    await assert.rejects(
      shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'x', couponCode: 'SAVE10-NOPE' }),
      code('COUPON_INVALID'),
    );

    const cartId = cartWith(shop, { pen: 1 });
    const first = await checkoutNow(shop, payment, { cartId, idempotencyKey: 'k', couponCode: coupon.code });
    const replay = await shop.checkout.checkout({ cartId, idempotencyKey: 'k', couponCode: coupon.code });
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, first.order.id);
    await assert.rejects(shop.checkout.checkout({ cartId, idempotencyKey: 'k' }), code('IDEMPOTENCY_KEY_REUSED'));
  });
});
