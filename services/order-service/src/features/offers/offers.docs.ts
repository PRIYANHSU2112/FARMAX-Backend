import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_CUSTOMER, IDS, ok } from '../../docs/shared.js';

export const OFFERS_TAG = 'Offers & Price Preview';

const MONEY = Joi.string()
  .pattern(/^-?\d+\.\d{2}$/)
  .example('500.00');
const REASONS = [
  'INACTIVE',
  'NOT_STARTED',
  'EXPIRED',
  'USAGE_EXHAUSTED',
  'FARM_LIMIT',
  'USER_LIMIT',
  'ACCOUNT_TYPE',
  'PRODUCTION_TYPE',
  'FARM_CATEGORY',
  'FARM_HISTORY',
  'REGION',
  'PAYMENT_METHOD',
  'MEMBER_ONLY',
  'MIN_ORDER',
];

const publicCard = Joi.object({
  promotionId: Joi.string().guid(),
  code: Joi.string().allow(null).example('SHED500').description('null for auto-applied offers'),
  title: Joi.string().example('₹500 off biosecurity over ₹10,000'),
  subtitle: Joi.string().allow(null),
  badgeText: Joi.string().allow(null).example('FREE SHIPPING'),
  termsText: Joi.string().allow(null),
  kind: Joi.string().valid('LINE_OFFER', 'ORDER_COUPON', 'AUTO_BONUS', 'SHIPPING'),
  benefitType: Joi.string().valid('FLAT', 'PERCENTAGE', 'COMBO', 'BUNDLE_PAIR', 'FREE_SHIPPING'),
  flatAmount: MONEY.allow(null),
  percentage: Joi.string().allow(null),
  maxDiscountAmount: MONEY.allow(null),
  bundlePrice: MONEY.allow(null),
  minOrderAmount: MONEY,
  freeShipping: Joi.boolean(),
  scope: Joi.string(),
  validUntil: Joi.date().iso(),
  conditions: Joi.array().items(Joi.string()),
}).meta({ className: 'PublicOffer' });

const card = Joi.object({
  promotionId: Joi.string().guid(),
  code: Joi.string().allow(null).example('SHED500'),
  title: Joi.string().example('₹500 off biosecurity over ₹10,000'),
  subtitle: Joi.string().allow(null).example('Farmer Monsoon Bonus'),
  badgeText: Joi.string().allow(null).example('FREE SHIPPING'),
  validUntil: Joi.date().iso(),
  conditions: Joi.array()
    .items(Joi.string())
    .example(['1 use per farm', 'Layer & broiler farms', 'Min. eligible order ₹10,000']),
  freeShipping: Joi.boolean(),
  saving: MONEY.description(
    'Total saving vs the same cart with no coupon (item discount + freight waived)',
  ),
});

const couponStatus = Joi.object({
  code: Joi.string(),
  applied: Joi.boolean(),
  promotionId: Joi.string().guid().allow(null),
  reasonCode: Joi.string()
    .valid(...REASONS, 'NOT_FOUND', 'NOT_APPLICABLE', 'DISPLACED')
    .allow(null),
  message: Joi.string().allow(null),
})
  .allow(null)
  .meta({ className: 'CouponStatus' });

const bundle = Joi.object({
  promotionId: Joi.string().guid(),
  title: Joi.string().example('ND + IBD pair'),
  subtitle: Joi.string().allow(null),
  bundlePrice: MONEY.example('1420.00'),
  savingPerSet: MONEY.example('29.00'),
  sets: Joi.number().integer().example(2),
  applied: Joi.boolean().description('false → show "Apply pair" (send its id in applyBundleIds)'),
});

export const offersSchema = Joi.object({
  applied: card
    .keys({ message: Joi.string().allow(null) })
    .allow(null)
    .description(
      'The coupon kept on the order: the requested code if it applies, else the best saving',
    ),
  requested: couponStatus.description('What happened to `couponCode` (null when none was sent)'),
  autoBonus: card.allow(null).description('Auto-applied bonus (e.g. WELCOME30), if any'),
  alsoEligible: Joi.array().items(
    card.keys({
      message: Joi.string().example('One coupon per order. SHED500 saves more, so it stays.'),
    }),
  ),
  bundles: Joi.array().items(bundle),
  nudges: Joi.array().items(
    Joi.object({
      promotionId: Joi.string().guid(),
      code: Joi.string().allow(null).example('MONSOON1000'),
      title: Joi.string(),
      amountToUnlock: MONEY.example('2179.00'),
      progressPct: Joi.number().integer().min(0).max(99).example(92),
      potentialSaving: MONEY.example('1000.00'),
      message: Joi.string().example('Add ₹2,179 to unlock ₹1,000 off'),
    }),
  ),
  ineligible: Joi.array().items(
    Joi.object({
      promotionId: Joi.string().guid(),
      code: Joi.string().allow(null).example('RETAIL50'),
      title: Joi.string(),
      reasonCode: Joi.string().valid(...REASONS, 'NOT_APPLICABLE'),
      message: Joi.string().example('Retail accounts only. This B2B farm account is not eligible.'),
    }),
  ),
  summary: Joi.object({ itemSubtotal: MONEY, totalSavings: MONEY, finalPayable: MONEY }),
}).meta({ className: 'OrderOffers' });

