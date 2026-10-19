import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { SEED_PRODUCTS } from './seed.js';
import { createShop } from './shop.js';

const config = loadConfig();
const shop = createShop({
  products: SEED_PRODUCTS,
  rewardEveryNOrders: config.REWARD_EVERY_N_ORDERS,
  discountPercent: config.DISCOUNT_PERCENT,
  paymentLatencyMs: config.PAYMENT_LATENCY_MS,
});
const app = buildApp(shop);

const address = await app.listen({ port: config.PORT, host: config.HOST });
console.log(
  `checkout-rewards-service listening on ${address} ` +
    `(coupon every ${config.REWARD_EVERY_N_ORDERS} orders, ${config.DISCOUNT_PERCENT}% off, payment latency ${config.PAYMENT_LATENCY_MS}ms)`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Stop accepting requests; in-flight checkouts finish before exit.
    void app.close().then(() => process.exit(0));
  });
}
