import { CartService } from './carts.js';
import { CatalogService } from './catalog.js';
import { Store } from './store.js';
import type { Product } from './types.js';

export interface ShopOptions {
  products: readonly Product[];
  now?: () => Date;
  newId?: () => string;
}

/** Composition root: one Store shared by every service. */
export function createShop(opts: ShopOptions) {
  const store = new Store(opts.products, opts.now, opts.newId);
  return {
    store,
    catalog: new CatalogService(store),
    carts: new CartService(store),
  };
}

export type Shop = ReturnType<typeof createShop>;
