import type { ChargeRequest, ChargeResult, PaymentGateway } from '../src/payment.js';
import { createShop, type Shop } from '../src/shop.js';
import type { Product } from '../src/types.js';

export const TEST_PRODUCTS: Product[] = [
  { id: 'pen', name: 'Pen', unitPriceCents: 100, stock: 100 },
  { id: 'book', name: 'Book', unitPriceCents: 1299, stock: 10 },
  { id: 'rare', name: 'Rare Print', unitPriceCents: 5000, stock: 1 },
];

export function makeShop(
  opts: { payment?: PaymentGateway; products?: Product[]; n?: number; percent?: number; now?: () => Date; idempotencyTtlMs?: number } = {},
): Shop {
  let i = 0;
  return createShop({
    products: opts.products ?? TEST_PRODUCTS.map((p) => ({ ...p })),
    rewardEveryNOrders: opts.n ?? 3,
    discountPercent: opts.percent ?? 10,
    payment: opts.payment,
    paymentLatencyMs: 0,
    idempotencyTtlMs: opts.idempotencyTtlMs,
    now: opts.now ?? (() => new Date('2026-01-01T00:00:00.000Z')),
    newId: () => `id-${++i}`,
  });
}

/** Builds a cart with the given lines and returns its id. */
export function cartWith(shop: Shop, items: Record<string, number>): string {
  const { id } = shop.carts.create();
  for (const [productId, qty] of Object.entries(items)) shop.carts.addItem(id, productId, qty);
  return id;
}

/** Matcher for assert.throws / assert.rejects on AppError codes. */
export const code = (expected: string) => (err: unknown) => {
  const actual = (err as { code?: string }).code;
  if (actual !== expected) throw new Error(`expected error ${expected}, got ${actual ?? String(err)}`);
  return true;
};

/**
 * A payment gateway the test controls: every charge stays pending until the
 * test settles it. This makes "request B arrives while A is paying"
 * deterministic instead of timing-dependent. `index` counts held charges only.
 */
export class ManualPaymentGateway implements PaymentGateway {
  readonly calls: ChargeRequest[] = [];
  /** When true, charges succeed immediately (e.g. while setting up milestones). */
  autoApprove = false;
  /** What `getCharge` answers: a result, null (never received) or 'throw' (provider unreachable). */
  lookup: ChargeResult | null | 'throw' = null;
  readonly lookups: string[] = [];

  async getCharge(idempotencyKey: string): Promise<ChargeResult | null> {
    this.lookups.push(idempotencyKey);
    if (this.lookup === 'throw') throw new Error('provider unreachable');
    return this.lookup;
  }
  private readonly pending: { resolve: (r: ChargeResult) => void; reject: (e: Error) => void }[] = [];

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.calls.push(request);
    if (this.autoApprove) return Promise.resolve({ status: 'succeeded', paymentId: `pay-auto-${this.calls.length}` });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  approve(index = 0) {
    this.pending[index]!.resolve({ status: 'succeeded', paymentId: `pay-${index}` });
  }
  approveAll() {
    this.pending.forEach((_, i) => this.approve(i));
  }
  decline(index = 0, reason = 'card_declined') {
    this.pending[index]!.resolve({ status: 'declined', reason });
  }
  fail(index = 0) {
    this.pending[index]!.reject(new Error('provider timeout'));
  }
}

/** Let pending promise callbacks run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Places `count` one-pen orders, e.g. to reach a coupon milestone. */
export async function placeOrders(shop: Shop, count: number, prefix = 'fill') {
  for (let i = 0; i < count; i++) {
    await shop.checkout.checkout({ cartId: cartWith(shop, { pen: 1 }), idempotencyKey: `${prefix}-${i}` });
  }
}
