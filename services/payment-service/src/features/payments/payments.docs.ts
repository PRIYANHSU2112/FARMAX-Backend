import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_CUSTOMER, IDS, ok } from '../../docs/shared.js';
import { PAYMENT_STATUSES } from './payments.validation.js';

export const PAYMENTS_TAG = 'Payments';
export const ADMIN_PAYMENTS_TAG = 'Admin Payments';

const paymentSchema = Joi.object({
  id: Joi.string().guid(),
  paymentNo: Joi.string().example('TXN-261121-9F3A21C4'),
  purpose: Joi.string()
    .valid('ORDER', 'WALLET_TOPUP')
    .description('ORDER (orderId / orderNo set) or WALLET_TOPUP (referenceId = wallet top-up id)'),
  orderId: Joi.string().guid().allow(null),
  orderNo: Joi.string().allow(null).example('ORD-26-0091842'),
  referenceId: Joi.string().guid().allow(null),
  status: Joi.string()
    .valid(...PAYMENT_STATUSES)
    .description(
      'PENDING → CAPTURED; FAILED = last attempt failed (retry allowed until expiresAt); CANCELLED (order closed) · EXPIRED · PARTIALLY_REFUNDED · REFUNDED',
    ),
  provider: Joi.string()
    .valid('RAZORPAY', 'MOCK', 'WALLET')
    .description('WALLET = paid in full from the FarmX wallet (no gateway order)'),
  amountPaise: Joi.number().integer().example(2782100),
  amount: Joi.string().example('27821.00'),
  currency: Joi.string().example('INR'),
  capturedPaise: Joi.number().integer(),
  refundedPaise: Joi.number().integer(),
  providerOrderId: Joi.string().allow(null).example('order_N8xYz12AbCd'),
  providerPaymentId: Joi.string().allow(null),
  method: Joi.string().allow(null).example('upi'),
  vpaMasked: Joi.string().allow(null).example('ve***@okhdfc'),
  cardLast4: Joi.string().allow(null),
  cardNetwork: Joi.string().allow(null),
  bank: Joi.string().allow(null),
  wallet: Joi.string().allow(null),
  expiresAt: Joi.date().iso(),
  capturedAt: Joi.date().iso().allow(null),
  failureCode: Joi.string().allow(null),
  failureReason: Joi.string().allow(null),
  attemptCount: Joi.number().integer(),
  amountMismatch: Joi.boolean().description('Captured amount differed from the order amount'),
  createdAt: Joi.date().iso(),
}).meta({ className: 'Payment' });

const example = {
  id: IDS.payment,
  paymentNo: 'TXN-261121-9F3A21C4',
  purpose: 'ORDER',
  orderId: IDS.order,
  orderNo: 'ORD-26-0091842',
  referenceId: null,
  status: 'CAPTURED',
  provider: 'RAZORPAY',
  amountPaise: 2782100,
  amount: '27821.00',
  currency: 'INR',
  capturedPaise: 2782100,
  refundedPaise: 0,
  providerOrderId: 'order_N8xYz12AbCd',
  providerPaymentId: 'pay_N8xZ0q1W2e3R',
  method: 'upi',
  vpaMasked: 've***@okhdfc',
  cardLast4: null,
  cardNetwork: null,
  bank: null,
  wallet: null,
  expiresAt: '2026-11-21T09:30:00.000Z',
  capturedAt: '2026-11-21T09:02:41.000Z',
  failureCode: null,
  failureReason: null,
  attemptCount: 1,
  amountMismatch: false,
  createdAt: '2026-11-21T09:00:00.000Z',
};

export const PAYMENT_DOCS = {
  get: {
    tag: PAYMENTS_TAG,
    summary: 'Payment status ("Check Status Now")',
    description: 'Own payments only; any other id answers 404.',
    auth: AUTH_CUSTOMER,
    success: { status: 200, description: 'Payment', data: paymentSchema, example: ok(example) },
    errors: [404, 422],
  },
  verify: {
    tag: PAYMENTS_TAG,
    summary: 'Verify the gateway checkout result',
    description:
      'Send the Razorpay Checkout handler response. The server checks `signature` = HMAC-SHA256(`providerOrderId|providerPaymentId`, key secret) in constant time, then **re-reads the payment from the gateway** (the client is never trusted for status or amount). Idempotent: calling it again, or the webhook arriving first, gives the same result. A failed attempt answers 200 with status FAILED (pay again until `expiresAt`).',
    auth: AUTH_CUSTOMER,
    rateLimit: '20 per user per minute',
    requestExample: {
      providerOrderId: 'order_N8xYz12AbCd',
      providerPaymentId: 'pay_N8xZ0q1W2e3R',
      signature: '0f6e1c2b8a…64 hex chars',
    },
    success: {
      status: 200,
      description: 'Payment after verification',
      data: paymentSchema,
      example: ok(example),
    },
    errors: [400, 404, 422, 503],
    errorExamples: {
      400: { message: 'Invalid payment signature', details: { reason: 'SIGNATURE_INVALID' } },
    },
  },
  mockSucceed: {
    tag: PAYMENTS_TAG,
    summary: 'MOCK: pay successfully (dev / test only)',
    description:
      'Exists only when `PAYMENT_PROVIDER=mock` (never in production). Simulates the buyer paying in the gateway checkout: returns exactly what Razorpay Checkout returns to the app (`providerOrderId`, `providerPaymentId`, `signature`) — send it to `POST /v1/payments/{id}/verify` — and also stores the signed `payment.captured` webhook, so both real paths run.',
    auth: AUTH_CUSTOMER,
    rateLimit: '20 per user per minute',
    requestExample: { method: 'upi' },
    success: { status: 200, description: 'Checkout callback' },
    errors: [404, 409, 422],
  },
  mockFail: {
    tag: PAYMENTS_TAG,
    summary: 'MOCK: fail the payment attempt (dev / test only)',
    description:
      'Exists only when `PAYMENT_PROVIDER=mock`. Simulates a declined attempt (stores the signed `payment.failed` webhook). The payment becomes FAILED; paying again is allowed until `expiresAt`.',
    auth: AUTH_CUSTOMER,
    rateLimit: '20 per user per minute',
    success: { status: 200, description: 'Gateway error callback' },
    errors: [404, 409, 422],
  },
  adminList: {
    tag: ADMIN_PAYMENTS_TAG,
    summary: 'List payments',
    description: 'Newest first. Filters: `status`, `orderId`, `userId`.',
    auth: AUTH_ADMIN,
    permission: 'payments.view',
    success: {
      status: 200,
      description: 'A page of payments',
      data: paymentSchema,
      paginated: true,
    },
    errors: [422],
  },
  adminGet: {
    tag: ADMIN_PAYMENTS_TAG,
    summary: 'Payment detail with attempts, refunds and webhooks',
    auth: AUTH_ADMIN,
    permission: 'payments.view',
    success: { status: 200, description: 'Payment detail' },
    errors: [404, 422],
  },
  reconcile: {
    tag: ADMIN_PAYMENTS_TAG,
    summary: 'Re-check a payment with the gateway now',
    description:
      'For "customer paid but the order still shows unpaid": re-reads every attempt of the gateway order and applies any capture or failure (idempotent). Audited.',
    auth: AUTH_ADMIN,
    permission: 'payments.reconcile',
    rateLimit: '60 writes per user per minute',
    success: { status: 200, description: 'Payment after the check', data: paymentSchema },
    errors: [404, 422, 503],
  },
} satisfies Record<string, RouteDocs>;
