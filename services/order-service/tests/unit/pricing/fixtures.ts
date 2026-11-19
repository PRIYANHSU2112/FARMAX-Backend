import type {
  BuyerContext,
  PricingConfig,
  PricingLine,
  PromoDef,
} from '../../../src/features/pricing/index.js';

/** Test builders. Amounts in paise, percentages in basis points. */

export const CAT = {
  vaccines: '0193a5f2-7c1e-7b2a-9f00-00000000c001',
  biosecurity: '0193a5f2-7c1e-7b2a-9f00-00000000c002',
  feedAdditives: '0193a5f2-7c1e-7b2a-9f00-00000000c003',
  /** Parent of vaccines. */
  animalHealth: '0193a5f2-7c1e-7b2a-9f00-00000000c000',
};

let seq = 0;
const nextId = () => `0193a5f2-7c1e-7b2a-9f00-${String(++seq).padStart(12, '0')}`;

export function line(over: Partial<PricingLine> & { unitPrice: number; qty: number }): PricingLine {
  const variantId = over.variantId ?? nextId();
  return {
    variantId,
    productId: over.productId ?? variantId,
    sku: over.sku ?? `SKU-${variantId.slice(-4)}`,
    name: over.name ?? 'Item',
    categoryId: over.categoryId ?? CAT.feedAdditives,
    categoryPath: over.categoryPath ?? [],
    brandId: over.brandId ?? null,
    priceSource: 'LIST',
    hsnCode: over.hsnCode ?? '3002',
    gstRate: over.gstRate ?? 500,
    temperatureClass: over.temperatureClass ?? 'AMB',
    ...over,
  };
}

export function promo(over: Partial<PromoDef> & Pick<PromoDef, 'kind' | 'benefitType'>): PromoDef {
  return {
    id: over.id ?? nextId(),
    code: null,
    title: 'Offer',
    subtitle: null,
    badgeText: null,
    flatAmount: null,
    percentage: null,
    maxDiscountAmount: null,
    comboBuyQty: null,
    comboGetQty: null,
    comboGetPercent: null,
    bundlePrice: null,
    freeShipping: false,
    scope: 'PLATFORM_WIDE',
    targets: [],
    rules: [],
    minOrderAmount: 0,
    startAt: new Date('2026-01-01T00:00:00Z'),
    endAt: new Date('2027-01-01T00:00:00Z'),
    status: 'ACTIVE',
    isAutoApply: false,
    isStackable: false,
    priority: 0,
    totalUsageLimit: null,
    perFarmLimit: null,
    perUserLimit: null,
    usedCount: 0,
    accountType: 'ALL',
    farmHistory: 'ALL',
    paymentMethod: 'ANY',
    isMemberOnly: false,
    ...over,
  };
}

export function buyer(over: Partial<BuyerContext> = {}): BuyerContext {
  return {
    farmId: '0193a5f2-7c1e-7b2a-9f00-0000000000f1',
    userId: '0193a5f2-7c1e-7b2a-9f00-0000000000a1',
    gstin: '37ABCDE1234F1Z5',
    farmCategory: 'POULTRY_FARM',
    productionTypes: ['LAYER'],
    stateCode: '37',
    territoryCode: 'WG',
    pinCode: '534211',
    farmOrderCount: 0,
    isMember: false,
    paymentMethod: 'UPI',
    bankCode: null,
    cardBin: null,
    usage: new Map(),
    now: new Date('2026-11-17T06:00:00Z'),
    ...over,
  };
}

export const config: PricingConfig = {
  sellerStateCode: '37',
  coldChainFreight: 49_500,
  standardFreight: 0,
  freightGstRate: 1_800,
  freightSacCode: '996511',
};

/** The Figma coupons. */
export const figma = {
  SHED500: () =>
    promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'SHED500',
      title: '₹500 off biosecurity over ₹10,000',
      subtitle: 'Farmer Monsoon Bonus',
      badgeText: 'FREE SHIPPING',
      flatAmount: 50_000,
      freeShipping: true,
      scope: 'CATEGORY',
      targets: [{ targetType: 'CATEGORY', targetId: CAT.biosecurity, bundleQty: null }],
      minOrderAmount: 1_000_000,
      perFarmLimit: 1,
      rules: [
        { ruleType: 'PRODUCTION_TYPE', value: 'LAYER' },
        { ruleType: 'PRODUCTION_TYPE', value: 'BROILER' },
      ],
    }),
  VAX300: () =>
    promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'VAX300',
      title: '₹300 off vaccines over ₹15,000',
      flatAmount: 30_000,
      scope: 'CATEGORY',
      targets: [{ targetType: 'CATEGORY', targetId: CAT.vaccines, bundleQty: null }],
      minOrderAmount: 1_500_000,
    }),
  MONSOON1000: () =>
    promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'MONSOON1000',
      title: '₹1,000 off over ₹30,000',
      flatAmount: 100_000,
      minOrderAmount: 3_000_000,
    }),
  RETAIL50: () =>
    promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'RETAIL50',
      title: '₹50 off for retail buyers',
      flatAmount: 5_000,
      accountType: 'RETAIL',
    }),
  WELCOME30: (stackable = true) =>
    promo({
      kind: 'AUTO_BONUS',
      benefitType: 'FLAT',
      code: null,
      title: 'Welcome Bonus',
      flatAmount: 3_000,
      isAutoApply: true,
      isStackable: stackable,
      farmHistory: 'NEW_FARM',
    }),
};
