import { AppError } from './errors.js';
import type { Store } from './store.js';
import type { Product } from './types.js';

export class CatalogService {
  constructor(private readonly store: Store) {}

  list(): Product[] {
    return [...this.store.products.values()].map((p) => ({ ...p }));
  }

  get(id: string): Product {
    const product = this.store.products.get(id);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', `Product '${id}' does not exist`, { productId: id });
    return { ...product };
  }

  /**
   * Admin: change price and/or set absolute stock. Existing orders keep their
   * snapshots; open carts see the new values at next view/checkout.
   * Setting stock while a checkout holds a reservation is allowed: the
   * reservation was already subtracted, so `stock` is always "sellable now".
   */
  update(id: string, patch: { unitPriceCents?: number; stock?: number; name?: string }): Product {
    const product = this.store.products.get(id);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', `Product '${id}' does not exist`, { productId: id });
    if (patch.unitPriceCents !== undefined) product.unitPriceCents = patch.unitPriceCents;
    if (patch.stock !== undefined) product.stock = patch.stock;
    if (patch.name !== undefined) product.name = patch.name;
    return { ...product };
  }
}
