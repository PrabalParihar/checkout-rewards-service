import { randomUUID } from 'node:crypto';
import type { Cents } from './money.js';

export interface ChargeRequest {
  /** Our checkout attempt id, for reconciliation with the provider. */
  reference: string;
  amountCents: Cents;
  /** Forwarded so a real provider can deduplicate retried charges too. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { status: 'succeeded'; paymentId: string }
  | { status: 'declined'; reason: string };

/**
 * The seam where a real provider (Stripe, Adyen, ...) would plug in.
 * `charge` may resolve `declined` (a business outcome) or throw (unknown
 * outcome / provider down).
 */
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/**
 * Always approves after `latencyMs`. The latency is the point: it opens a
 * real window in which other requests run while a checkout is in flight.
 */
export class FakePaymentGateway implements PaymentGateway {
  constructor(private readonly latencyMs = 50) {}

  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return { status: 'succeeded', paymentId: `pay_${randomUUID()}` };
  }
}
