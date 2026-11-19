import type { DocHeader, RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IDS, ok } from '../../docs/shared.js';
import { offersSchema, previewSchema } from '../offers/index.js';

export const CART_TAG = 'Cart';

const MONEY = Joi.string()
  .pattern(/^-?\d+\.\d{2}$/)
  .example('7896.00');
const uuid = Joi.string().guid();
const GUEST_TOKEN = '4b8f7a2e-1c3d-4e5f-9a0b-1c2d3e4f5a6b';
const CART_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4dca01';

const AUTH = `**Guests and customers.** No \`Authorization\` → guest cart, identified by the \`X-Cart-Token\` header (a random UUID the API hands out on the first add). With \`Authorization: Bearer\` → the customer's cart (one per user, all devices); an invalid / non-CUSTOMER token is 401/403, never silently a guest.

**Login merge:** after login keep sending the guest \`X-Cart-Token\` once with any cart call: the guest cart is merged into the customer cart (quantities of the same item are **added**, capped at the item's max order qty; exactly once, even under parallel calls) and the response carries \`X-Cart-Merged: true\`. Then drop the token.`;

const CART_TOKEN: Readonly<Record<string, DocHeader>> = {
  'X-Cart-Token': {
    description:
      'Guest cart token (UUID). Optional for customers: when present, the guest cart is merged first.',
    schema: { type: 'string', format: 'uuid' },
  },
};
const WRITE_HEADERS: Readonly<Record<string, DocHeader>> = {
  'X-Cart-Token': {
    description: 'Set when this call created a guest cart: store it and send it back.',
    schema: { type: 'string', format: 'uuid' },
  },
  'X-Cart-Merged': {
    description: '`true` when a guest cart was merged by this call.',
    schema: { type: 'string' },
  },
};

const CONCURRENCY = `**Concurrency:** each write locks the cart row, re-checks limits on fresh data and bumps \`cartVersion\` in one statement, so parallel taps never lose an update or exceed a limit. Send \`expectedVersion\` (from the last response) to get 409 \`CART_VERSION_CONFLICT\` instead of overwriting a change made on another device.`;

const writeSchema = Joi.object({
  cartId: uuid,
  cartVersion: Joi.number()
    .integer()
    .example(7)
    .description('Bumped on every change; send as expectedVersion'),
  itemCount: Joi.number().integer().example(3).description('Distinct lines (cart badge)'),
  line: Joi.object({ variantId: uuid, qty: Joi.number().integer().example(24) })
    .allow(null)
    .description('The line after the write; null when removed'),
  guestToken: Joi.string().guid().description('Only when this call created a guest cart'),
}).meta({ className: 'CartWrite' });

const notice = Joi.object({
  code: Joi.string().valid(
    'NOT_SELLABLE',
    'PRICE_CHANGED',
    'OUT_OF_STOCK',
    'INSUFFICIENT_STOCK',
    'ABOVE_MAX_QTY',
    'BELOW_MIN_QTY',
    'PRESCRIPTION_REQUIRED',
  ),
  variantId: uuid,
  message: Joi.string().example('Price increased from ₹7,500.00 to ₹7,896.00 since you added it.'),
  from: MONEY.description('PRICE_CHANGED: price when added'),
  to: MONEY.description('PRICE_CHANGED: price now'),
  limit: Joi.number().integer().description('Stock / limit notices: the limit'),
}).meta({ className: 'CartNotice' });

