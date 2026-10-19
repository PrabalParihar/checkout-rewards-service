import { normalizeCode, type CouponService } from './coupons.js';
import { AppError } from './errors.js';
import { lineTotal, percentOf, sum, type Cents } from './money.js';
import type { ChargeResult, PaymentGateway } from './payment.js';
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

/**
 * in_progress      -> an attempt is running; retries join its promise
 * payment_unknown  -> the provider could not confirm the charge; the
 *                     reservation stays held until a retry or the
 *                     maintenance pass learns the outcome
 * completed        -> replay the order until `expiresAt`
 * Failed attempts have no record, so the key can be reused after a fix.
 */
type IdempotencyRecord =
  | { state: 'in_progress'; fingerprint: string; promise: Promise<Order> }
  | { state: 'payment_unknown'; fingerprint: string; reservation: Reservation }
  | { state: 'completed'; fingerprint: string; orderId: string; expiresAt: number };

/** What the provider told us about a charge, including "we don't know". */
type ChargeOutcome = ChargeResult | { status: 'not_charged' } | { status: 'unknown' };

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
    private readonly idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  ) {}

  async checkout(req: CheckoutRequest): Promise<CheckoutResult> {
    const couponCode = req.couponCode === undefined ? null : normalizeCode(req.couponCode);
    const fingerprint = JSON.stringify([req.cartId, couponCode, req.expectedTotalCents ?? null]);

    // --- Idempotency (sync) -------------------------------------------------
    const previous = this.currentRecord(req.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different checkout request');
      }
      switch (previous.state) {
        case 'completed':
          return { order: this.store.orders.get(previous.orderId)!, replayed: true };
        case 'in_progress':
          // Same request still in flight: share its outcome (success or error).
          return { order: await previous.promise, replayed: true };
        case 'payment_unknown':
          // Ask the provider again instead of charging again.
          return this.run(req.idempotencyKey, fingerprint, previous.reservation, () => this.reconcile(previous.reservation, req.idempotencyKey));
      }
    }

    // --- Reserve (sync; throws before mutating anything) --------------------
    const reservation = this.reserve(req);

    // --- Charge + commit/release (async) ------------------------------------
    return this.run(req.idempotencyKey, fingerprint, reservation, () => this.complete(reservation, req.idempotencyKey));
  }

  /**
   * Background pass (run on an interval by the server): settles checkouts
   * whose payment outcome was unknown, and forgets expired idempotency keys.
   */
  async runMaintenance(): Promise<void> {
    const now = this.store.now().getTime();
    const settling: Promise<unknown>[] = [];
    for (const [key, record] of this.idempotency) {
      if (record.state === 'completed' && record.expiresAt <= now) this.idempotency.delete(key);
      if (record.state === 'payment_unknown') {
        const { fingerprint, reservation } = record;
        settling.push(this.run(key, fingerprint, reservation, () => this.reconcile(reservation, key)).catch(() => undefined));
      }
    }
    await Promise.all(settling);
  }

  /** Records the attempt under its key and stores its outcome. */
  private async run(key: string, fingerprint: string, reservation: Reservation, work: () => Promise<Order>): Promise<CheckoutResult> {
    const promise = work();
    this.idempotency.set(key, { state: 'in_progress', fingerprint, promise });
    try {
      const order = await promise;
      const expiresAt = this.store.now().getTime() + this.idempotencyTtlMs;
      this.idempotency.set(key, { state: 'completed', fingerprint, orderId: order.id, expiresAt });
      return { order, replayed: false };
    } catch (err) {
      if (err instanceof AppError && err.code === 'PAYMENT_PENDING') {
        this.idempotency.set(key, { state: 'payment_unknown', fingerprint, reservation });
      } else {
        this.idempotency.delete(key);
      }
      throw err;
    }
  }

  private currentRecord(key: string): IdempotencyRecord | undefined {
    const record = this.idempotency.get(key);
    if (record?.state === 'completed' && record.expiresAt <= this.store.now().getTime()) {
      // Expired: the key is free again. The cart is still checked out, so
      // a late retry gets CART_ALREADY_CHECKED_OUT with the orderId.
      this.idempotency.delete(key);
      return undefined;
    }
    return record;
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
    if (r.totalCents === 0) return this.commit(r, null);
    let outcome: ChargeOutcome;
    try {
      outcome = await this.payment.charge({ reference: r.attemptId, amountCents: r.totalCents, idempotencyKey });
    } catch {
      // The charge may or may not have happened. Never guess: ask.
      outcome = await this.lookupCharge(idempotencyKey);
    }
    return this.settle(r, outcome);
  }

  private async reconcile(r: Reservation, idempotencyKey: string): Promise<Order> {
    return this.settle(r, await this.lookupCharge(idempotencyKey));
  }

  private async lookupCharge(idempotencyKey: string): Promise<ChargeOutcome> {
    try {
      return (await this.payment.getCharge(idempotencyKey)) ?? { status: 'not_charged' };
    } catch {
      return { status: 'unknown' };
    }
  }

  /** Sync: apply a payment outcome to the reservation. */
  private settle(r: Reservation, outcome: ChargeOutcome): Order {
    switch (outcome.status) {
      case 'succeeded':
        return this.commit(r, outcome.paymentId);
      case 'declined':
        this.release(r);
        throw new AppError('PAYMENT_DECLINED', `Payment declined: ${outcome.reason}`);
      case 'not_charged':
        this.release(r);
        throw new AppError('PAYMENT_FAILED', 'Payment provider error; the provider confirmed nothing was charged');
      case 'unknown':
        // Keep stock and coupon held: releasing could sell goods that were paid for.
        throw new AppError('PAYMENT_PENDING', 'Payment outcome is not confirmed yet. Retry with the same Idempotency-Key.', {
          cartId: r.cart.id,
        });
    }
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
