import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, ok } from '../../docs/shared.js';
import {
  ACCOUNT_TYPES,
  BENEFITS,
  FARM_HISTORIES,
  KINDS,
  PAYMENT_METHODS,
  RULE_TYPES,
  SCOPES,
  STATUSES,
  TARGET_TYPES,
} from './promotions.validation.js';

export const ADMIN_PROMOTIONS_TAG = 'Admin Promotions';

const MONEY = Joi.string()
  .pattern(/^\d+\.\d{2}$/)
  .example('500.00');
const MONEY_NULL = MONEY.allow(null);

/** Response schema (docs only), published as the reusable `Promotion` component. */
const promotionSchema = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string()
    .allow(null)
    .example('SHED500')
    .description('UPPERCASE; null for auto offers. Unique among live promotions.'),
  title: Joi.string().example('₹500 off biosecurity over ₹10,000'),
  subtitle: Joi.string().allow(null).example('Farmer Monsoon Bonus'),
  termsText: Joi.string().allow(null),
  badgeText: Joi.string().allow(null).example('FREE SHIPPING'),
  kind: Joi.string()
    .valid(...KINDS)
    .description(
      'LINE_OFFER = product level (Phase A); ORDER_COUPON = manual code, max 1 per order (Phase B); AUTO_BONUS = auto-applied, max 1 (Phase B2); SHIPPING = freight promo (Phase C).',
    ),
  benefitType: Joi.string().valid(...BENEFITS),
  flatAmount: MONEY_NULL.description(
    'FLAT. For a LINE_OFFER it is per unit; for coupons / bonuses per order.',
  ),
  percentage: Joi.string().allow(null).example('10.00'),
  maxDiscountAmount: MONEY_NULL.description('Cap of a PERCENTAGE discount (required).'),
  comboBuyQty: Joi.number().integer().allow(null).example(2),
  comboGetQty: Joi.number().integer().allow(null).example(1),
  comboGetPercent: Joi.string().allow(null).example('100.00').description('100 = free'),
  bundlePrice: MONEY_NULL.description('BUNDLE_PAIR: price of one full set'),
  freeShipping: Joi.boolean().description('The coupon / bonus also waives freight'),
  scope: Joi.string().valid(...SCOPES),
  targets: Joi.array().items(
    Joi.object({
      targetType: Joi.string().valid(...TARGET_TYPES),
      targetId: Joi.string().guid(),
      bundleQty: Joi.number()
        .integer()
        .allow(null)
        .description('BUNDLE_PAIR: units of this component per set'),
    }),
  ),
  rules: Joi.array().items(
    Joi.object({
      ruleType: Joi.string().valid(...RULE_TYPES),
      value: Joi.string().example('LAYER'),
    }),
  ),
  minOrderAmount: MONEY.example('10000.00').description(
    'Checked on the eligible base (in-scope, stackable lines after line offers)',
  ),
  startAt: Joi.date().iso(),
  endAt: Joi.date().iso(),
  status: Joi.string().valid(...STATUSES),
  effectiveStatus: Joi.string()
    .valid(...STATUSES, 'EXPIRED', 'SCHEDULED')
    .description('ACTIVE past endAt → EXPIRED; ACTIVE before startAt → SCHEDULED'),
  statusChangedAt: Joi.date().iso(),
  statusReason: Joi.string().allow(null),
  isAutoApply: Joi.boolean(),
  isStackable: Joi.boolean().description(
    'Coupon + bonus stack only when BOTH are stackable; a non-stackable line offer keeps its units out of the coupon base. BUNDLE_PAIR is never stackable.',
  ),
  priority: Joi.number().integer().description('Tie-break only'),
  accountType: Joi.string().valid(...ACCOUNT_TYPES),
  farmHistory: Joi.string().valid(...FARM_HISTORIES),
  paymentMethod: Joi.string()
    .valid(...PAYMENT_METHODS)
    .description('Prepaid only: no COD / credit'),
  isMemberOnly: Joi.boolean(),
  isPublic: Joi.boolean().description(
    'Listed on the public offers page (no login). Never set it on targeted / private codes.',
  ),
  limits: Joi.object({
    totalUsageLimit: Joi.number().integer().allow(null),
    perFarmLimit: Joi.number().integer().allow(null).example(1),
    perUserLimit: Joi.number().integer().allow(null),
  }).description('Configured limits (null = unlimited)'),
  usage: Joi.object({
    usedCount: Joi.number().integer().example(0),
    remaining: Joi.number().integer().allow(null),
  }).description('Actual redemptions — written by checkout (Step 2), so 0 until orders exist'),
  version: Joi.number().integer(),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'Promotion' });

