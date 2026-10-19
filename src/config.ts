import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** n: every n-th successful order unlocks one coupon. */
  REWARD_EVERY_N_ORDERS: z.coerce.number().int().min(1).max(1_000_000).default(5),
  /** x: coupon discount percentage. */
  DISCOUNT_PERCENT: z.coerce.number().int().min(1).max(100).default(10),
  /** Simulated latency of the fake payment provider, so checkouts genuinely overlap. */
  PAYMENT_LATENCY_MS: z.coerce.number().int().min(0).max(10_000).default(50),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
