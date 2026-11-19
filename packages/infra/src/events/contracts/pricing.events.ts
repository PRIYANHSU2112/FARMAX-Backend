/**
 * Event contracts PUBLISHED by pricing-service (future; contract fixed now so product-service can
 * consume it). Consumers: product-service (read-only price projection for listings).
 */
import type { EventEnvelope } from '../envelope.js';

export const PRICING_EVENTS = {
  priceChanged: 'pricing.price_changed.v1',
} as const;

export type PricingEventType = (typeof PRICING_EVENTS)[keyof typeof PRICING_EVENTS];

/** Base selling price of one variant (volume tiers / territory prices stay in pricing-service). */
export interface PriceChangedV1 {
  variantId: string;
  /** Decimal string, e.g. "1150.00". */
  sellingPrice: string;
  currency: 'INR';
  effectiveFrom: string;
  /** Monotonic per variant. */
  sequence: number;
}

export interface PricingEventMap {
  'pricing.price_changed.v1': PriceChangedV1;
}

export type PricingEvent<T extends PricingEventType = PricingEventType> = EventEnvelope<
  T,
  PricingEventMap[T]
>;
