import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatUsd, lineTotal, percentOf, sum } from '../src/money.js';

describe('money', () => {
  it('multiplies and sums exactly in integer cents', () => {
    // The classic float trap: 0.1 + 0.2 !== 0.3. In cents it is exact.
    assert.equal(sum([10, 20]), 30);
    assert.equal(lineTotal(1299, 3), 3897);
  });

  it('rounds percentage discounts down to the cent', () => {
    assert.equal(percentOf(1299, 10), 129); // 129.9 -> 129
    assert.equal(percentOf(1, 10), 0); // never over-discount
    assert.equal(percentOf(1000, 15), 150);
  });

  it('never discounts more than the amount', () => {
    assert.equal(percentOf(4999, 100), 4999);
    assert.equal(percentOf(0, 50), 0);
  });

  it('is exact at the largest amount the input limits allow', () => {
    const maxSubtotal = 50 * 1_000 * 10_000_000; // see limits.ts
    assert.equal(percentOf(maxSubtotal + 99, 33), 165_000_000_032);
  });

  it('rejects non-integer or negative inputs', () => {
    assert.throws(() => lineTotal(10.5, 1), RangeError);
    assert.throws(() => percentOf(-1, 10), RangeError);
    assert.throws(() => percentOf(100, 101), RangeError);
  });

  it('formats for humans', () => {
    assert.equal(formatUsd(123456), '$1234.56');
    assert.equal(formatUsd(5), '$0.05');
  });
});
