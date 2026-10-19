import { randomUUID } from 'node:crypto';
import type { Cart, Coupon, Order, Product } from './types.js';

/**
 * In-memory state for one process.
 *
 * Concurrency model: Node runs JavaScript on a single thread. Any block of
 * code with no `await` inside it runs to completion before another request's
 * code can run, so it is effectively a critical section. Every service keeps
 * its invariant-checking + mutation steps inside such synchronous blocks and
 * only awaits (payment) between them, after recording what it reserved.
 */
export class Store {
  readonly products = new Map<string, Product>();
  readonly carts = new Map<string, Cart>();
  /** Insertion order == placement order. */
  readonly orders = new Map<string, Order>();
  readonly coupons = new Map<string, Coupon>();

  constructor(
    products: readonly Product[],
    readonly now: () => Date = () => new Date(),
    readonly newId: () => string = randomUUID,
  ) {
    for (const p of products) {
      if (this.products.has(p.id)) throw new Error(`duplicate product id ${p.id}`);
      this.products.set(p.id, { ...p });
    }
  }

  timestamp(): string {
    return this.now().toISOString();
  }
}