const gstGroup = Joi.object({
  hsnCode: Joi.string().example('3002'),
  rate: Joi.string().example('5.00'),
  taxable: MONEY,
  cgst: MONEY,
  sgst: MONEY,
  igst: MONEY,
});

export const previewSchema = Joi.object({
  billing: Joi.object({
    farmId: Joi.string().guid(),
    farmCode: Joi.string().allow(null).example('FX-WG-L-00418'),
    name: Joi.string().example('Sri Lakshmi Agro Farms'),
    gstin: Joi.string()
      .allow(null)
      .example('37ABCDE1234F1Z5')
      .description('Only when billToGst and the farm has a verified GSTIN'),
    itcEligible: Joi.boolean(),
    placeOfSupply: Joi.string().allow(null).example('37'),
    sellerStateCode: Joi.string().example('37'),
  }),
  lines: Joi.array().items(
    Joi.object({
      variantId: Joi.string().guid(),
      sku: Joi.string(),
      name: Joi.string(),
      qty: Joi.number().integer(),
      unitPrice: MONEY,
      priceSource: Joi.string()
        .valid('LIST', 'TIER', 'MEMBER')
        .description('LIST until tiers / membership exist'),
      lineGross: MONEY,
      lineOfferDiscount: MONEY,
      lineOfferPromotionIds: Joi.array().items(Joi.string().guid()),
      pairedQty: Joi.number()
        .integer()
        .description('Units sold at a bundle price (never in the coupon base)'),
      couponDiscount: MONEY,
      autoBonusDiscount: MONEY,
      taxableValue: MONEY,
      hsnCode: Joi.string(),
      gstRate: Joi.string().example('18.00'),
      cgst: MONEY,
      sgst: MONEY,
      igst: MONEY,
      lineTotal: MONEY,
    }),
  ),
  invoice: Joi.object({
    itemSubtotal: MONEY.example('31496.00'),
    lineOfferDiscount: MONEY,
    couponDiscount: MONEY,
    autoBonusDiscount: MONEY,
    taxableAmount: MONEY,
    freight: MONEY.example('495.00').description('Cold-chain freight & packaging'),
    freightDiscount: MONEY.example('495.00').description('PROMO → FREE when equal to freight'),
    freightGst: MONEY,
    gstByHsn: Joi.array()
      .items(gstGroup)
      .description('Sum of already-rounded line amounts (freight under its SAC code)'),
    cgst: MONEY,
    sgst: MONEY,
    igst: MONEY,
    gstTotal: MONEY,
    interState: Joi.boolean(),
    totalSavings: MONEY,
    finalPayable: MONEY.example('27821.00').description('Includes all direct & indirect taxes'),
    saved: MONEY,
  }),
  appliedPromotions: Joi.array().items(
    Joi.object({
      promotionId: Joi.string().guid(),
      code: Joi.string().allow(null),
      title: Joi.string(),
      kind: Joi.string().valid('LINE_OFFER', 'ORDER_COUPON', 'AUTO_BONUS', 'SHIPPING'),
      discount: MONEY,
    }),
  ),
  couponStatus,
  bundles: Joi.array().items(bundle),
}).meta({ className: 'OrderPreview' });

const requestBase = {
  farmId: IDS.farm,
  lines: [
    { variantId: IDS.variant, qty: 2 },
    { variantId: IDS.variant2, qty: 2 },
  ],
  paymentMethod: 'UPI',
};

const offersExample = ok({
  applied: {
    promotionId: IDS.promotion,
    code: 'SHED500',
    title: '₹500 off biosecurity over ₹10,000',
    subtitle: 'Farmer Monsoon Bonus',
    badgeText: 'FREE SHIPPING',
    validUntil: '2026-10-31T18:29:59.000Z',
    conditions: ['1 use per farm', 'Layer & broiler farms', 'Min. eligible order ₹10,000'],
    freeShipping: true,
    saving: '995.00',
    message: 'You save ₹500 with SHED500.',
  },
  requested: null,
  autoBonus: null,
  alsoEligible: [
    {
      promotionId: IDS.promotion2,
      code: 'VAX300',
      title: '₹300 off vaccines over ₹15,000',
      subtitle: null,
      badgeText: null,
      validUntil: '2026-12-31T18:29:59.000Z',
      conditions: ['Min. eligible order ₹15,000'],
      freeShipping: false,
      saving: '300.00',
      message: 'One coupon per order. SHED500 saves more, so it stays.',
    },
  ],
  bundles: [
    {
      promotionId: IDS.bundle,
      title: 'ND + IBD pair',
      subtitle: null,
      bundlePrice: '1420.00',
      savingPerSet: '29.00',
      sets: 2,
      applied: false,
    },
  ],
  nudges: [
    {
      promotionId: IDS.monsoon,
      code: 'MONSOON1000',
      title: '₹1,000 off over ₹30,000',
      amountToUnlock: '2179.00',
      progressPct: 92,
      potentialSaving: '1000.00',
      message: 'Add ₹2,179 to unlock ₹1,000 off',
    },
  ],
  ineligible: [
    {
      promotionId: IDS.retail,
      code: 'RETAIL50',
      title: '₹50 off for retail buyers',
      reasonCode: 'ACCOUNT_TYPE',
      message: 'Retail accounts only. This B2B farm account is not eligible.',
    },
  ],
  summary: { itemSubtotal: '27240.00', totalSavings: '995.00', finalPayable: '27806.00' },
});

