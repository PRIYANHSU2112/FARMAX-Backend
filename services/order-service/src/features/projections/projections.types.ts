/** Read model of one product-service variant + its pricing-service price (decimal strings). */
export interface VariantFacts {
  variantId: string;
  productId: string | null;
  sku: string | null;
  name: string | null;
  categoryId: string | null;
  categoryPath: string[];
  brandId: string | null;
  hsnCode: string | null;
  gstRate: string | null;
  sellingPrice: string | null;
  temperatureClass: string;
  isActive: boolean;
  minOrderQty: number;
  /** null = no per-line limit. */
  maxOrderQty: number | null;
  isPrescriptionRequired: boolean;
  /** inventory-service sellable quantity; null = unknown (never blocks). */
  availableQty: number | null;
  /** False while only a price has arrived. */
  hasFacts: boolean;
}

/** Read model of one farm-service farm (farm.facts_changed.v1). */
export interface FarmFacts {
  farmId: string;
  ownerUserId: string;
  farmCode: string | null;
  name: string;
  category: string;
  productionTypes: string[];
  gstin: string | null;
  stateCode: string | null;
  territoryCode: string | null;
  pinCode: string | null;
  status: string;
  sourceVersion: number;
}

/** A variant with everything checkout needs (sellable variant: facts, active, price, HSN, GST rate). */
export type SellableVariant = VariantFacts & {
  productId: string;
  sellingPrice: string;
  hsnCode: string;
  gstRate: string;
};

/** Same rule for the cart, offers and the price preview. */
export const isSellable = (v: VariantFacts | undefined): v is SellableVariant =>
  v !== undefined &&
  v.hasFacts &&
  v.isActive &&
  v.productId !== null &&
  v.sellingPrice !== null &&
  v.hsnCode !== null &&
  v.gstRate !== null;
