import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createShop } from '../src/shop.js';
import { TEST_PRODUCTS } from './helpers.js';

/**
 * End-to-end over a real TCP socket. The fake payment has 20ms latency, so
 * concurrent requests genuinely interleave inside the server.
 */
function startServer(n = 2) {
  const shop = createShop({
    products: TEST_PRODUCTS.map((p) => ({ ...p })),
    rewardEveryNOrders: n,
    discountPercent: 10,
    paymentLatencyMs: 20,
  });
  return buildApp(shop);
}

describe('HTTP API', () => {
  let app: FastifyInstance;
  let base: string;

  // A fresh server and store per test: no test depends on another's state.
  beforeEach(async () => {
    app = startServer();
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(() => app.close());

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  };
  const newCart = async (items: Record<string, number>) => {
    const { body: cart } = await call('POST', '/carts');
    for (const [productId, quantity] of Object.entries(items)) {
      const res = await call('POST', `/carts/${cart.id}/items`, { productId, quantity });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    return cart.id as string;
  };
  const checkout = (cartId: string, key: string, body: object = {}) =>
    call('POST', `/carts/${cartId}/checkout`, body, { 'idempotency-key': key });
  /** Places `count` one-pen orders (n = 2, so every second one is a milestone). */
  const placeOrders = async (count: number) => {
    for (let i = 0; i < count; i++) assert.equal((await checkout(await newCart({ pen: 1 }), `fill-${i}`)).status, 201);
  };

  it('runs the full cart -> checkout -> order flow', async () => {
    const cartId = await newCart({ book: 1, pen: 2 });
    const res = await checkout(cartId, 'flow-1');
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('idempotent-replayed'), 'false');
    assert.equal(res.body.totalCents, 1499);

    const order = await call('GET', `/orders/${res.body.id}`);
    assert.equal(order.status, 200);
    assert.deepEqual(order.body, res.body);
  });

  it('5 identical concurrent retries produce one order', async () => {
    const cartId = await newCart({ pen: 1 });
    const responses = await Promise.all(Array.from({ length: 5 }, () => checkout(cartId, 'same-key')));

    const ids = new Set(responses.map((r) => r.body.id));
    assert.equal(ids.size, 1);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  });

  it('5 carts racing for the single rare item: one 201, four 409 INSUFFICIENT_STOCK', async () => {
    const carts = await Promise.all(Array.from({ length: 5 }, () => newCart({ rare: 1 })));
    const responses = await Promise.all(carts.map((id, i) => checkout(id, `rare-${i}`)));

    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    const losers = responses.filter((r) => r.status !== 201);
    assert.ok(losers.every((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK'));
    const products = await call('GET', '/products');
    assert.equal(products.body.find((p: any) => p.id === 'rare').stock, 0);
  });

  it('concurrent admin coupon generation issues one coupon per milestone', async () => {
    await placeOrders(5); // milestones 2 and 4 reached
    const responses = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/admin/coupons')));

    assert.equal(responses.filter((r) => r.status === 201).length, 2);
    assert.ok(responses.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'NO_ELIGIBLE_MILESTONE'));
    const milestones = responses.filter((r) => r.status === 201).map((r) => r.body.milestone);
    assert.deepEqual(milestones.sort(), [2, 4], 'each milestone rewarded exactly once');
  });

  it('a coupon raced by two checkouts is redeemed once', async () => {
    await placeOrders(2);
    const { body: coupon } = await call('POST', '/admin/coupons');
    const code = coupon.code;
    const [a, b] = await Promise.all([newCart({ book: 1 }), newCart({ book: 1 })]);
    const responses = await Promise.all([checkout(a, 'cpn-a', { couponCode: code }), checkout(b, 'cpn-b', { couponCode: code })]);

    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(responses.find((r) => r.status === 409)!.body.error.code, 'COUPON_IN_USE');
    assert.equal(responses.find((r) => r.status === 201)!.body.discount.amountCents, 129);
  });

  it('report reconciles with /admin/orders and repeated reads are identical', async () => {
    await placeOrders(2);
    const { body: coupon } = await call('POST', '/admin/coupons');
    assert.equal((await checkout(await newCart({ book: 3 }), 'discounted', { couponCode: coupon.code })).status, 201);
    const [r1, r2, orders] = await Promise.all([call('GET', '/admin/report'), call('GET', '/admin/report'), call('GET', '/admin/orders')]);
    assert.deepEqual(r1.body, r2.body);
    assert.equal(r1.body.totalOrders, orders.body.length);
    assert.equal(r1.body.totalOrders, 3);
    assert.equal(r1.body.totalDiscountCents, 389); // floor(3897 * 10%)
    const net = orders.body.reduce((s: number, o: any) => s + o.totalCents, 0);
    assert.equal(r1.body.netRevenueCents, net);
    assert.equal(r1.body.grossRevenueCents - r1.body.totalDiscountCents, net);
  });

  it('returns distinguishable errors', async () => {
    const cartId = await newCart({});
    const cases: [Promise<{ status: number; body: any }>, number, string][] = [
      [call('GET', '/carts/nope'), 404, 'CART_NOT_FOUND'],
      [call('POST', `/carts/${cartId}/items`, { productId: 'pen', quantity: 0 }), 400, 'VALIDATION_ERROR'],
      [call('POST', `/carts/${cartId}/items`, { productId: 'pen', quantity: '2' }), 400, 'VALIDATION_ERROR'],
      [call('POST', `/carts/${cartId}/items`, { productId: 'ghost', quantity: 1 }), 404, 'PRODUCT_NOT_FOUND'],
      [call('POST', `/carts/${cartId}/checkout`, {}), 400, 'IDEMPOTENCY_KEY_REQUIRED'],
      [checkout(cartId, 'empty'), 409, 'CART_EMPTY'],
      [checkout(cartId, 'bad key with spaces'), 400, 'VALIDATION_ERROR'],
      [call('GET', '/nowhere'), 404, 'ROUTE_NOT_FOUND'],
    ];
    for (const [pending, status, code] of cases) {
      const res = await pending;
      assert.equal(res.status, status, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, code);
    }

    const malformed = await fetch(`${base}/carts/${cartId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
  });
});

describe('HTTP API: request parsing', () => {
  it('accepts bodiless JSON POSTs as {}', async () => {
    const app = startServer();
    const res = await app.inject({ method: 'POST', url: '/admin/coupons', headers: { 'content-type': 'application/json' }, payload: '' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'NO_ELIGIBLE_MILESTONE');
    await app.close();
  });
});

describe('HTTP API: unconfirmed payment', () => {
  it('returns 503 PAYMENT_PENDING with Retry-After, then the order once the provider confirms', async () => {
    let providerUp = false;
    const shop = createShop({
      products: TEST_PRODUCTS.map((p) => ({ ...p })),
      rewardEveryNOrders: 2,
      discountPercent: 10,
      payment: {
        charge: async () => { throw new Error('timeout'); },
        getCharge: async () => {
          if (!providerUp) throw new Error('provider unreachable');
          return { status: 'succeeded', paymentId: 'pay-1' };
        },
      },
    });
    const app = buildApp(shop);
    const cart = shop.carts.create();
    shop.carts.addItem(cart.id, 'rare', 1);
    const request = { method: 'POST' as const, url: `/carts/${cart.id}/checkout`, headers: { 'idempotency-key': 'k' } };

    const pending = await app.inject(request);
    assert.equal(pending.statusCode, 503);
    assert.equal(pending.headers['retry-after'], '5');
    assert.equal(pending.json().error.code, 'PAYMENT_PENDING');

    providerUp = true;
    const placed = await app.inject(request);
    assert.equal(placed.statusCode, 201);
    assert.equal(placed.json().paymentId, 'pay-1');
    await app.close();
  });
});
