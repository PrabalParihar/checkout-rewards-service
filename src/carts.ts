import { AppError } from './errors.js';
import { MAX_CART_LINES, MAX_QUANTITY } from './limits.js';
import { lineTotal, sum, type Cents } from './money.js';
import type { Store } from './store.js';
import type { Cart, CartStatus } from './types.js';

export interface CartLineView {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceCents: Cents;
  lineTotalCents: Cents;
  /** True when the current price differs from the price when the item was added. */
  priceChanged: boolean;
  priceWhenAddedCents: Cents;
  /** Units currently sellable; may be below `quantity` if stock moved. */
  availableStock: number;
}

export interface CartView {
  id: string;
  status: CartStatus;
  orderId: string | null;
  lines: CartLineView[];
  /** Live quote at current prices. The binding amount is the order's total. */
  subtotalCents: Cents;
  /** Lines that would fail checkout right now (stock moved since adding). */
  issues: { productId: string; code: 'INSUFFICIENT_STOCK'; requested: number; available: number }[];
  createdAt: string;
  updatedAt: string;
}

export class CartService {
  constructor(private readonly store: Store) {}

  create(): CartView {
    const now = this.store.timestamp();
    const cart: Cart = { id: this.store.newId(), status: 'open', lines: new Map(), orderId: null, createdAt: now, updatedAt: now };
    this.store.carts.set(cart.id, cart);
    return this.view(cart.id);
  }

  view(cartId: string): CartView {
    const cart = this.find(cartId);
    if (cart.status === 'checked_out' && cart.orderId) {
      // A closed cart is described by its order snapshot, not today's catalog.
      const order = this.store.orders.get(cart.orderId)!;
      return {
        ...this.header(cart),
        lines: order.lines.map((l) => ({
          ...l,
          priceChanged: false,
          priceWhenAddedCents: l.unitPriceCents,
          availableStock: this.store.products.get(l.productId)?.stock ?? 0,
        })),
        subtotalCents: order.subtotalCents,
        issues: [],
      };
    }

    const lines: CartLineView[] = [];
    const issues: CartView['issues'] = [];
    for (const line of cart.lines.values()) {
      const product = this.store.products.get(line.productId)!;
      lines.push({
        productId: product.id,
        productName: product.name,
        quantity: line.quantity,
        unitPriceCents: product.unitPriceCents,
        lineTotalCents: lineTotal(product.unitPriceCents, line.quantity),
        priceChanged: product.unitPriceCents !== line.priceWhenAddedCents,
        priceWhenAddedCents: line.priceWhenAddedCents,
        availableStock: product.stock,
      });
      if (cart.status === 'open' && product.stock < line.quantity) {
        issues.push({ productId: product.id, code: 'INSUFFICIENT_STOCK', requested: line.quantity, available: product.stock });
      }
    }
    return { ...this.header(cart), lines, subtotalCents: sum(lines.map((l) => l.lineTotalCents)), issues };
  }

  /** Adds `quantity` units, merging with an existing line for the same product. */
  addItem(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.findEditable(cartId);
    const product = this.store.products.get(productId);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', `Product '${productId}' does not exist`, { productId });

    const existing = cart.lines.get(productId);
    if (!existing && cart.lines.size >= MAX_CART_LINES) {
      throw new AppError('CART_LIMIT_EXCEEDED', `A cart can hold at most ${MAX_CART_LINES} different products`);
    }
    const newQuantity = (existing?.quantity ?? 0) + quantity;
    this.assertQuantity(productId, newQuantity, product.stock);

    cart.lines.set(productId, { productId, quantity: newQuantity, priceWhenAddedCents: product.unitPriceCents });
    return this.touch(cart);
  }

  /** Sets the absolute quantity of a line that is already in the cart. */
  setQuantity(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.findEditable(cartId);
    const line = cart.lines.get(productId);
    if (!line) throw new AppError('ITEM_NOT_IN_CART', `Product '${productId}' is not in this cart`, { productId });
    const product = this.store.products.get(productId)!;
    this.assertQuantity(productId, quantity, product.stock);
    line.quantity = quantity;
    return this.touch(cart);
  }

  removeItem(cartId: string, productId: string): CartView {
    const cart = this.findEditable(cartId);
    if (!cart.lines.delete(productId)) {
      throw new AppError('ITEM_NOT_IN_CART', `Product '${productId}' is not in this cart`, { productId });
    }
    return this.touch(cart);
  }

  find(cartId: string): Cart {
    const cart = this.store.carts.get(cartId);
    if (!cart) throw new AppError('CART_NOT_FOUND', `Cart '${cartId}' does not exist`, { cartId });
    return cart;
  }

  private findEditable(cartId: string): Cart {
    const cart = this.find(cartId);
    if (cart.status === 'checking_out') {
      throw new AppError('CART_CHECKOUT_IN_PROGRESS', 'Cart is being checked out and cannot be edited', { cartId });
    }
    if (cart.status === 'checked_out') {
      throw new AppError('CART_ALREADY_CHECKED_OUT', 'Cart has already been checked out', { cartId, orderId: cart.orderId });
    }
    return cart;
  }

  /**
   * Quantities are validated against stock at edit time to give early
   * feedback, but nothing is reserved: checkout re-validates authoritatively.
   */
  private assertQuantity(productId: string, quantity: number, stock: number): void {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new AppError('VALIDATION_ERROR', `Quantity must be an integer between 1 and ${MAX_QUANTITY}`, { productId, quantity });
    }
    if (quantity > stock) {
      throw new AppError('INSUFFICIENT_STOCK', `Only ${stock} unit(s) of '${productId}' available`, { productId, requested: quantity, available: stock });
    }
  }

  private touch(cart: Cart): CartView {
    cart.updatedAt = this.store.timestamp();
    return this.view(cart.id);
  }

  private header(cart: Cart) {
    return { id: cart.id, status: cart.status, orderId: cart.orderId, createdAt: cart.createdAt, updatedAt: cart.updatedAt };
  }
}