const redemptionSchema = Joi.object({
  id: Joi.string().guid(),
  farmId: Joi.string().guid(),
  userId: Joi.string().guid(),
  orderId: Joi.string().guid(),
  discountAmount: MONEY,
  status: Joi.string().valid('APPLIED', 'PARTIALLY_REVERSED', 'REVERSED'),
  createdAt: Joi.date().iso(),
}).meta({ className: 'PromoRedemption' });

const shed500 = {
  id: IDS.promotion,
  code: 'SHED500',
  title: '₹500 off biosecurity over ₹10,000',
  subtitle: 'Farmer Monsoon Bonus',
  termsText: null,
  badgeText: 'FREE SHIPPING',
  kind: 'ORDER_COUPON',
  benefitType: 'FLAT',
  flatAmount: '500.00',
  percentage: null,
  maxDiscountAmount: null,
  comboBuyQty: null,
  comboGetQty: null,
  comboGetPercent: null,
  bundlePrice: null,
  freeShipping: true,
  scope: 'CATEGORY',
  targets: [{ targetType: 'CATEGORY', targetId: IDS.categoryBiosecurity, bundleQty: null }],
  rules: [
    { ruleType: 'PRODUCTION_TYPE', value: 'LAYER' },
    { ruleType: 'PRODUCTION_TYPE', value: 'BROILER' },
  ],
  minOrderAmount: '10000.00',
  startAt: '2026-11-01T00:00:00.000Z',
  endAt: '2026-12-31T18:29:59.000Z',
  status: 'ACTIVE',
  effectiveStatus: 'ACTIVE',
  statusChangedAt: '2026-11-17T06:00:00.000Z',
  statusReason: 'Monsoon campaign approved by category manager',
  isAutoApply: false,
  isStackable: true,
  priority: 10,
  accountType: 'ALL',
  farmHistory: 'ALL',
  paymentMethod: 'ANY',
  isMemberOnly: false,
  isPublic: true,
  limits: { totalUsageLimit: 5000, perFarmLimit: 1, perUserLimit: null },
  usage: { usedCount: 0, remaining: 5000 },
  version: 1,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: '2026-11-17T05:00:00.000Z',
  updatedAt: '2026-11-17T06:00:00.000Z',
};

const createExample = {
  code: 'shed500',
  title: '₹500 off biosecurity over ₹10,000',
  subtitle: 'Farmer Monsoon Bonus',
  badgeText: 'FREE SHIPPING',
  kind: 'ORDER_COUPON',
  benefitType: 'FLAT',
  flatAmount: 500,
  freeShipping: true,
  scope: 'CATEGORY',
  targets: [{ targetType: 'CATEGORY', targetId: IDS.categoryBiosecurity }],
  rules: [
    { ruleType: 'PRODUCTION_TYPE', value: 'LAYER' },
    { ruleType: 'PRODUCTION_TYPE', value: 'BROILER' },
  ],
  minOrderAmount: 10000,
  startAt: '2026-11-01T00:00:00.000Z',
  endAt: '2026-12-31T18:29:59.000Z',
  isStackable: true,
  priority: 10,
  totalUsageLimit: 5000,
  perFarmLimit: 1,
};

const VALIDATION_RULES = `**Validation (422 \`Promotion is not valid\`, every issue listed):**
- \`kind\` → allowed \`benefitType\`: LINE_OFFER = FLAT / PERCENTAGE / COMBO / BUNDLE_PAIR; ORDER_COUPON and AUTO_BONUS = FLAT / PERCENTAGE / FREE_SHIPPING; SHIPPING = FREE_SHIPPING / FLAT.
- FLAT needs \`flatAmount\` (an ORDER_COUPON with a minimum needs \`flatAmount < minOrderAmount\`); PERCENTAGE needs \`percentage\` **and** \`maxDiscountAmount\`; COMBO needs buy / get qty and \`comboGetPercent\`; BUNDLE_PAIR needs \`bundlePrice\`, ≥ 2 targets each with \`bundleQty\`, and is never stackable.
- PLATFORM_WIDE has no targets; any other scope needs ≥ 1 target of that type.
- ORDER_COUPON needs a \`code\` and is not auto-applied; AUTO_BONUS has \`isAutoApply: true\`; other kinds have no code.
- \`endAt > startAt\`.`;

const codeTaken = {
  summary: 'PROMO_CODE_TAKEN',
  message: 'A live promotion already uses this code',
  details: { reason: 'PROMO_CODE_TAKEN', code: 'SHED500' },
};
const versionConflict = {
  summary: 'VERSION_CONFLICT',
  message: 'The promotion was changed by someone else; reload and retry',
  details: { reason: 'VERSION_CONFLICT', currentVersion: 3 },
};
const stateInvalid = {
  summary: 'PROMO_STATE_INVALID',
  message: 'Cannot move a ARCHIVED promotion to ACTIVE',
  details: { reason: 'PROMO_STATE_INVALID', from: 'ARCHIVED', to: 'ACTIVE' },
};
const overlap = {
  summary: 'PROMO_OVERLAP',
  message: 'Another live promotion overlaps this one',
  details: { reason: 'PROMO_OVERLAP', conflictingIds: [IDS.promotion2] },
};
const invalidPromo = {
  summary: 'PROMO_INVALID',
  message: 'Promotion is not valid',
  details: {
    issues: [{ path: 'body.maxDiscountAmount', message: 'is required for PERCENTAGE (the cap)' }],
  },
};

