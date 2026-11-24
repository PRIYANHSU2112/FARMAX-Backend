import Joi from 'joi';

import { ID, PAGE, idParams } from '../../middleware/http.js';

export const checkoutSchema = {
  body: Joi.object({
    farmId: ID.required(),
    addressId: ID.required(),
    /** `cartVersion` from the cart the buyer reviewed (stale → 409 CART_CHANGED). */
    cartVersion: Joi.number().integer().min(0).required(),
    billToGst: Joi.boolean().default(false),
    /** WALLET = pay the whole order from the FarmX wallet (no split with the gateway). */
    paymentMethod: Joi.string().valid('ONLINE', 'WALLET').default('ONLINE'),
    /** Buyer's own purchase-order reference (B2B, optional; D-57 §6a). */
    customerPoRef: Joi.string()
      .trim()
      .max(40)
      .pattern(/^[A-Za-z0-9][A-Za-z0-9/_. -]*$/)
      .allow(null, ''),
  }),
};

export const listOrdersSchema = {
  querystring: Joi.object({
    ...PAGE,
    tab: Joi.string().valid('active', 'completed', 'cancelled').default('active'),
  }),
};

export const orderIdSchema = idParams;

export const statusesSchema = {
  querystring: Joi.object({
    ids: Joi.string()
      .pattern(/^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36}){0,199}$/)
      .required(),
  }),
};

// ── Cancellation (buyer + staff) ──

export const BUYER_CANCEL_REASONS = [
  'ORDERED_BY_MISTAKE',
  'FLOCK_DELAYED',
  'LOWER_PRICE',
  'VET_ADVISED',
  'OTHER',
] as const;
export const STAFF_CANCEL_REASONS = [
  'CUSTOMER_REQUEST',
  'DUPLICATE_ORDER',
  'PRICE_ERROR',
  'SUSPECTED_FRAUD',
  'NOT_SERVICEABLE',
  'OTHER',
] as const;
export const REJECT_REASONS = [
  'OUT_OF_STOCK_PHYSICAL',
  'PRICE_ERROR',
  'SUSPECTED_FRAUD',
  'NOT_SERVICEABLE',
  'RX_INVALID',
  'AMOUNT_MISMATCH',
  'OTHER',
] as const;

const CANCEL_LINES = Joi.array()
  .items(
    Joi.object({
      variantId: ID.required(),
      qty: Joi.number().integer().min(1).max(100_000).required(),
    }),
  )
  .max(200)
  .unique('variantId');
const STAFF_REASON = Joi.string().trim().min(10).max(500);
const VERSION = Joi.number().integer().min(0);

export const quoteSchema = { ...idParams, body: Joi.object({ lines: CANCEL_LINES }).default({}) };

export const buyerCancelSchema = {
  ...idParams,
  body: Joi.object({
    lines: CANCEL_LINES,
    reasonCode: Joi.string()
      .valid(...BUYER_CANCEL_REASONS)
      .required(),
    note: Joi.string().trim().max(500),
  }),
};

// ── Admin ──

const STATUS = [
  'PENDING_ADMIN_CONFIRMATION',
  'CONFIRMED',
  'IN_FULFILMENT',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
] as const;
const PAYMENT = ['PENDING', 'FAILED', 'PAID', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const STOCK = [
  'PENDING',
  'RESERVED',
  'COMMITTED',
  'RELEASE_REQUESTED',
  'RELEASED',
  'FAILED',
  'REJECTED',
] as const;
const REFUND = [
  'NONE',
  'REQUESTED',
  'IN_PROGRESS',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'ACTION_REQUIRED',
] as const;

export const adminListSchema = {
  querystring: Joi.object({
    ...PAGE,
    status: Joi.string().valid(...STATUS),
    paymentStatus: Joi.string().valid(...PAYMENT),
    stockStatus: Joi.string().valid(...STOCK),
    refundStatus: Joi.string().valid(...REFUND),
    orderNo: Joi.string().trim().max(20),
    farmId: ID,
    userId: ID,
    placedFrom: Joi.date().iso(),
    placedTo: Joi.date().iso(),
  }),
};

export const exceptionsSchema = {
  querystring: Joi.object({
    type: Joi.string()
      .valid('refund_failed', 'stock_release_pending', 'amount_mismatch', 'late_payment')
      .required(),
  }),
};

export const confirmSchema = {
  ...idParams,
  body: Joi.object({ expectedVersion: VERSION.required(), note: Joi.string().trim().max(500) }),
};

export const rejectSchema = {
  ...idParams,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    reasonCode: Joi.string()
      .valid(...REJECT_REASONS)
      .required(),
    reason: STAFF_REASON.required(),
  }),
};

