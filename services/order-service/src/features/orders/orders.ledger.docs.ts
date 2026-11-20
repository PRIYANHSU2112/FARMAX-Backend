import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IDS, ok } from '../../docs/shared.js';

/** Swagger for the order money ledger (buyer + staff views share the schema). */

const entry = Joi.object({
  id: Joi.string().guid(),
  kind: Joi.string()
    .valid('CAPTURE', 'REFUND')
    .description('CAPTURE = money in, REFUND = money back'),
  amountPaise: Joi.number().integer().min(1).example(2782100),
  amount: Joi.string().example('27821.00'),
  currency: Joi.string().example('INR'),
  method: Joi.string()
    .allow(null)
    .example('upi')
    .description(
      'Gateway method (upi · card · netbanking · wallet · emi); refunds carry the method of their capture',
    ),
  paymentId: Joi.string().guid(),
  refundId: Joi.string().guid().allow(null),
  providerRef: Joi.string()
    .allow(null)
    .description('Gateway payment id, or the bank ARN of a refund'),
  sourceRef: Joi.string().allow(null).description('Refund decision reference (refunds only)'),
  occurredAt: Joi.date().iso().description('When the money moved'),
  recordedAt: Joi.date().iso(),
}).meta({ className: 'OrderTransaction' });

const ledger = Joi.object({
  orderId: Joi.string().guid(),
  summary: Joi.object({
    capturedPaise: Joi.number().integer(),
    refundedPaise: Joi.number().integer(),
    netPaise: Joi.number().integer(),
    captured: Joi.string(),
    refunded: Joi.string(),
    net: Joi.string(),
  }).meta({ className: 'OrderLedgerSummary' }),
  transactions: Joi.array().items(entry),
}).meta({ className: 'OrderLedger' });

const example = ok({
  orderId: IDS.order,
  summary: {
    capturedPaise: 2782100,
    refundedPaise: 450000,
    netPaise: 2332100,
    captured: '27821.00',
    refunded: '4500.00',
    net: '23321.00',
  },
  transactions: [
    {
      id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8a01',
      kind: 'CAPTURE',
      amountPaise: 2782100,
      amount: '27821.00',
      currency: 'INR',
      method: 'upi',
      paymentId: IDS.payment,
      refundId: null,
      providerRef: 'pay_N8xZ0q1W2e3R',
      sourceRef: null,
      occurredAt: '2026-11-24T10:15:00.000Z',
      recordedAt: '2026-11-24T10:15:01.000Z',
    },
    {
      id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8a02',
      kind: 'REFUND',
      amountPaise: 450000,
      amount: '4500.00',
      currency: 'INR',
      method: 'upi',
      paymentId: IDS.payment,
      refundId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8a03',
      providerRef: '74512345678901234567890',
      sourceRef: `cancel:${IDS.order}:1`,
      occurredAt: '2026-11-25T09:00:00.000Z',
      recordedAt: '2026-11-25T09:00:02.000Z',
    },
  ],
});

const LEDGER_TEXT =
  'Immutable money ledger of the order: every capture and every (partial) refund, in integer paise, recorded from payment-service events exactly once (idempotent per payment / refund). `summary` is always the sum of the rows. Instrument data (card / VPA) is never stored here.';

export const ledgerDocs = (tag: string, auth: string, permission?: string): RouteDocs => ({
  tag,
  summary: 'Order money ledger (captures + refunds)',
  description: LEDGER_TEXT,
  auth,
  ...(permission === undefined ? {} : { permission }),
  success: { status: 200, description: 'Ledger', data: ledger, example },
  errors: [404, 422],
});

const check = Joi.object({
  paymentId: Joi.string().guid(),
  orderId: Joi.string().guid(),
  status: Joi.string().valid('OK', 'MISMATCH'),
  ledgerCapturedPaise: Joi.number().integer(),
  ledgerRefundedPaise: Joi.number().integer(),
  paymentCapturedPaise: Joi.number().integer(),
  paymentRefundedPaise: Joi.number().integer(),
  checkedAt: Joi.date().iso(),
}).meta({ className: 'OrderLedgerCheck' });

export const mismatchDocs = (tag: string, auth: string): RouteDocs => ({
  tag,
  summary: 'Ledger mismatches (reconciliation)',
  description:
    'Payments whose order ledger disagrees with payment-service totals (checked every 15 min once rows have settled for 10 min; re-checked until consistent). Nothing is corrected automatically: investigate the payment and the refund decisions.',
  auth,
  permission: 'payments.view',
  success: {
    status: 200,
    description: 'A page of mismatches',
    data: check,
    paginated: true,
    example: ok(
      [
        {
          paymentId: IDS.payment,
          orderId: IDS.order,
          status: 'MISMATCH',
          ledgerCapturedPaise: 2782100,
          ledgerRefundedPaise: 0,
          paymentCapturedPaise: 2782100,
          paymentRefundedPaise: 450000,
          checkedAt: '2026-11-25T09:30:00.000Z',
        },
      ],
      { nextCursor: null, limit: 20 },
    ),
  },
  errors: [422],
});
