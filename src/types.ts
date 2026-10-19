import type { Cents } from './money.js';

export interface Product {
  id: string;
  name: string;
  unitPriceCents: Cents;
  /** Units that can still be sold. Reduced when a checkout reserves stock. */
  stock: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
  /** Price shown when the item was (last) added, used to flag price changes. */
  priceWhenAddedCents: Cents;
}

/**
 * open          -> items can be edited
 * checking_out  -> a checkout holds reservations; edits are rejected
 * checked_out   -> terminal; the cart is linked to exactly one order
 */
export type CartStatus = 'open' | 'checking_out' | 'checked_out';

export interface Cart {
  id: string;
  status: CartStatus;
  lines: Map<string, CartLine>;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Immutable snapshot of what was bought, independent of later catalog edits. */
export interface OrderLine {
  productId: string;
  productName: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface OrderDiscount {
  couponCode: string;
  percent: number;
  amountCents: Cents;
}

export interface Order {
  id: string;
  /** 1-based position among successfully placed orders; drives milestones. */
  sequence: number;
  cartId: string;
  lines: OrderLine[];
  subtotalCents: Cents;
  discount: OrderDiscount | null;
  totalCents: Cents;
  paymentId: string | null;
  placedAt: string;
}

/**
 * available -> reserved (held by an in-flight checkout) -> redeemed
 *                  \-> available (checkout failed; coupon released)
 */
export type CouponStatus = 'available' | 'reserved' | 'redeemed';

export interface Coupon {
  code: string;
  /** The order count (k * n) whose achievement unlocked this coupon. */
  milestone: number;
  percent: number;
  status: CouponStatus;
  createdAt: string;
  redeemedByOrderId: string | null;
  redeemedAt: string | null;
}