export const PROMOTION_DOCS = {
  list: {
    tag: ADMIN_PROMOTIONS_TAG,
    summary: 'List promotions',
    description: 'Newest first. Filters: `status`, `kind`, `code` (prefix, case-insensitive).',
    auth: AUTH_ADMIN,
    permission: 'pricing.view',
    success: {
      status: 200,
      description: 'A page of promotions',
      data: promotionSchema,
      paginated: true,
      example: { success: true, data: [shed500], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_PROMOTIONS_TAG,
    summary: 'Get a promotion',
    description:
      'Includes targets, rules, configured `limits` and actual `usage` (separate objects). `ETag` = version.',
    auth: AUTH_ADMIN,
    permission: 'pricing.view',
    success: {
      status: 200,
      description: 'The promotion',
      data: promotionSchema,
      example: ok(shed500),
    },
    errors: [404, 422],
  },
  create: {
    tag: ADMIN_PROMOTIONS_TAG,
    summary: 'Create a promotion (DRAFT)',
    description: `Always created as **DRAFT**; activate with \`POST /{id}/status\`. Money in rupees (2 dp), percentages as numbers. \`code\` is trimmed and stored UPPERCASE. \`usedCount\` and \`status\` are not accepted.\n\n${VALIDATION_RULES}`,
    auth: AUTH_ADMIN,
    permission: 'pricing.manage',
    requestExample: createExample,
    success: {
      status: 201,
      description: 'Created (DRAFT)',
      data: promotionSchema,
      example: ok({ ...shed500, status: 'DRAFT', effectiveStatus: 'DRAFT', version: 0 }),
    },
    errors: [409, 422],
    errorExamples: { 409: codeTaken, 422: invalidPromo },
  },
  update: {
    tag: ADMIN_PROMOTIONS_TAG,
    summary: 'Edit a promotion',
    description: `\`version\` from the last read is required (stale → 409 \`VERSION_CONFLICT\`). DRAFT: any field. **ACTIVE / PAUSED:** only title, subtitle, termsText, badgeText, \`endAt\` (extend only) and the limits (raise only); anything else → clone it as a new DRAFT. ARCHIVED: no edits. \`targets\` / \`rules\` replace the whole list.\n\n${VALIDATION_RULES}`,
    auth: AUTH_ADMIN,
    permission: 'pricing.manage',
    requestExample: {
      version: 1,
      endAt: '2027-01-15T18:29:59.000Z',
      totalUsageLimit: 8000,
      reason: 'Extended after strong uptake',
    },
    success: {
      status: 200,
      description: 'Updated',
      data: promotionSchema,
      example: ok({ ...shed500, version: 2 }),
    },
    errors: [404, 409, 422],
    errorExamples: { 409: [versionConflict, codeTaken, stateInvalid], 422: invalidPromo },
  },
  status: {
    tag: ADMIN_PROMOTIONS_TAG,
    summary: 'Change status (activate, pause, archive)',
    description:
      'State machine: DRAFT → ACTIVE | ARCHIVED; ACTIVE ↔ PAUSED; ACTIVE | PAUSED → ARCHIVED; ARCHIVED is final. `reason` (10–500 chars) is audited.\n\n**Activation** re-runs every validation rule plus `endAt` in the future, then the overlap check: a LINE_OFFER may not share a target (or be platform-wide) with another ACTIVE/PAUSED line offer in an overlapping window; an AUTO_BONUS may not overlap another ACTIVE auto bonus whose audience (accountType / farmHistory) overlaps. ORDER_COUPONs may overlap (the buyer picks one).',
    auth: AUTH_ADMIN,
    permission: 'pricing.manage',
    requestExample: { to: 'ACTIVE', reason: 'Monsoon campaign approved by category manager' },
    success: {
      status: 200,
      description: 'New status',
      data: promotionSchema,
      example: ok(shed500),
    },
    errors: [404, 409, 422],
    errorExamples: { 409: [overlap, stateInvalid, versionConflict], 422: invalidPromo },
  },
  redemptions: {
    tag: ADMIN_PROMOTIONS_TAG,
    summary: 'Redemptions of a promotion',
    description:
      'One row per order that used it. Written by checkout (Step 2), so empty until orders exist.',
    auth: AUTH_ADMIN,
    permission: 'pricing.view',
    success: {
      status: 200,
      description: 'A page of redemptions',
      data: redemptionSchema,
      paginated: true,
      example: { success: true, data: [], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
