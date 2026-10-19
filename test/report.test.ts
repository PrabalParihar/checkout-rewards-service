import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cartWith, flush, makeShop, ManualPaymentGateway } from './helpers.js';

describe('admin report', () => {
  it('reconciles with orders and coupons, and excludes failed/in-flight checkouts', async () => {
    const payment = new ManualPaymentGateway();
    payment.autoApprove = true;
    const shop = makeShop({ n: 2, percent: 10, payment });

    await shop.checkout.checkout({ cartId: cartWith(shop, { book: 2 }), idempotencyKey: 'o1' }); // 2598
    await shop.checkout.checkout({ cartId: cartWith(shop, { pen: 3 }), idempotencyKey: 'o2' }); // 300
    const coupon = shop.coupons.generate();
    await shop.checkout.checkout({ cartId: cartWith(shop, { book: 1, pen: 1 }), idempotencyKey: 'o3', couponCode: coupon.code }); // 1399 - 139

    // One declined and one still-in-flight checkout must not appear.
    payment.autoApprove = false;
    const declined = shop.checkout.checkout({ cartId: cartWith(shop, { book: 1 }), idempotencyKey: 'bad' });
    const inFlight = shop.checkout.checkout({ cartId: cartWith(shop, { pen: 10 }), idempotencyKey: 'slow' });
    await flush();
    payment.decline(0);
    await assert.rejects(declined);

    const report = shop.report.build();
    assert.equal(report.totalOrders, 3);
    assert.deepEqual(report.purchasedByProduct, [
      { productId: 'book', productName: 'Book', quantity: 3, grossCents: 3897 },
      { productId: 'pen', productName: 'Pen', quantity: 4, grossCents: 400 },
    ]);
    assert.equal(report.grossRevenueCents, 4297);
    assert.equal(report.totalDiscountCents, 139);
    assert.equal(report.netRevenueCents, 4158);
    assert.deepEqual(
      { generated: report.coupons.generated, available: report.coupons.available, reserved: report.coupons.reserved, redeemed: report.coupons.redeemed },
      { generated: 1, available: 0, reserved: 0, redeemed: 1 },
    );

    // Reconciliation against the order list itself.
    const orders = shop.checkout.listOrders();
    assert.equal(report.netRevenueCents, orders.reduce((s, o) => s + o.totalCents, 0));

    payment.approve(1);
    await inFlight;
  });

  it('is read-only: repeated calls return identical results and change nothing', async () => {
    const shop = makeShop({ n: 1 });
    await shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: 'k' });
    const first = shop.report.build();
    const second = shop.report.build();
    assert.deepEqual(first, second);
    assert.equal(shop.coupons.list().length, 0, 'reporting never issues coupons');
    assert.deepEqual(first.rewards.unrewardedMilestones, [1]);
  });
});