const farmNotFound = { summary: 'Not your farm / not ACTIVE / unknown', message: 'Farm not found' };
const notSellable = {
  summary: 'VARIANT_NOT_SELLABLE',
  message: 'Some items are not available for sale',
  details: {
    reason: 'VARIANT_NOT_SELLABLE',
    issues: [
      {
        path: 'body.lines[1].variantId',
        message: 'is not available for sale (inactive, or price / HSN / GST rate missing)',
      },
    ],
  },
};

const WATERFALL = `**Price waterfall (strict order, integer paise):** 0 base price (list price for now) → A line offers (BUNDLE_PAIR opt-in via \`applyBundleIds\`, else one of COMBO > PERCENTAGE > FLAT per line) → B one manual coupon → B2 one auto bonus (stacks only when both are stackable, else the bigger saving wins) → C freight (one benefit, the largest) → D GST per line on the discounted value (CGST + SGST when the farm's state = seller state, else IGST), rounded half-up per line; HSN totals are sums of line amounts.

Advisory only: limits are re-checked at checkout. Prices are always read on the server; client amounts are never trusted.`;

export const OFFERS_DOCS = {
  publicOffers: {
    tag: OFFERS_TAG,
    summary: 'Public offers (no login)',
    description:
      'Coupons and offers a shopper can browse before building a cart: only ACTIVE promotions an admin marked `isPublic`, inside their window. `categoryId` keeps platform-wide offers and those targeting that category. No limits, usage, rules or targets are exposed. Cached 60 s (Redis) with a weak ETag — send `If-None-Match` for a 304.',
    public: true,
    rateLimit: '120 per IP per minute',
    success: {
      status: 200,
      description: 'Public offers, highest priority first',
      data: Joi.array().items(publicCard),
      example: ok([
        {
          promotionId: IDS.promotion,
          code: 'SHED500',
          title: '₹500 off biosecurity over ₹10,000',
          subtitle: 'Farmer Monsoon Bonus',
          badgeText: 'FREE SHIPPING',
          termsText: null,
          kind: 'ORDER_COUPON',
          benefitType: 'FLAT',
          flatAmount: '500.00',
          percentage: null,
          maxDiscountAmount: null,
          bundlePrice: null,
          minOrderAmount: '10000.00',
          freeShipping: true,
          scope: 'CATEGORY',
          validUntil: '2026-12-31T18:29:59.000Z',
          conditions: ['1 use per farm', 'Layer & broiler farms', 'Min. eligible order ₹10,000'],
        },
      ]),
      headers: {
        ETag: {
          description: 'Weak ETag of this response. Send it back as If-None-Match.',
          schema: { type: 'string' },
        },
        'Cache-Control': {
          description: 'public, max-age=60, stale-while-revalidate=300',
          schema: { type: 'string' },
        },
      },
    },
    errors: [422],
  },
  offers: {
    tag: OFFERS_TAG,
    summary: 'Offers for this order',
    description: `Screen "Offers for this order". Ranks every coupon for the cart: \`applied\` (the requested \`couponCode\` if it applies, else the best saving), \`alsoEligible\` with a "Use instead" message, \`bundles\` ("Apply pair"), \`nudges\` ("Add ₹2,179 to unlock ₹1,000 off") and \`ineligible\` with a reason code.\n\n${WATERFALL}`,
    auth: AUTH_CUSTOMER,
    rateLimit: '60 per user per minute (shared with preview)',
    requestExample: requestBase,
    success: {
      status: 200,
      description: 'Offers for the cart',
      data: offersSchema,
      example: offersExample,
    },
    errors: [404, 422],
    errorExamples: { 404: farmNotFound, 422: notSellable },
  },
  preview: {
    tag: OFFERS_TAG,
    summary: 'Billing details & tax invoice preview',
    description: `Screen "Billing Details & Tax Invoice": full per-line price trace and the invoice block. An invalid or ineligible \`couponCode\` does not fail the call: the cart is priced without it and \`couponStatus\` says why.\n\n${WATERFALL}`,
    auth: AUTH_CUSTOMER,
    rateLimit: '60 per user per minute (shared with offers)',
    requestExample: { ...requestBase, couponCode: 'SHED500', applyBundleIds: [], billToGst: true },
    success: { status: 200, description: 'Priced cart', data: previewSchema },
    errors: [404, 422],
    errorExamples: { 404: farmNotFound, 422: notSellable },
  },
} satisfies Record<string, RouteDocs>;
