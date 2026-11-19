/**
 * Event contracts PUBLISHED by product-service (producer-owned, docs/event-contracts.md).
 * Consumers: inventory-service (inventory items), logistics master sync (FR-PRD-001), search,
 * order-service (variant read model for offers and GST).
 */
import type { EventEnvelope } from '../envelope.js';

export const PRODUCT_EVENT_SOURCE = 'product-service';

export const PRODUCT_EVENTS = {
  variantCreated: 'product.variant_created.v1',
  variantUpdated: 'product.variant_updated.v1',
  variantDeactivated: 'product.variant_deactivated.v1',
  productPublished: 'product.published.v1',
  productSuspended: 'product.suspended.v1',
} as const;

export type ProductEventType = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];

export type TemperatureClassV1 = 'AMB' | 'AMB_CTL' | 'CC_REF' | 'CC_FRZ' | 'HAZ';

/** Everything a stock / logistics system needs about one sellable pack. */
export interface VariantFactsV1 {
  variantId: string;
  productId: string;
  sku: string;
  barcode: string | null;
  productName: string;
  variantName: string;
  manufacturerName: string | null;
  packSize: string;
  packUnit: string;
  isPrescriptionRequired: boolean;
  temperatureClass: TemperatureClassV1;
  shelfLifeMonths: number | null;
  isActive: boolean;
  /** catalog-service category of the product (plain id). */
  categoryId: string;
  /** Category ids root → self (for "category including sub-categories" offers). */
  categoryPath: string[];
  brandId: string;
  /** GST: HSN code and rate (decimal string, e.g. "18.00"); null until the catalogue team sets them. */
  hsnCode: string | null;
  gstRate: string | null;
  /** Purchase limits per order line (cart / checkout). `maxOrderQty` null = no limit. */
  minOrderQty: number;
  maxOrderQty: number | null;
  /** Variant row version (monotonic) — consumers ignore older updates. */
  version: number;
}

export type VariantCreatedV1 = VariantFactsV1;
export type VariantUpdatedV1 = VariantFactsV1;

export interface VariantDeactivatedV1 {
  variantId: string;
  productId: string;
  version: number;
}

export interface ProductStatusChangedV1 {
  productId: string;
  variantIds: string[];
  reason: string | null;
}

export interface ProductEventMap {
  'product.variant_created.v1': VariantCreatedV1;
  'product.variant_updated.v1': VariantUpdatedV1;
  'product.variant_deactivated.v1': VariantDeactivatedV1;
  'product.published.v1': ProductStatusChangedV1;
  'product.suspended.v1': ProductStatusChangedV1;
}

export type ProductEvent<T extends ProductEventType = ProductEventType> = EventEnvelope<
  T,
  ProductEventMap[T]
>;
