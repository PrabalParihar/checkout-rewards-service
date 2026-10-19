import type { CouponService } from './coupons.js';
import { sum, type Cents } from './money.js';
import type { Store } from './store.js';

export interface Report {
  totalOrders: number;
  purchasedByProduct: { productId: string; productName: string; quantity: number; grossCents: Cents }[];
  grossRevenueCents: Cents;
  totalDiscountCents: Cents;
  netRevenueCents: Cents;
  coupons: {
    generated: number;
    available: number;
    reserved: number;
    redeemed: number;
    codes: { code: string; status: string; milestone: number; percent: number; redeemedByOrderId: string | null }[];
  };
  rewards: { everyNOrders: number; discountPercent: number; unrewardedMilestones: number[]; nextMilestone: number };
}

/**
 * Read-only: derived entirely from placed orders and coupons on every call,
 * so it cannot drift from them and calling it never changes state. In-flight
 * checkouts are not orders yet and are excluded (their coupons show as
 * `reserved`).
 */
export class ReportService {
  constructor(
    private readonly store: Store,
    private readonly coupons: CouponService,
  ) {}

  build(): Report {
    const orders = [...this.store.orders.values()];
    const byProduct = new Map<string, Report['purchasedByProduct'][number]>();
    for (const order of orders) {
      for (const line of order.lines) {
        const row = byProduct.get(line.productId) ?? { productId: line.productId, productName: line.productName, quantity: 0, grossCents: 0 };
        row.quantity += line.quantity;
        row.grossCents += line.lineTotalCents;
        byProduct.set(line.productId, row);
      }
    }

    const coupons = this.coupons.list();
    const count = (status: string) => coupons.filter((c) => c.status === status).length;
    const grossRevenueCents = sum(orders.map((o) => o.subtotalCents));
    const totalDiscountCents = sum(orders.map((o) => o.discount?.amountCents ?? 0));
    const { unrewardedMilestones, nextMilestone } = this.coupons.milestones();

    return {
      totalOrders: orders.length,
      purchasedByProduct: [...byProduct.values()].sort((a, b) => a.productId.localeCompare(b.productId)),
      grossRevenueCents,
      totalDiscountCents,
      netRevenueCents: grossRevenueCents - totalDiscountCents,
      coupons: {
        generated: coupons.length,
        available: count('available'),
        reserved: count('reserved'),
        redeemed: count('redeemed'),
        codes: coupons.map(({ code, status, milestone, percent, redeemedByOrderId }) => ({ code, status, milestone, percent, redeemedByOrderId })),
      },
      rewards: { ...this.coupons.config, unrewardedMilestones, nextMilestone },
    };
  }
}
