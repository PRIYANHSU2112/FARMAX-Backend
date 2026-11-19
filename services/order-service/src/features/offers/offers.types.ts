import type { PaymentMethod } from '../pricing/index.js';

export interface CartLineInput {
  variantId: string;
  qty: number;
}

export interface OffersInput {
  farmId: string;
  lines: CartLineInput[];
  paymentMethod?: PaymentMethod;
  bankCode?: string;
  cardBin?: string;
  couponCode?: string;
  applyBundleIds?: string[];
}

export interface PreviewInput extends OffersInput {
  /** "Bill to this GST entity (claim 100 % ITC)". */
  billToGst: boolean;
}

/** All money in the views is a decimal string ("1420.00"); percentages too ("18.00"). */
export interface OfferCardView {
  promotionId: string;
  code: string | null;
  title: string;
  subtitle: string | null;
  badgeText: string | null;
  validUntil: string;
  conditions: string[];
  freeShipping: boolean;
  saving: string;
}
