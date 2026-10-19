import { normalizeCode, type CouponService } from './coupons.js';
import { AppError } from './errors.js';
import { lineTotal, percentOf, sum, type Cents } from './money.js';
import type { PaymentGateway } from './payment.js';
import type { Store } from './store.js';
import type { Cart, Coupon, Order, OrderDiscount, OrderLine } from './types.js';

export interface CheckoutRequest {
  cartId: string;
  idempotencyKey: string;
  couponCode?: string;
  /**
   * Optional optimistic check: the total the client displayed. If the server
   * computes something else (price changed, coupon differs) checkout fails
   * with QUOTE_CHANGED instead of charging an amount the customer never saw.
   */
  expectedTotalCents?: number;
}

export interface CheckoutResult {
  order: Order;
  /** True when this response is a replay of an earlier/in-flight attempt. */
  replayed: boolean;
}

/** Everything a checkout holds between "reserve" and "commit or release". */
interface Reservation {
  attemptId: string;
  cart: Cart;
  lines: OrderLine[];
  subtotalCents: Cents;
  coupon: Coupon | null;
  discount: OrderDiscount | null;
  totalCents: Cents;
}

type IdempotencyRecord =
  | { state: 'in_progress'; fingerprint: string; promise: Promise<Order> }
  | { state: 'completed'; fingerprint: string; orderId: string };

/**
 * Checkout = reserve (sync) -> charge (async) -> commit | release (sync).
 *
 * The two synchronous blocks are atomic with respect to other requests
 * because they contain no `await`. While the charge is pending, the cart is
 * `checking_out` and stock is already deducted, so a competing checkout sees
 * the reduced stock and cannot oversell.
 */
