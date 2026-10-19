import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from './errors.js';
import { MAX_QUANTITY, MAX_STOCK, MAX_UNIT_PRICE_CENTS } from './limits.js';
import type { Shop } from './shop.js';

// ---- Request schemas ------------------------------------------------------
const id = z.string().min(1).max(128);
const quantity = z.number().int().min(1).max(MAX_QUANTITY);
const cartParams = z.object({ cartId: id });
const itemParams = z.object({ cartId: id, productId: id });
const addItemBody = z.object({ productId: id, quantity }).strict();
const setQuantityBody = z.object({ quantity }).strict();
const checkoutBody = z
  .object({
    couponCode: z.string().min(1).max(64).optional(),
    expectedTotalCents: z.number().int().min(0).optional(),
  })
  .strict();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_\-:.]{1,128}$/, 'must be 1-128 chars of [A-Za-z0-9_-:.]');
const productPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    unitPriceCents: z.number().int().min(0).max(MAX_UNIT_PRICE_CENTS).optional(),
    stock: z.number().int().min(0).max(MAX_STOCK).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function buildApp(shop: Shop): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  // Treat an empty JSON body as {} so bodiless POSTs (create cart, generate
  // coupon, checkout without coupon) work from any client.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('VALIDATION_ERROR', 'Body is not valid JSON'), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (isAppError(err)) {
      if (err.code === 'PAYMENT_PENDING') reply.header('Retry-After', '5');
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Fastify's own client errors: malformed JSON, wrong content type, too large.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'VALIDATION_ERROR', message: (err as Error).message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: `No route ${req.method} ${req.url}` } }),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  // ---- Shopper API --------------------------------------------------------
  app.get('/products', async () => shop.catalog.list());

  app.post('/carts', async (_req, reply) => {
    const cart = shop.carts.create();
    return reply.status(201).header('Location', `/carts/${cart.id}`).send(cart);
  });

  app.get('/carts/:cartId', async (req) => shop.carts.view(parse(cartParams, req.params).cartId));

  app.post('/carts/:cartId/items', async (req) => {
    const { cartId } = parse(cartParams, req.params);
    const body = parse(addItemBody, req.body);
    return shop.carts.addItem(cartId, body.productId, body.quantity);
  });

  app.put('/carts/:cartId/items/:productId', async (req) => {
    const { cartId, productId } = parse(itemParams, req.params);
    return shop.carts.setQuantity(cartId, productId, parse(setQuantityBody, req.body).quantity);
  });

  app.delete('/carts/:cartId/items/:productId', async (req) => {
    const { cartId, productId } = parse(itemParams, req.params);
    return shop.carts.removeItem(cartId, productId);
  });

  app.post('/carts/:cartId/checkout', async (req, reply) => {
    const { cartId } = parse(cartParams, req.params);
    const rawKey = req.headers['idempotency-key'];
    if (rawKey === undefined) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header so the checkout can be retried safely');
    }
    const key = parse(idempotencyKey, rawKey);
    const body = parse(checkoutBody, req.body);

    const { order, replayed } = await shop.checkout.checkout({ cartId, idempotencyKey: key, ...body });
    return reply
      .status(replayed ? 200 : 201)
      .header('Location', `/orders/${order.id}`)
      .header('Idempotent-Replayed', String(replayed))
      .send(order);
  });

  app.get('/orders/:orderId', async (req) => shop.checkout.getOrder(parse(z.object({ orderId: id }), req.params).orderId));

  // ---- Admin API (unauthenticated in this exercise; see DECISIONS.md) -----
  app.get('/admin/orders', async () => shop.checkout.listOrders());

  app.patch('/admin/products/:productId', async (req) => {
    const { productId } = parse(z.object({ productId: id }), req.params);
    return shop.catalog.update(productId, parse(productPatch, req.body));
  });

  app.post('/admin/coupons', async (_req, reply) => reply.status(201).send(shop.coupons.generate()));
  app.get('/admin/coupons', async () => shop.coupons.list());
  app.get('/admin/report', async () => shop.report.build());

  return app;
}
