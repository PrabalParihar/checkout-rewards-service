import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import type { Store } from './store.js';
import type { Coupon } from './types.js';

export interface RewardConfig {
  /** n: every n-th successfully placed order unlocks one coupon. */
  everyNOrders: number;
  /** x: percent off the order subtotal. */
  discountPercent: number;
}

export interface MilestoneStatus {
  placedOrders: number;
  /** Milestones (k * n) reached but not yet turned into a coupon, oldest first. */
  unrewardedMilestones: number[];
  /** Order count at which the next not-yet-reached milestone unlocks. */
  nextMilestone: number;
}

export class CouponService {
  constructor(
    private readonly store: Store,
    readonly config: RewardConfig,
    private readonly generateCode: () => string = defaultCode(config.discountPercent),
  ) {}

  /**
   * Admin: issue one coupon for the OLDEST reached milestone that has none.
   * Synchronous, so two concurrent calls can never both claim one milestone.
   */
  generate(): Coupon {
    const status = this.milestones();
    const milestone = status.unrewardedMilestones[0];
    if (milestone === undefined) {
      throw new AppError('NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone has been reached', { ...status });
    }

    let code = this.generateCode();
    while (this.store.coupons.has(code)) code = this.generateCode();

    const coupon: Coupon = {
      code,
      milestone,
      percent: this.config.discountPercent,
      status: 'available',
      createdAt: this.store.timestamp(),
      redeemedByOrderId: null,
      redeemedAt: null,
    };
    this.store.coupons.set(code, coupon);
    return { ...coupon };
  }

  milestones(): MilestoneStatus {
    const n = this.config.everyNOrders;
    const placedOrders = this.store.orders.size;
    const rewarded = new Set([...this.store.coupons.values()].map((c) => c.milestone));
    const unrewardedMilestones: number[] = [];
    for (let m = n; m <= placedOrders; m += n) if (!rewarded.has(m)) unrewardedMilestones.push(m);
    return { placedOrders, unrewardedMilestones, nextMilestone: (Math.floor(placedOrders / n) + 1) * n };
  }

  list(): Coupon[] {
    return [...this.store.coupons.values()].map((c) => ({ ...c }));
  }

  /**
   * Looks a coupon up for checkout and asserts it can be reserved right now.
   * Codes are case-insensitive for humans; stored upper-case.
   */
  findRedeemable(rawCode: string): Coupon {
    const coupon = this.store.coupons.get(normalizeCode(rawCode));
    if (!coupon) throw new AppError('COUPON_INVALID', 'Coupon code is not valid', { couponCode: rawCode });
    if (coupon.status === 'redeemed') {
      throw new AppError('COUPON_ALREADY_REDEEMED', 'Coupon has already been used', { couponCode: coupon.code });
    }
    if (coupon.status === 'reserved') {
      throw new AppError('COUPON_IN_USE', 'Coupon is being used by another checkout in progress', { couponCode: coupon.code });
    }
    return coupon;
  }
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function defaultCode(percent: number) {
  // 40 random bits: unguessable enough for a demo, readable when typed.
  return () => `SAVE${percent}-${randomBytes(5).toString('hex').toUpperCase()}`;
}