const line = Joi.object({
  variantId: uuid,
  sku: Joi.string().allow(null).example('GB-NDL-1000'),
  name: Joi.string().allow(null).example('ND LaSota Live (1,000 doses)'),
  qty: Joi.number().integer().example(24),
  unitPrice: MONEY.allow(null).description('Current price; null when not sellable'),
  unitPriceSnapshot: MONEY.allow(null).description('Price when the line was last written'),
  lineTotal: MONEY.allow(null)
    .example('189504.00')
    .description('qty × unitPrice, before offers and GST'),
  sellable: Joi.boolean(),
  temperatureClass: Joi.string().example('CC_REF'),
  coldChain: Joi.boolean().description('2–8 °C / frozen: separate consignment'),
  prescriptionRequired: Joi.boolean(),
  minOrderQty: Joi.number().integer().example(1),
  maxOrderQty: Joi.number().integer().allow(null).example(500),
  availableQty: Joi.number()
    .integer()
    .allow(null)
    .description('null = stock unknown (never blocks)'),
}).meta({ className: 'CartLine' });

const cartSchema = Joi.object({
  cartId: uuid.allow(null).description('null = no cart yet'),
  cartVersion: Joi.number().integer().example(7),
  couponCode: Joi.string().allow(null).example('SHED500'),
  itemCount: Joi.number().integer().example(3),
  totalQty: Joi.number().integer().example(72),
  lines: Joi.array().items(line),
  notices: Joi.array()
    .items(notice)
    .description('Everything that changed since the items were added (FR-SHP-05)'),
  consignments: Joi.object({
    coldChainLines: Joi.number().integer(),
    ambientLines: Joi.number().integer(),
    separateDeliveries: Joi.boolean().description(
      'Cold and ambient lines ship separately (FR-SHP-07)',
    ),
  }),
  summary: Joi.object({
    itemSubtotal: MONEY.example('72190.00').description(
      'Sellable lines at current prices, before offers and GST',
    ),
    checkoutBlocked: Joi.boolean().description(
      'A blocking notice exists (not sellable, stock, min/max)',
    ),
  }),
  pricing: Joi.object({
    offers: offersSchema,
    bill: previewSchema,
  })
    .allow(null)
    .description(
      'Customers with `farmId` only: auto offers (combo / pair / %, flat), coupon, freight and the GST bill',
    ),
}).meta({ className: 'Cart' });

const cartExample = ok({
  cartId: CART_ID,
  cartVersion: 7,
  couponCode: 'SHED500',
  itemCount: 1,
  totalQty: 24,
  lines: [
    {
      variantId: IDS.variant,
      sku: 'GB-NDL-1000',
      name: 'ND LaSota Live (1,000 doses)',
      qty: 24,
      unitPrice: '7896.00',
      unitPriceSnapshot: '7500.00',
      lineTotal: '189504.00',
      sellable: true,
      temperatureClass: 'CC_REF',
      coldChain: true,
      prescriptionRequired: false,
      minOrderQty: 1,
      maxOrderQty: 500,
      availableQty: null,
    },
  ],
  notices: [
    {
      code: 'PRICE_CHANGED',
      variantId: IDS.variant,
      from: '7500.00',
      to: '7896.00',
      message: 'Price increased from ₹7,500.00 to ₹7,896.00 since you added it.',
    },
  ],
  consignments: { coldChainLines: 1, ambientLines: 0, separateDeliveries: false },
  summary: { itemSubtotal: '189504.00', checkoutBlocked: false },
  pricing: null,
});

const writeExample = ok({
  cartId: CART_ID,
  cartVersion: 8,
  itemCount: 3,
  line: { variantId: IDS.variant, qty: 25 },
});

