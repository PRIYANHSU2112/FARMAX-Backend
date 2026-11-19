import Joi from 'joi';

import { ID, MONEY, PAGE, PERCENT, REASON, idParams } from '../../middleware/http.js';

export const KINDS = ['LINE_OFFER', 'ORDER_COUPON', 'AUTO_BONUS', 'SHIPPING'] as const;
export const BENEFITS = ['FLAT', 'PERCENTAGE', 'COMBO', 'BUNDLE_PAIR', 'FREE_SHIPPING'] as const;
export const SCOPES = ['PLATFORM_WIDE', 'CATEGORY', 'PRODUCT', 'VARIANT', 'BRAND'] as const;
export const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export const ACCOUNT_TYPES = ['ALL', 'B2B_GST', 'RETAIL'] as const;
export const FARM_HISTORIES = ['ALL', 'NEW_FARM', 'EXISTING_FARM'] as const;
export const PAYMENT_METHODS = ['ANY', 'UPI', 'CARD', 'NETBANKING'] as const;
export const TARGET_TYPES = ['CATEGORY', 'PRODUCT', 'VARIANT', 'BRAND'] as const;
export const RULE_TYPES = [
  'PRODUCTION_TYPE',
  'FARM_CATEGORY',
  'STATE',
  'TERRITORY',
  'PINCODE',
  'BANK',
  'CARD_BIN',
] as const;

/** [R1] Letters, digits, `-`, `_`; stored trimmed + UPPERCASE. */
const CODE = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9_-]{3,30}$/)
  .messages({
    'string.pattern.base': 'must be 3–30 letters, digits, "-" or "_"',
  });
const LIMIT = Joi.number().integer().min(1).max(10_000_000).allow(null);

const target = Joi.object({
  targetType: Joi.string()
    .valid(...TARGET_TYPES)
    .required(),
  targetId: ID.required(),
  bundleQty: Joi.number().integer().min(1).max(100).allow(null),
});

const rule = Joi.object({
  ruleType: Joi.string()
    .valid(...RULE_TYPES)
    .required(),
  value: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9_]{1,40}$/)
    .required(),
});

const fields = {
  code: CODE.allow(null),
  title: Joi.string().trim().min(3).max(120),
  subtitle: Joi.string().trim().max(160).allow(null),
  termsText: Joi.string().trim().max(5_000).allow(null),
  badgeText: Joi.string().trim().max(30).allow(null),
  kind: Joi.string().valid(...KINDS),
  benefitType: Joi.string().valid(...BENEFITS),
  flatAmount: MONEY.greater(0).allow(null),
  percentage: PERCENT.allow(null),
  maxDiscountAmount: MONEY.greater(0).allow(null),
  comboBuyQty: Joi.number().integer().min(1).max(100).allow(null),
  comboGetQty: Joi.number().integer().min(1).max(100).allow(null),
  comboGetPercent: PERCENT.allow(null),
  bundlePrice: MONEY.greater(0).allow(null),
  freeShipping: Joi.boolean(),
  scope: Joi.string().valid(...SCOPES),
  minOrderAmount: MONEY,
  startAt: Joi.date().iso(),
  endAt: Joi.date().iso(),
  isAutoApply: Joi.boolean(),
  isStackable: Joi.boolean(),
  priority: Joi.number().integer().min(-1000).max(1000),
  totalUsageLimit: LIMIT,
  perFarmLimit: LIMIT,
  perUserLimit: LIMIT,
  accountType: Joi.string().valid(...ACCOUNT_TYPES),
  farmHistory: Joi.string().valid(...FARM_HISTORIES),
  paymentMethod: Joi.string().valid(...PAYMENT_METHODS),
  isMemberOnly: Joi.boolean(),
  isPublic: Joi.boolean(),
  targets: Joi.array()
    .items(target)
    .max(50)
    .unique(
      (a: { targetType: string; targetId: string }, b: { targetType: string; targetId: string }) =>
        a.targetType === b.targetType && a.targetId === b.targetId,
    ),
  rules: Joi.array()
    .items(rule)
    .max(200)
    .unique(
      (a: { ruleType: string; value: string }, b: { ruleType: string; value: string }) =>
        a.ruleType === b.ruleType && a.value === b.value,
    ),
};

export const listPromotionsSchema = {
  querystring: Joi.object({
    ...PAGE,
    status: Joi.string().valid(...STATUSES),
    kind: Joi.string().valid(...KINDS),
    code: Joi.string().trim().max(30),
  }),
};

export const getPromotionSchema = idParams;

export const createPromotionSchema = {
  body: Joi.object({
    ...fields,
    title: fields.title.required(),
    kind: fields.kind.required(),
    benefitType: fields.benefitType.required(),
    startAt: fields.startAt.required(),
    endAt: fields.endAt.required(),
    reason: Joi.string().trim().max(500),
  }),
};

/** `usedCount` and `status` are never accepted here [R6/R7] (unknown keys → 422). */
export const updatePromotionSchema = {
  ...idParams,
  body: Joi.object({
    ...fields,
    version: Joi.number().integer().min(0).required(),
    reason: Joi.string().trim().max(500),
  }).min(2),
};

export const statusSchema = {
  ...idParams,
  body: Joi.object({
    to: Joi.string()
      .valid(...STATUSES)
      .required(),
    reason: REASON,
  }),
};

export const redemptionsSchema = { ...idParams, querystring: Joi.object(PAGE) };
