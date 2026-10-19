import { CartService } from './carts.js';
import { CatalogService } from './catalog.js';
import { CheckoutService } from './checkout.js';
import { CouponService } from './coupons.js';
import { FakePaymentGateway, type PaymentGateway } from './payment.js';
import { Store } from './store.js';
import type { Product } from './types.js';

export interface ShopOptions {
  products: readonly Product[];
  rewardEveryNOrders: number;
  discountPercent: number;
  payment?: PaymentGateway;
  paymentLatencyMs?: number;
  now?: () => Date;
  newId?: () => string;
}

/** Composition root: one Store shared by every service. */
export function createShop(opts: ShopOptions) {
  const store = new Store(opts.products, opts.now, opts.newId);
  const payment = opts.payment ?? new FakePaymentGateway(opts.paymentLatencyMs);
  const coupons = new CouponService(store, {
    everyNOrders: opts.rewardEveryNOrders,
    discountPercent: opts.discountPercent,
  });
  return {
    store,
    catalog: new CatalogService(store),
    carts: new CartService(store),
    coupons,
    checkout: new CheckoutService(store, payment, coupons),
  };
}

export type Shop = ReturnType<typeof createShop>;
