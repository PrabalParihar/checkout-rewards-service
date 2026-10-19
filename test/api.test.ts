import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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

  before(async () => {
    app = startServer();
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  after(() => app.close());

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
    const report = await call('GET', '/admin/report');
    const eligible = report.body.rewards.unrewardedMilestones.length; // orders so far, n = 2
    const responses = await Promise.all(Array.from({ length: eligible + 3 }, () => call('POST', '/admin/coupons')));

    assert.equal(responses.filter((r) => r.status === 201).length, eligible);
    assert.ok(responses.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'NO_ELIGIBLE_MILESTONE'));
    const milestones = responses.filter((r) => r.status === 201).map((r) => r.body.milestone);
    assert.equal(new Set(milestones).size, milestones.length, 'no milestone rewarded twice');
  });

  it('a coupon raced by two checkouts is redeemed once', async () => {
    const { body: coupons } = await call('GET', '/admin/coupons');
    const code = coupons.find((c: any) => c.status === 'available').code;
    const [a, b] = await Promise.all([newCart({ book: 1 }), newCart({ book: 1 })]);
    const responses = await Promise.all([checkout(a, 'cpn-a', { couponCode: code }), checkout(b, 'cpn-b', { couponCode: code })]);

    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(responses.find((r) => r.status === 409)!.body.error.code, 'COUPON_IN_USE');
    assert.equal(responses.find((r) => r.status === 201)!.body.discount.amountCents, 129);
  });

  it('report reconciles with /admin/orders and repeated reads are identical', async () => {
    const [r1, r2, orders] = await Promise.all([call('GET', '/admin/report'), call('GET', '/admin/report'), call('GET', '/admin/orders')]);
    assert.deepEqual(r1.body, r2.body);
    assert.equal(r1.body.totalOrders, orders.body.length);
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
