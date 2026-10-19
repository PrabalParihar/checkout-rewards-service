import { createShop, type Shop } from '../src/shop.js';
import type { Product } from '../src/types.js';

export const TEST_PRODUCTS: Product[] = [
  { id: 'pen', name: 'Pen', unitPriceCents: 100, stock: 100 },
  { id: 'book', name: 'Book', unitPriceCents: 1299, stock: 10 },
  { id: 'rare', name: 'Rare Print', unitPriceCents: 5000, stock: 1 },
];

export function makeShop(opts: { products?: Product[] } = {}): Shop {
  let i = 0;
  return createShop({
    products: opts.products ?? TEST_PRODUCTS,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    newId: () => `id-${++i}`,
  });
}
