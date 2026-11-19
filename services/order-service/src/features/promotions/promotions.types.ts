import type { CursorQuery } from '@farmx/common/types';

import type {
  BenefitType,
  PromoAccountType,
  PromoFarmHistory,
  PromoKind,
  PromoPaymentMethod,
  PromoRuleType,
  PromoScope,
  PromoTargetType,
} from '../pricing/index.js';

export type PromoStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export interface TargetInput {
  targetType: PromoTargetType;
  targetId: string;
  bundleQty?: number | null;
}

export interface RuleInput {
  ruleType: PromoRuleType;
  value: string;
}

/** Every editable field (money in rupees as numbers, percentages as numbers). */
export interface PromotionFields {
  code: string | null;
  title: string;
  subtitle: string | null;
  termsText: string | null;
  badgeText: string | null;
  kind: PromoKind;
  benefitType: BenefitType;
  flatAmount: number | null;
  percentage: number | null;
  maxDiscountAmount: number | null;
  comboBuyQty: number | null;
  comboGetQty: number | null;
  comboGetPercent: number | null;
  bundlePrice: number | null;
  freeShipping: boolean;
  scope: PromoScope;
  minOrderAmount: number;
  startAt: Date;
  endAt: Date;
  isAutoApply: boolean;
  isStackable: boolean;
  priority: number;
  totalUsageLimit: number | null;
  perFarmLimit: number | null;
  perUserLimit: number | null;
  accountType: PromoAccountType;
  farmHistory: PromoFarmHistory;
  paymentMethod: PromoPaymentMethod;
  isMemberOnly: boolean;
  isPublic: boolean;
  targets: TargetInput[];
  rules: RuleInput[];
}

export type CreatePromotionInput = Partial<PromotionFields> &
  Pick<PromotionFields, 'title' | 'kind' | 'benefitType' | 'startAt' | 'endAt'> & {
    reason?: string;
  };

export type UpdatePromotionInput = Partial<PromotionFields> & { version: number; reason?: string };

export interface StatusInput {
  to: PromoStatus;
  reason: string;
}

export interface PromotionListQuery extends CursorQuery {
  status?: PromoStatus;
  kind?: PromoKind;
  /** Code prefix (case-insensitive). */
  code?: string;
}

/** Repository row (Decimal → decimal string; no Prisma types past the repository). */
export interface PromotionRecord extends Omit<
  PromotionFields,
  | 'flatAmount'
  | 'percentage'
  | 'maxDiscountAmount'
  | 'comboGetPercent'
  | 'bundlePrice'
  | 'minOrderAmount'
  | 'targets'
> {
  id: string;
  flatAmount: string | null;
  percentage: string | null;
  maxDiscountAmount: string | null;
  comboGetPercent: string | null;
  bundlePrice: string | null;
  minOrderAmount: string;
  targets: { targetType: PromoTargetType; targetId: string; bundleQty: number | null }[];
  status: PromoStatus;
  statusChangedAt: Date;
  statusChangedByUserId: string;
  statusReason: string | null;
  usedCount: number;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** API view. */
export interface PromotionView {
  id: string;
  code: string | null;
  title: string;
  subtitle: string | null;
  termsText: string | null;
  badgeText: string | null;
  kind: PromoKind;
  benefitType: BenefitType;
  flatAmount: string | null;
  percentage: string | null;
  maxDiscountAmount: string | null;
  comboBuyQty: number | null;
  comboGetQty: number | null;
  comboGetPercent: string | null;
  bundlePrice: string | null;
  freeShipping: boolean;
  scope: PromoScope;
  targets: { targetType: PromoTargetType; targetId: string; bundleQty: number | null }[];
  rules: RuleInput[];
  minOrderAmount: string;
  startAt: string;
  endAt: string;
  status: PromoStatus;
  /** ACTIVE with endAt in the past → EXPIRED (derived, never stored). */
  effectiveStatus: PromoStatus | 'EXPIRED' | 'SCHEDULED';
  statusChangedAt: string;
  statusReason: string | null;
  isAutoApply: boolean;
  isStackable: boolean;
  priority: number;
  accountType: PromoAccountType;
  farmHistory: PromoFarmHistory;
  paymentMethod: PromoPaymentMethod;
  isMemberOnly: boolean;
  isPublic: boolean;
  /** [R7] Configured limits … */
  limits: {
    totalUsageLimit: number | null;
    perFarmLimit: number | null;
    perUserLimit: number | null;
  };
  /** … vs actual redemptions (written by checkout, Step 2). */
  usage: { usedCount: number; remaining: number | null };
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RedemptionView {
  id: string;
  farmId: string;
  userId: string;
  orderId: string;
  discountAmount: string;
  status: 'APPLIED' | 'PARTIALLY_REVERSED' | 'REVERSED';
  createdAt: string;
}