const notSellable = {
  summary: 'VARIANT_NOT_SELLABLE',
  message: 'This item is not available for sale',
  details: { reason: 'VARIANT_NOT_SELLABLE' },
};
const limits = [
  notSellable,
  {
    summary: 'QTY_LIMIT',
    message: 'Maximum 500 per order',
    details: {
      reason: 'QTY_LIMIT',
      requestedQty: 520,
      currentQty: 500,
      minOrderQty: 1,
      maxOrderQty: 500,
    },
  },
  {
    summary: 'QTY_BELOW_MIN',
    message: 'Minimum 5 per order',
    details: { reason: 'QTY_BELOW_MIN', requestedQty: 2, minOrderQty: 5 },
  },
  {
    summary: 'OUT_OF_STOCK',
    message: 'Only 12 available',
    details: { reason: 'OUT_OF_STOCK', availableQty: 12 },
  },
  {
    summary: 'CART_FULL',
    message: 'A cart can hold at most 50 different items',
    details: { reason: 'CART_FULL', maxLines: 50 },
  },
] as const;
const versionConflict = {
  message: 'The cart was changed on another device. Reload it and try again.',
  details: { reason: 'CART_VERSION_CONFLICT', expectedVersion: 6, currentVersion: 7 },
};
const RATE = '120 writes per user (guests: per IP) per minute';