export class CheckoutService {
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly store: Store,
    private readonly payment: PaymentGateway,
    private readonly coupons: CouponService,
  ) {}

  async checkout(req: CheckoutRequest): Promise<CheckoutResult> {
    const couponCode = req.couponCode === undefined ? null : normalizeCode(req.couponCode);
    const fingerprint = JSON.stringify([req.cartId, couponCode, req.expectedTotalCents ?? null]);

    // --- Idempotency (sync) -------------------------------------------------
    const previous = this.idempotency.get(req.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different checkout request');
      }
      if (previous.state === 'completed') {
        return { order: this.store.orders.get(previous.orderId)!, replayed: true };
      }
      // Same request still in flight: share its outcome (success or error).
      return { order: await previous.promise, replayed: true };
    }

    // --- Reserve (sync; throws before mutating anything) --------------------
    const reservation = this.reserve(req);

    // --- Charge + commit/release (async) ------------------------------------
    const promise = this.complete(reservation, req.idempotencyKey);
    this.idempotency.set(req.idempotencyKey, { state: 'in_progress', fingerprint, promise });
    try {
      const order = await promise;
      this.idempotency.set(req.idempotencyKey, { state: 'completed', fingerprint, orderId: order.id });
      return { order, replayed: false };
    } catch (err) {
      // Failed attempts are not remembered: the client may fix the cause and
      // retry with the same key.
      this.idempotency.delete(req.idempotencyKey);
      throw err;
    }
  }

  getOrder(orderId: string): Order {
    const order = this.store.orders.get(orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', `Order '${orderId}' does not exist`, { orderId });
    return order;
  }

  listOrders(): Order[] {
    return [...this.store.orders.values()];
  }

  private reserve(req: CheckoutRequest): Reservation {
    const cart = this.store.carts.get(req.cartId);
    if (!cart) throw new AppError('CART_NOT_FOUND', `Cart '${req.cartId}' does not exist`, { cartId: req.cartId });
    if (cart.status === 'checked_out') {
      throw new AppError('CART_ALREADY_CHECKED_OUT', 'Cart has already been checked out', { cartId: cart.id, orderId: cart.orderId });
    }
    if (cart.status === 'checking_out') {
      throw new AppError('CART_CHECKOUT_IN_PROGRESS', 'Another checkout for this cart is in progress', { cartId: cart.id });
    }
    if (cart.lines.size === 0) throw new AppError('CART_EMPTY', 'Cannot check out an empty cart', { cartId: cart.id });

    // Price at checkout time (live price), snapshot into order lines.
    const lines: OrderLine[] = [];
    const shortages: { productId: string; requested: number; available: number }[] = [];
    for (const line of cart.lines.values()) {
      const product = this.store.products.get(line.productId)!;
      if (product.stock < line.quantity) {
        shortages.push({ productId: product.id, requested: line.quantity, available: product.stock });
      }
      lines.push({
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: lineTotal(product.unitPriceCents, line.quantity),
      });
    }
    if (shortages.length > 0) {
      throw new AppError('INSUFFICIENT_STOCK', 'Not enough stock for one or more items', { items: shortages });
    }

    const subtotalCents = sum(lines.map((l) => l.lineTotalCents));

    // Coupon: validated here, reserved below, redeemed only on commit.
    const coupon = req.couponCode === undefined ? null : this.coupons.findRedeemable(req.couponCode);
    const discount: OrderDiscount | null = coupon && {
      couponCode: coupon.code,
      percent: coupon.percent,
      amountCents: percentOf(subtotalCents, coupon.percent),
    };
    const totalCents = subtotalCents - (discount?.amountCents ?? 0);
    if (req.expectedTotalCents !== undefined && req.expectedTotalCents !== totalCents) {
      throw new AppError('QUOTE_CHANGED', 'The order total changed since it was quoted', {
        expectedTotalCents: req.expectedTotalCents,
        actualTotalCents: totalCents,
      });
    }

    // All checks passed: take the reservation. Nothing above mutated state.
    for (const line of lines) this.store.products.get(line.productId)!.stock -= line.quantity;
    if (coupon) coupon.status = 'reserved';
    cart.status = 'checking_out';

    return { attemptId: this.store.newId(), cart, lines, subtotalCents, coupon, discount, totalCents };
  }

  private async complete(r: Reservation, idempotencyKey: string): Promise<Order> {
    let paymentId: string | null = null;
    if (r.totalCents > 0) {
      let result;
      try {
        result = await this.payment.charge({ reference: r.attemptId, amountCents: r.totalCents, idempotencyKey });
      } catch (err) {
        this.release(r);
        throw new AppError('PAYMENT_FAILED', 'Payment provider error; nothing was charged by this service', {
          cause: err instanceof Error ? err.message : String(err),
        });
      }
      if (result.status === 'declined') {
        this.release(r);
        throw new AppError('PAYMENT_DECLINED', `Payment declined: ${result.reason}`);
      }
      paymentId = result.paymentId;
    }
    return this.commit(r, paymentId);
  }

  /** Sync: turn the reservation into a placed order. */
  private commit(r: Reservation, paymentId: string | null): Order {
    const order: Order = {
      id: this.store.newId(),
      sequence: this.store.orders.size + 1,
      cartId: r.cart.id,
      lines: r.lines,
      subtotalCents: r.subtotalCents,
      discount: r.discount,
      totalCents: r.totalCents,
      paymentId,
      placedAt: this.store.timestamp(),
    };
    this.store.orders.set(order.id, order);
    if (r.coupon) {
      r.coupon.status = 'redeemed';
      r.coupon.redeemedByOrderId = order.id;
      r.coupon.redeemedAt = order.placedAt;
    }
    r.cart.status = 'checked_out';
    r.cart.orderId = order.id;
    return order;
  }

  /** Sync: undo every effect of `reserve`. */
  private release(r: Reservation): void {
    for (const line of r.lines) this.store.products.get(line.productId)!.stock += line.quantity;
    if (r.coupon) r.coupon.status = 'available';
    r.cart.status = 'open';
  }
}
