import { formatRupees, fromPaise, isColdChain, toPaise } from '../pricing/index.js';
import { type VariantFacts, isSellable } from '../projections/index.js';
import type { CartNotice, CartRow } from './cart.types.js';

/** Hard cap per line when the variant has no max order qty (same bound as the validation). */
export const HARD_MAX_QTY = 100_000;

export interface CartLineView {
  variantId: string;
  sku: string | null;
  name: string | null;
  qty: number;
  /** Current unit price (list price; tiers / membership come with pricing-service). null = not sellable. */
  unitPrice: string | null;
  /** Unit price when the line was last written. */
  unitPriceSnapshot: string | null;
  /** qty × current unit price, before offers and GST. */
  lineTotal: string | null;
  sellable: boolean;
  temperatureClass: string;
  coldChain: boolean;
  prescriptionRequired: boolean;
  minOrderQty: number;
  maxOrderQty: number | null;
  /** null = stock unknown (inventory-service not reporting yet). */
  availableQty: number | null;
}

const money = (paise: number) => fromPaise(paise);

/** Notices that stop checkout (the others are informational). */
const BLOCKING = new Set<CartNotice['code']>([
  'NOT_SELLABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'ABOVE_MAX_QTY',
  'BELOW_MIN_QTY',
]);

/**
 * Revalidates every line against the projections (FR-SHP-05: price and availability at load, with
 * a notice for anything that changed since the item was added). Pure: no I/O.
 */
export function buildCartLines(cart: CartRow | null, byId: ReadonlyMap<string, VariantFacts>) {
  const lines: CartLineView[] = [];
  const notices: CartNotice[] = [];
  let subtotal = 0;
  let totalQty = 0;
  let cold = 0;
  let ambient = 0;

  for (const l of cart?.lines ?? []) {
    const v = byId.get(l.variantId);
    const sellable = isSellable(v);
    const price = sellable ? v.sellingPrice : null;
    const lineTotal = price === null ? null : toPaise(price) * l.qty;
    totalQty += l.qty;
    if (lineTotal !== null) subtotal += lineTotal;
    const coldChain = v !== undefined && isColdChain(v.temperatureClass);
    if (coldChain) cold += 1;
    else ambient += 1;

    lines.push({
      variantId: l.variantId,
      sku: v?.sku ?? null,
      name: v?.name ?? null,
      qty: l.qty,
      unitPrice: price,
      unitPriceSnapshot: l.unitPriceSnapshot,
      lineTotal: lineTotal === null ? null : money(lineTotal),
      sellable,
      temperatureClass: v?.temperatureClass ?? 'AMB',
      coldChain,
      prescriptionRequired: v?.isPrescriptionRequired ?? false,
      minOrderQty: v?.minOrderQty ?? 1,
      maxOrderQty: v?.maxOrderQty ?? null,
      availableQty: v?.availableQty ?? null,
    });

    const id = l.variantId;
    if (!sellable) {
      notices.push({
        code: 'NOT_SELLABLE',
        variantId: id,
        message: 'This item is no longer available for sale. Remove it to continue.',
      });
      continue;
    }
    if (l.unitPriceSnapshot !== null && toPaise(l.unitPriceSnapshot) !== toPaise(v.sellingPrice)) {
      const up = toPaise(v.sellingPrice) > toPaise(l.unitPriceSnapshot);
      notices.push({
        code: 'PRICE_CHANGED',
        variantId: id,
        from: l.unitPriceSnapshot,
        to: v.sellingPrice,
        message: `Price ${up ? 'increased' : 'dropped'} from ${formatRupees(toPaise(l.unitPriceSnapshot))} to ${formatRupees(toPaise(v.sellingPrice))} since you added it.`,
      });
    }
    if (v.availableQty !== null && v.availableQty <= 0) {
      notices.push({
        code: 'OUT_OF_STOCK',
        variantId: id,
        limit: 0,
        message: 'Out of stock right now.',
      });
    } else if (v.availableQty !== null && v.availableQty < l.qty) {
      notices.push({
        code: 'INSUFFICIENT_STOCK',
        variantId: id,
        limit: v.availableQty,
        message: `Only ${String(v.availableQty)} available. Reduce the quantity to continue.`,
      });
    }
    if (v.maxOrderQty !== null && l.qty > v.maxOrderQty) {
      notices.push({
        code: 'ABOVE_MAX_QTY',
        variantId: id,
        limit: v.maxOrderQty,
        message: `Maximum ${String(v.maxOrderQty)} per order.`,
      });
    }
    if (l.qty < v.minOrderQty) {
      notices.push({
        code: 'BELOW_MIN_QTY',
        variantId: id,
        limit: v.minOrderQty,
        message: `Minimum ${String(v.minOrderQty)} per order.`,
      });
    }
    if (v.isPrescriptionRequired) {
      notices.push({
        code: 'PRESCRIPTION_REQUIRED',
        variantId: id,
        message: 'Needs a valid prescription for this farm at checkout.',
      });
    }
  }

  return {
    lines,
    notices,
    totalQty,
    itemSubtotal: money(subtotal),
    consignments: {
      coldChainLines: cold,
      ambientLines: ambient,
      /** FR-SHP-07: cold and ambient lines travel as separate consignments. */
      separateDeliveries: cold > 0 && ambient > 0,
    },
    checkoutBlocked: notices.some((n) => BLOCKING.has(n.code)),
  };
}
