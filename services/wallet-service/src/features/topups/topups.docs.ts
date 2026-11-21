import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_CUSTOMER, ok } from '../../docs/shared.js';
import { TOPUP_METHODS } from './topups.validation.js';

export const TOPUPS_TAG = 'Wallet Top-ups';

const ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a01';
const PAYMENT_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9e01';

const topupSchema = Joi.object({
  id: Joi.string().guid(),
  topupNo: Joi.string().example('TU-261121-4F2A9C10'),
  status: Joi.string()
    .valid('CREATED', 'PENDING', 'FAILED', 'COMPLETED', 'EXPIRED')
    .description(
      'CREATED → PENDING → COMPLETED (credited). FAILED = last attempt failed, pay again until expiresAt. EXPIRED = not paid in time (a late capture still completes it).',
    ),
  amountPaise: Joi.number().integer().example(1000000),
  amount: Joi.string().example('10000.00'),
  method: Joi.string().valid(...TOPUP_METHODS),
  paymentId: Joi.string().guid().allow(null),
  paymentNo: Joi.string()
    .allow(null)
    .example('TXN-261121-9028194821')
    .description('"Transaction Ref"'),
  creditedPaise: Joi.number().integer().allow(null).description('What the gateway captured'),
  credited: Joi.string().allow(null),
  balanceAfterPaise: Joi.number().integer().allow(null).description('"Updated Balance"'),
  balanceAfter: Joi.string().allow(null),
  instrument: Joi.string()
    .allow(null)
    .example('HDFC Bank (Net Banking)')
    .description('Masked only'),
  cashback: Joi.object({
    paise: Joi.number().integer(),
    points: Joi.number().integer().description('"Cashback Points Earned"'),
    status: Joi.string()
      .valid('NONE', 'PENDING', 'CREDITED')
      .description('CREDITED = in the points ledger; PENDING = decided, credited within minutes'),
  }),
  failure: Joi.object({
    code: Joi.string().allow(null),
    reason: Joi.string().allow(null),
    attempts: Joi.number().integer(),
  }).allow(null),
  expiresAt: Joi.date().iso(),
  completedAt: Joi.date().iso().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'WalletTopup' });

const completed = {
  id: ID,
  topupNo: 'TU-261121-4F2A9C10',
  status: 'COMPLETED',
  amountPaise: 1000000,
  amount: '10000.00',
  method: 'UPI',
  paymentId: PAYMENT_ID,
  paymentNo: 'TXN-261121-9028194821',
  creditedPaise: 1000000,
  credited: '10000.00',
  balanceAfterPaise: 13489265,
  balanceAfter: '134892.65',
  instrument: 'UPI ve***@okhdfc',
  cashback: { paise: 5000, points: 500, status: 'CREDITED' },
  failure: null,
  expiresAt: '2026-11-21T10:00:00.000Z',
  completedAt: '2026-11-21T09:31:12.000Z',
  createdAt: '2026-11-21T09:30:00.000Z',
};

const checkoutSchema = Joi.object({
  paymentId: Joi.string().guid().description('Use with POST /v1/payments/{paymentId}/verify'),
  paymentNo: Joi.string(),
  provider: Joi.string().valid('RAZORPAY', 'MOCK'),
  keyId: Joi.string().description('Public key for the Razorpay Checkout SDK'),
  providerOrderId: Joi.string().allow(null).description('Razorpay order_id'),
  amountPaise: Joi.number().integer(),
  currency: Joi.string(),
  expiresAt: Joi.date().iso(),
  preferredMethod: Joi.string()
    .valid('upi', 'netbanking', 'card')
    .description('Checkout `method` prefill'),
}).meta({ className: 'WalletTopupCheckout' });

