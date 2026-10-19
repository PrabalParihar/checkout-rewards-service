import { randomUUID } from 'node:crypto';
import type { Cents } from './money.js';

export interface ChargeRequest {
  /** Our checkout attempt id, for reconciliation with the provider. */
  reference: string;
  amountCents: Cents;
  /** The provider deduplicates charges by this key, so retrying is safe. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { status: 'succeeded'; paymentId: string }
  | { status: 'declined'; reason: string };

/**
 * The seam where a real provider (Stripe, Adyen, ...) plugs in.
 *
 * `charge` resolves with a definite outcome, or throws when the outcome is
 * unknown (timeout, network error): the charge may or may not have happened.
 * `getCharge` asks the provider what happened to a charge with this key:
 * a result, `null` if the provider never received it, or a throw if it
 * cannot answer right now.
 */
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  getCharge(idempotencyKey: string): Promise<ChargeResult | null>;
}

/**
 * Always approves after `latencyMs`. The latency is the point: it opens a
 * real window in which other requests run while a checkout is in flight.
 */
export class FakePaymentGateway implements PaymentGateway {
  private readonly charges = new Map<string, ChargeResult>();

  constructor(private readonly latencyMs = 50) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const existing = this.charges.get(request.idempotencyKey);
    if (existing) return existing;
    const result: ChargeResult = { status: 'succeeded', paymentId: `pay_${randomUUID()}` };
    this.charges.set(request.idempotencyKey, result);
    return result;
  }

  async getCharge(idempotencyKey: string): Promise<ChargeResult | null> {
    return this.charges.get(idempotencyKey) ?? null;
  }
}
