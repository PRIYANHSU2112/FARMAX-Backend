/** Who owns the cart: a logged-in customer (JWT user id) or a guest (`X-Cart-Token`). */
export type CartOwner =
  { userId: string; guestToken?: undefined } | { guestToken: string; userId?: undefined };

/** The cart row locked for a write (`SELECT … FOR UPDATE`). */
export interface LockedCart {
  id: string;
  version: number;
  guestToken: string | null;
  couponCode: string | null;
  /** True when this request created the cart (guests: a new token to hand back). */
  created: boolean;
}

export interface CartLineRow {
  variantId: string;
  qty: number;
  /** Decimal string, null when the price was unknown at add time. */
  unitPriceSnapshot: string | null;
}

export interface CartRow {
  id: string;
  userId: string | null;
  guestToken: string | null;
  couponCode: string | null;
  version: number;
  lines: CartLineRow[];
}

/** Result of one line write, read back in the same statement (fresh snapshot, cart locked). */
export interface LineWriteResult {
  /** Quantity before the write (null = no line). */
  current: number | null;
  /** Lines in the cart after the write. */
  lines: number;
  /** Quantity after the write (null = refused, or the line was removed). */
  qty: number | null;
  /** New cart version (null = nothing changed). */
  version: number | null;
}

export interface MergeResult {
  merged: boolean;
  guestLines: number;
  mergedLines: number;
}

export interface AddItemInput {
  variantId: string;
  qty: number;
}

export interface SetItemInput {
  qty: number;
  /** Optimistic concurrency for multi-device edits: 409 CART_VERSION_CONFLICT when stale. */
  expectedVersion?: number;
}

export interface CartQuery {
  /** Farm to price for (offers, GST, freight). Customers only; omitted → list prices only. */
  farmId?: string;
}

export type NoticeCode =
  | 'NOT_SELLABLE'
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'ABOVE_MAX_QTY'
  | 'BELOW_MIN_QTY'
  | 'PRESCRIPTION_REQUIRED';

export interface CartNotice {
  code: NoticeCode;
  variantId: string;
  message: string;
  /** PRICE_CHANGED: old → new unit price; stock / limit notices: the limit. */
  from?: string;
  to?: string;
  limit?: number;
}

/** Response of every write: small, so taps on +/− stay fast. GET /cart has the full view. */
export interface CartWriteView {
  cartId: string;
  cartVersion: number;
  itemCount: number;
  line: { variantId: string; qty: number } | null;
  /** Only when this request created a guest cart: store it and send it as `X-Cart-Token`. */
  guestToken?: string;
}
