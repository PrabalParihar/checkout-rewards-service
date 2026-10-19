/**
 * One error type for every expected business failure. The HTTP layer maps it
 * to `{ error: { code, message, details } }` with `status`. Anything that is
 * not an AppError is a bug and becomes a 500.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PRODUCT_NOT_FOUND'
  | 'CART_NOT_FOUND'
  | 'ITEM_NOT_IN_CART'
  | 'ORDER_NOT_FOUND'
  | 'CART_EMPTY'
  | 'CART_LIMIT_EXCEEDED'
  | 'CART_CHECKOUT_IN_PROGRESS'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'INSUFFICIENT_STOCK'
  | 'QUOTE_CHANGED'
  | 'COUPON_INVALID'
  | 'COUPON_IN_USE'
  | 'COUPON_ALREADY_REDEEMED'
  | 'NO_ELIGIBLE_MILESTONE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PAYMENT_DECLINED'
  | 'PAYMENT_FAILED';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  PAYMENT_DECLINED: 402,
  PRODUCT_NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  ITEM_NOT_IN_CART: 404,
  ORDER_NOT_FOUND: 404,
  // 409: the request is well-formed but conflicts with current state.
  CART_EMPTY: 409,
  CART_LIMIT_EXCEEDED: 409,
  CART_CHECKOUT_IN_PROGRESS: 409,
  CART_ALREADY_CHECKED_OUT: 409,
  INSUFFICIENT_STOCK: 409,
  QUOTE_CHANGED: 409,
  COUPON_IN_USE: 409,
  COUPON_ALREADY_REDEEMED: 409,
  NO_ELIGIBLE_MILESTONE: 409,
  // 422: syntactically valid, semantically unusable.
  COUPON_INVALID: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  PAYMENT_FAILED: 502,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
