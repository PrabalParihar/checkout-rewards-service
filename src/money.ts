/**
 * Money rules
 *
 * - Every amount is an integer number of minor units (cents). No floats, ever.
 * - Inputs are bounded (see limits.ts) so every intermediate product stays far
 *   below Number.MAX_SAFE_INTEGER (2^53 - 1); integer arithmetic on JS numbers
 *   is therefore exact and we do not need BigInt.
 * - Percentage discounts are rounded DOWN to the cent: the customer never gets
 *   more than the advertised x%, and the result is deterministic.
 */

export type Cents = number;

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer number of cents, got ${value}`);
  }
  return value;
}

export function lineTotal(unitPriceCents: Cents, quantity: number): Cents {
  return assertCents(unitPriceCents * quantity, 'line total');
}

export function sum(values: readonly Cents[]): Cents {
  return assertCents(values.reduce((acc, v) => acc + v, 0), 'sum');
}

/**
 * floor(amount * percent / 100), computed with integers only.
 * Clamped to [0, amount] so a discount can never make a total negative.
 */
export function percentOf(amountCents: Cents, percent: number): Cents {
  assertCents(amountCents);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`percent must be an integer 0..100, got ${percent}`);
  }
  const scaled = assertCents(amountCents * percent, 'scaled discount');
  // Subtract the remainder first so the division is exact (no float floor).
  const discount = (scaled - (scaled % 100)) / 100;
  return Math.min(discount, amountCents);
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
