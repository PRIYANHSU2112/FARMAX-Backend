import type { BasisPoints, Paise } from './money.js';

/** Pure engine types: plain data in, plain data out (no Prisma, no Decimal, no I/O). */

export type PromoKind = 'LINE_OFFER' | 'ORDER_COUPON' | 'AUTO_BONUS' | 'SHIPPING';
export type BenefitType = 'FLAT' | 'PERCENTAGE' | 'COMBO' | 'BUNDLE_PAIR' | 'FREE_SHIPPING';
export type PromoScope = 'PLATFORM_WIDE' | 'CATEGORY' | 'PRODUCT' | 'VARIANT' | 'BRAND';
export type PromoTargetType = 'CATEGORY' | 'PRODUCT' | 'VARIANT' | 'BRAND';
export type PromoRuleType =
  'PRODUCTION_TYPE' | 'FARM_CATEGORY' | 'STATE' | 'TERRITORY' | 'PINCODE' | 'BANK' | 'CARD_BIN';
export type PromoAccountType = 'ALL' | 'B2B_GST' | 'RETAIL';
export type PromoFarmHistory = 'ALL' | 'NEW_FARM' | 'EXISTING_FARM';
export type PaymentMethod = 'UPI' | 'CARD' | 'NETBANKING';
export type PromoPaymentMethod = 'ANY' | PaymentMethod;
export type PriceSource = 'LIST' | 'TIER' | 'MEMBER';

/** One cart line, already enriched from the variant projection. */
export interface PricingLine {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  categoryId: string | null;
  /** Root → self; empty = exact categoryId only. */
  categoryPath: readonly string[];
  brandId: string | null;
  qty: number;
  /** Phase 0 base price (sellingPrice; tiers / membership come later). */
  unitPrice: Paise;
  priceSource: PriceSource;
  hsnCode: string;
  gstRate: BasisPoints;
  temperatureClass: string;
}

export interface PromoTarget {
  targetType: PromoTargetType;
  targetId: string;
  bundleQty: number | null;
}

export interface PromoRule {
  ruleType: PromoRuleType;
  value: string;
}

/** A live promotion as the engine sees it. Amounts in paise, percentages in bp. */
export interface PromoDef {
  id: string;
  code: string | null;
  title: string;
  subtitle: string | null;
  badgeText: string | null;
  kind: PromoKind;
  benefitType: BenefitType;
  flatAmount: Paise | null;
  percentage: BasisPoints | null;
  maxDiscountAmount: Paise | null;
  comboBuyQty: number | null;
  comboGetQty: number | null;
  comboGetPercent: BasisPoints | null;
  bundlePrice: Paise | null;
  freeShipping: boolean;
  scope: PromoScope;
  targets: readonly PromoTarget[];
  rules: readonly PromoRule[];
  minOrderAmount: Paise;
  startAt: Date;
  endAt: Date;
  /** Only ACTIVE promotions reach the engine; kept for the INACTIVE rule. */
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  isAutoApply: boolean;
  isStackable: boolean;
  priority: number;
  totalUsageLimit: number | null;
  perFarmLimit: number | null;
  perUserLimit: number | null;
  usedCount: number;
  accountType: PromoAccountType;
  farmHistory: PromoFarmHistory;
  paymentMethod: PromoPaymentMethod;
  isMemberOnly: boolean;
}

/** Who is buying, how they pay and what they have already redeemed. */
export interface BuyerContext {
  farmId: string;
  userId: string;
  gstin: string | null;
  farmCategory: string;
  productionTypes: readonly string[];
  stateCode: string | null;
  territoryCode: string | null;
  pinCode: string | null;
  /** Orders already placed by this farm (NEW_FARM / EXISTING_FARM). */
  farmOrderCount: number;
  isMember: boolean;
  paymentMethod: PaymentMethod | null;
  bankCode: string | null;
  cardBin: string | null;
  /** Non-reversed redemptions per promotion id. */
  usage: ReadonlyMap<string, { farm: number; user: number }>;
  now: Date;
}

export interface PricingConfig {
  sellerStateCode: string;
  /** Freight charged when any line needs the cold chain (CC_REF / CC_FRZ). */
  coldChainFreight: Paise;
  /** Freight otherwise. */
  standardFreight: Paise;
  freightGstRate: BasisPoints;
  freightSacCode: string;
}

export type ReasonCode =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'USAGE_EXHAUSTED'
  | 'FARM_LIMIT'
  | 'USER_LIMIT'
  | 'ACCOUNT_TYPE'
  | 'PRODUCTION_TYPE'
  | 'FARM_CATEGORY'
  | 'FARM_HISTORY'
  | 'REGION'
  | 'PAYMENT_METHOD'
  | 'MEMBER_ONLY'
  | 'MIN_ORDER';

export type Eligibility =
  { ok: true } | { ok: false; reasonCode: ReasonCode; message: string; amountToUnlock?: Paise };

/** Per-line result of the waterfall (all paise). */
export interface PricedLine {
  variantId: string;
  sku: string;
  name: string;
  qty: number;
  unitPrice: Paise;
  priceSource: PriceSource;
  lineGross: Paise;
  lineOfferDiscount: Paise;
  lineOfferPromotionIds: string[];
  /** Units sold at a bundle price (never in the coupon / bonus base). */
  pairedQty: number;
  couponDiscount: Paise;
  autoBonusDiscount: Paise;
  taxableValue: Paise;
  hsnCode: string;
  gstRate: BasisPoints;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  lineTotal: Paise;
  /** Exact share of every promotion on this line (line offers, coupon, bonus). Σ = discounts. */
  allocations: { promotionId: string; amount: Paise }[];
}

export interface GstGroup {
  hsnCode: string;
  rate: BasisPoints;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

export interface AppliedPromotion {
  promotionId: string;
  code: string | null;
  title: string;
  kind: PromoKind;
  discount: Paise;
}

export interface Invoice {
  itemSubtotal: Paise;
  lineOfferDiscount: Paise;
  couponDiscount: Paise;
  autoBonusDiscount: Paise;
  taxableAmount: Paise;
  freight: Paise;
  freightDiscount: Paise;
  freightTaxable: Paise;
  freightGst: Paise;
  gstByHsn: GstGroup[];
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  gstTotal: Paise;
  interState: boolean;
  totalSavings: Paise;
  finalPayable: Paise;
}
