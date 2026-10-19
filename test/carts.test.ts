import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeShop } from './helpers.js';

const code = (c: string) => (err: unknown) => (err as { code?: string }).code === c;

describe('carts', () => {
  it('creates an empty open cart', () => {
    const shop = makeShop();
    const cart = shop.carts.create();
    assert.equal(cart.status, 'open');
    assert.deepEqual(cart.lines, []);
    assert.equal(cart.subtotalCents, 0);
  });

  it('adds, merges, updates and removes items with exact totals', () => {
    const shop = makeShop();
    const { id } = shop.carts.create();
    shop.carts.addItem(id, 'book', 1);
    let cart = shop.carts.addItem(id, 'book', 2); // merges into one line
    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0]!.quantity, 3);
    assert.equal(cart.subtotalCents, 3897);

    shop.carts.addItem(id, 'pen', 5);
    cart = shop.carts.setQuantity(id, 'book', 1);
    assert.equal(cart.subtotalCents, 1299 + 500);

    cart = shop.carts.removeItem(id, 'pen');
    assert.deepEqual(cart.lines.map((l) => l.productId), ['book']);
  });

  it('rejects unknown products and invalid quantities without changing the cart', () => {
    const shop = makeShop();
    const { id } = shop.carts.create();
    assert.throws(() => shop.carts.addItem(id, 'nope', 1), code('PRODUCT_NOT_FOUND'));
    for (const bad of [0, -1, 1.5, Number.NaN, 1001]) {
      assert.throws(() => shop.carts.addItem(id, 'pen', bad), code('VALIDATION_ERROR'), `quantity ${bad}`);
    }
    assert.throws(() => shop.carts.addItem(id, 'rare', 2), code('INSUFFICIENT_STOCK'));
    assert.throws(() => shop.carts.setQuantity(id, 'pen', 1), code('ITEM_NOT_IN_CART'));
    assert.throws(() => shop.carts.removeItem(id, 'pen'), code('ITEM_NOT_IN_CART'));
    assert.deepEqual(shop.carts.view(id).lines, []);
  });

  it('shows live prices and flags price and stock changes after adding', () => {
    const shop = makeShop();
    const { id } = shop.carts.create();
    shop.carts.addItem(id, 'book', 2);
    shop.catalog.update('book', { unitPriceCents: 1500, stock: 1 });

    const cart = shop.carts.view(id);
    assert.equal(cart.lines[0]!.unitPriceCents, 1500);
    assert.equal(cart.lines[0]!.priceWhenAddedCents, 1299);
    assert.equal(cart.lines[0]!.priceChanged, true);
    assert.equal(cart.subtotalCents, 3000);
    assert.deepEqual(cart.issues, [{ productId: 'book', code: 'INSUFFICIENT_STOCK', requested: 2, available: 1 }]);
  });

  it('returns CART_NOT_FOUND for unknown carts', () => {
    const shop = makeShop();
    assert.throws(() => shop.carts.view('missing'), code('CART_NOT_FOUND'));
  });
});