export const TOPUP_DOCS = {
  options: {
    tag: TOPUPS_TAG,
    summary: 'Add Money screen: limits, chips, methods, cashback offer',
    description:
      'Everything the Add Money screen needs. `availablePaise` = the most this customer can add now (balance cap and today\'s limit). The "New balance" preview is `balancePaise + amount`. Cashback is paid as reward points.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Options',
      data: Joi.object({
        balancePaise: Joi.number().integer(),
        balance: Joi.string(),
        minPaise: Joi.number().integer(),
        maxPaise: Joi.number().integer(),
        availablePaise: Joi.number().integer(),
        maxBalancePaise: Joi.number().integer(),
        dailyMaxPaise: Joi.number().integer(),
        presetsPaise: Joi.array().items(Joi.number().integer()),
        methods: Joi.array().items(
          Joi.object({ method: Joi.string(), label: Joi.string(), hint: Joi.string() }),
        ),
        cashbackOffer: Joi.object({
          eligible: Joi.boolean().description('true until the first completed top-up'),
          method: Joi.string(),
          percent: Joi.string(),
          maxPaise: Joi.number().integer(),
          paidAs: Joi.string(),
          pointValuePaise: Joi.number().integer(),
        }).allow(null),
      }).meta({ className: 'WalletTopupOptions' }),
      example: ok({
        balancePaise: 5200,
        balance: '52.00',
        minPaise: 10000,
        maxPaise: 5000000,
        availablePaise: 5000000,
        maxBalancePaise: 20000000,
        dailyMaxPaise: 10000000,
        presetsPaise: [50000, 70000, 90000, 100000, 200000, 500000],
        methods: [
          { method: 'UPI', label: 'UPI', hint: 'GPay, PhonePe, Paytm' },
          { method: 'NETBANKING', label: 'Net Banking', hint: 'All major banks' },
          { method: 'CARD', label: 'Debit / Credit Card', hint: 'Visa, Mastercard, RuPay' },
        ],
        cashbackOffer: {
          eligible: true,
          method: 'UPI',
          percent: '10',
          maxPaise: 5000,
          paidAs: 'REWARD_POINTS',
          pointValuePaise: 10,
        },
      }),
    },
    errors: [429],
  },
  create: {
    tag: TOPUPS_TAG,
    summary: 'Add money: start a top-up',
    description: [
      'Starts a top-up and returns the gateway checkout. **`Idempotency-Key` header required**: a retry with the same key and body returns the same top-up (never a second payment); the same key with another body → 422 `IDEMPOTENCY_KEY_REUSED`.',
      '',
      "Flow: open Razorpay Checkout with `checkout` → send its response to `POST /v1/payments/{paymentId}/verify` → poll `GET /v1/wallet/topups/{id}` until COMPLETED (success modal data). The wallet is credited only from the gateway's captured amount, exactly once.",
      '',
      'Limits (422): `AMOUNT_OUT_OF_RANGE`, `MAX_BALANCE_EXCEEDED`, `DAILY_LIMIT_EXCEEDED`. A COMPLETED / EXPIRED top-up replayed by its key returns `checkout: null`.',
    ].join('\n'),
    auth: AUTH_CUSTOMER,
    rateLimit: '10 per user per minute',
    requestExample: { amountPaise: 1000000, method: 'UPI' },
    success: {
      status: 200,
      description: 'Top-up + checkout',
      data: Joi.object({ topup: topupSchema, checkout: checkoutSchema.allow(null) }),
      example: ok({
        topup: {
          ...completed,
          status: 'PENDING',
          creditedPaise: null,
          credited: null,
          balanceAfterPaise: null,
          balanceAfter: null,
          instrument: null,
          cashback: { paise: 0, points: 0, status: 'NONE' },
          completedAt: null,
        },
        checkout: {
          paymentId: PAYMENT_ID,
          paymentNo: 'TXN-261121-9028194821',
          provider: 'RAZORPAY',
          keyId: 'rzp_live_XXXXXXXXXXXX',
          providerOrderId: 'order_N8xYz12AbCd',
          amountPaise: 1000000,
          currency: 'INR',
          expiresAt: '2026-11-21T10:00:00.000Z',
          preferredMethod: 'upi',
        },
      }),
    },
    errors: [400, 422, 503],
    errorExamples: {
      422: {
        message: 'This top-up would take your wallet above its limit',
        details: {
          reason: 'MAX_BALANCE_EXCEEDED',
          maxBalancePaise: 20000000,
          balancePaise: 19500000,
          availablePaise: 500000,
        },
      },
    },
  },
  get: {
    tag: TOPUPS_TAG,
    summary: 'Top-up status (success modal data)',
    description:
      'Own top-ups only (any other id → 404). An open top-up older than 3 s is re-checked with the gateway first, so polling after checkout completes it even if the webhook is late. COMPLETED gives "Transaction Ref" (`paymentNo`), "Updated Balance" (`balanceAfter`) and "Cashback Points Earned" (`cashback.points`).',
    auth: AUTH_CUSTOMER,
    rateLimit: '30 per user per minute',
    success: { status: 200, description: 'Top-up', data: topupSchema, example: ok(completed) },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
