/**
 * Hard input bounds. They exist so that money arithmetic provably stays inside
 * Number.MAX_SAFE_INTEGER (see money.ts):
 *   max subtotal = MAX_CART_LINES * MAX_QUANTITY * MAX_UNIT_PRICE_CENTS = 5e11
 *   x 100 (percent scaling)                                            = 5e13  < 9e15
 */
export const MAX_QUANTITY = 1_000;
export const MAX_CART_LINES = 50;
export const MAX_UNIT_PRICE_CENTS = 10_000_000; // $100,000.00
export const MAX_STOCK = 1_000_000;