export const bulkConfirmSchema = {
  body: Joi.object({
    orderIds: Joi.array().items(ID.required()).min(1).max(200).unique().required(),
  }),
};

export const adminCancelSchema = {
  ...idParams,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    lines: CANCEL_LINES,
    reasonCode: Joi.string()
      .valid(...STAFF_CANCEL_REASONS)
      .required(),
    note: STAFF_REASON.required(),
  }),
};

export const noteSchema = {
  ...idParams,
  body: Joi.object({ body: Joi.string().trim().min(2).max(2000).required() }),
};

const refundParams = Joi.object({ id: ID.required(), refundId: ID.required() });
export const refundRetrySchema = {
  params: refundParams,
  body: Joi.object({ reason: STAFF_REASON.required() }),
};
export const refundOfflineSchema = {
  params: refundParams,
  body: Joi.object({
    reason: STAFF_REASON.required(),
    bankReference: Joi.string().trim().min(4).max(80).required(),
  }),
};

/** Internal (warehouse W3.10 prepaid settlement): refund of units not delivered. */
export const shortageRefundSchema = {
  ...idParams,
  body: Joi.object({
    shipmentId: ID.required(),
    lines: Joi.array()
      .items(
        Joi.object({
          lineNo: Joi.number().integer().min(1).required(),
          qty: Joi.number().integer().min(1).required(),
        }),
      )
      .min(1)
      .max(200)
      .required(),
  }),
};

/** Internal (warehouse compliance, D-57 §2a.7). */
export const complianceRejectSchema = {
  ...idParams,
  body: Joi.object({ reason: Joi.string().trim().min(5).max(500).required() }),
};

/** D-57b W3.14 partial ship: the warehouse cancels short units (refund + reservation release). */
export const cancelLinesSchema = {
  ...idParams,
  body: Joi.object({
    lines: CANCEL_LINES.min(1).required(),
    reasonCode: Joi.string()
      .valid(...STAFF_CANCEL_REASONS)
      .default('OTHER'),
    note: STAFF_REASON.required(),
    by: ID.allow(null),
  }),
};

/** D-57b W3.15: delivery details before picking (same state; GST does not change). */
const DELIVERY_FIELDS = {
  contactName: Joi.string().trim().min(2).max(120),
  contactPhone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{10,13}$/),
  line1: Joi.string().trim().min(2).max(200),
  line2: Joi.string().trim().max(200).allow(null, ''),
  landmark: Joi.string().trim().max(120).allow(null, ''),
  village: Joi.string().trim().max(80).allow(null, ''),
  mandal: Joi.string().trim().max(80).allow(null, ''),
  district: Joi.string().trim().min(2).max(80),
  pinCode: Joi.string().pattern(/^[1-9][0-9]{5}$/),
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null),
  deliveryPromise: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .allow(null),
};
export const deliverySchema = {
  ...idParams,
  body: Joi.object({
    ...DELIVERY_FIELDS,
    reason: STAFF_REASON.required(),
    expectedVersion: VERSION.required(),
  }).or(...Object.keys(DELIVERY_FIELDS)),
};
export const internalDeliverySchema = {
  ...idParams,
  body: Joi.object({
    ...DELIVERY_FIELDS,
    reason: STAFF_REASON.required(),
    by: ID.required(),
  }).or(...Object.keys(DELIVERY_FIELDS)),
};