export const CART_DOCS = {
  get: {
    tag: CART_TAG,
    summary: 'Get the cart (revalidated)',
    description: `Screens C-07c Cart / Cart Review. Every line is re-checked on read: current price vs the price when added (\`PRICE_CHANGED\`), sellable, stock (soft: unknown never blocks), min/max order qty, prescription and cold-chain flags. Totals are list prices; pass \`farmId\` (customer's own ACTIVE farm) to also get \`pricing\`: auto-applied offers (COMBO / BOGO-style pair / % / flat), the cart coupon, freight and the full GST bill — the same engine as \`POST /v1/orders/preview\`. Prices are always read on the server.\n\n${AUTH}`,
    auth: 'Guest (`X-Cart-Token`) or CUSTOMER',
    rateLimit: '240 reads per user (guests: per IP) per minute',
    headers: CART_TOKEN,
    success: {
      status: 200,
      description: 'Cart (empty when none yet)',
      data: cartSchema,
      example: cartExample,
      headers: WRITE_HEADERS,
    },
    errors: [404, 422],
    errorExamples: {
      404: { summary: 'farmId is not the caller’s ACTIVE farm', message: 'Farm not found' },
    },
  },
  addItem: {
    tag: CART_TAG,
    summary: 'Add to cart (adds to the quantity)',
    description: `"Add to cart" and the "+" button: \`qty\` is **added** to the line (two parallel taps = +2). Creates the cart — and for a guest a token, returned in the body and the \`X-Cart-Token\` header — when there is none. The total must stay within the item's min / max order qty and known stock; a cart holds at most 50 different items.\n\n${CONCURRENCY}\n\n${AUTH}`,
    auth: 'Guest (`X-Cart-Token`, optional on the first add) or CUSTOMER',
    rateLimit: RATE,
    headers: CART_TOKEN,
    requestExample: { variantId: IDS.variant, qty: 1 },
    success: {
      status: 200,
      description: 'Line after the write (first guest add: with a new guestToken)',
      data: writeSchema,
      example: ok({
        cartId: CART_ID,
        cartVersion: 1,
        itemCount: 1,
        line: { variantId: IDS.variant, qty: 1 },
        guestToken: GUEST_TOKEN,
      }),
      headers: WRITE_HEADERS,
    },
    errors: [422],
    errorExamples: { 422: limits },
  },
  setItem: {
    tag: CART_TAG,
    summary: 'Set a line quantity (0 removes it)',
    description: `Quantity box / "−" button: **absolute** quantity, so retries are safe. \`qty: 0\` removes the line. Optional \`expectedVersion\` for multi-device safety.\n\n${CONCURRENCY}`,
    auth: 'Guest (`X-Cart-Token`) or CUSTOMER',
    rateLimit: RATE,
    headers: CART_TOKEN,
    requestExample: { qty: 24, expectedVersion: 7 },
    success: {
      status: 200,
      description: 'Line after the write (null when removed)',
      data: writeSchema,
      example: writeExample,
      headers: WRITE_HEADERS,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: { message: 'Cart not found' }, 409: versionConflict, 422: limits },
  },
  removeItem: {
    tag: CART_TAG,
    summary: 'Remove a line',
    description: `Idempotent: removing a line that is not in the cart changes nothing (same \`cartVersion\`). Optional \`?expectedVersion=\`.`,
    auth: 'Guest (`X-Cart-Token`) or CUSTOMER',
    rateLimit: RATE,
    headers: CART_TOKEN,
    success: {
      status: 200,
      description: 'Cart after the write',
      data: writeSchema,
      headers: WRITE_HEADERS,
    },
    errors: [404, 409],
    errorExamples: { 404: { message: 'Cart not found' }, 409: versionConflict },
  },
  clear: {
    tag: CART_TAG,
    summary: 'Empty the cart',
    description: 'Removes every line and the coupon.',
    auth: 'Guest (`X-Cart-Token`) or CUSTOMER',
    rateLimit: RATE,
    headers: CART_TOKEN,
    success: { status: 200, description: 'Empty cart', data: writeSchema, headers: WRITE_HEADERS },
    errors: [404],
  },
  setCoupon: {
    tag: CART_TAG,
    summary: 'Apply a coupon to the cart',
    description:
      'Customers only. The code must be a live promotion code (trimmed, UPPERCASE); whether it applies to this cart and farm is shown in `GET /cart?farmId=` → `pricing.offers.requested` / `pricing.bill.couponStatus`. Usage limits are enforced when the order is placed (row-locked), so a coupon can never be oversold.',
    auth: 'CUSTOMER',
    rateLimit: RATE,
    requestExample: { code: 'SHED500' },
    success: {
      status: 200,
      description: 'Coupon stored',
      data: Joi.object({
        cartId: uuid,
        cartVersion: Joi.number().integer(),
        couponCode: Joi.string().allow(null),
      }),
    },
    errors: [422],
    errorExamples: {
      422: {
        message: 'This coupon does not exist or has expired',
        details: { reason: 'COUPON_NOT_FOUND' },
      },
    },
  },
  removeCoupon: {
    tag: CART_TAG,
    summary: 'Remove the cart coupon',
    auth: 'CUSTOMER',
    rateLimit: RATE,
    success: {
      status: 200,
      description: 'Coupon removed',
      data: Joi.object({
        cartId: uuid,
        cartVersion: Joi.number().integer(),
        couponCode: Joi.string().allow(null),
      }),
    },
    errors: [404],
  },
  refreshPrices: {
    tag: CART_TAG,
    summary: 'Accept current prices (clears PRICE_CHANGED notices)',
    description:
      'Sets every line’s price snapshot to the current price. Prices charged are always the current ones; this only acknowledges the notice.',
    auth: 'Guest (`X-Cart-Token`) or CUSTOMER',
    rateLimit: RATE,
    headers: CART_TOKEN,
    success: {
      status: 200,
      description: 'Snapshots updated',
      data: Joi.object({ cartId: uuid, cartVersion: Joi.number().integer() }),
    },
    errors: [404],
  },
  merge: {
    tag: CART_TAG,
    summary: 'Merge a guest cart into my cart',
    description: `Explicit form of the automatic login merge (any cart call with a Bearer token and \`X-Cart-Token\` merges first). Exactly once: a second call, or a parallel one, merges nothing (\`merged: false\`).`,
    auth: 'CUSTOMER + `X-Cart-Token`',
    rateLimit: RATE,
    headers: {
      'X-Cart-Token': {
        description: 'The guest cart token to merge.',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    },
    success: {
      status: 200,
      description: 'Merge result',
      data: Joi.object({
        merged: Joi.boolean().description(
          'false = nothing to merge (already merged, expired or unknown token)',
        ),
        guestLines: Joi.number().integer().example(2),
        mergedLines: Joi.number()
          .integer()
          .example(2)
          .description('Lines added or summed into the customer cart'),
      }).meta({ className: 'CartMerge' }),
      example: ok({ merged: true, guestLines: 2, mergedLines: 2 }),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
