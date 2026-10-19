import type { Product } from './types.js';

/** Fictional catalog. `limited-print` and `desk-lamp` exist to exercise stock-outs. */
export const SEED_PRODUCTS: readonly Product[] = [
  { id: 'notebook', name: 'Dot-Grid Notebook', unitPriceCents: 1299, stock: 100 },
  { id: 'pen', name: 'Gel Pen (3-pack)', unitPriceCents: 499, stock: 250 },
  { id: 'mug', name: 'Ceramic Mug', unitPriceCents: 1850, stock: 40 },
  { id: 'desk-lamp', name: 'LED Desk Lamp', unitPriceCents: 4999, stock: 3 },
  { id: 'limited-print', name: 'Signed Limited Print', unitPriceCents: 12000, stock: 1 },
];
