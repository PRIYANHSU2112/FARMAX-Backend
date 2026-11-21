import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, ok } from '../../docs/shared.js';

export const ADMIN_WALLET_TAG = 'Admin Wallet';

const adjustmentSchema = Joi.object({
  id: Joi.string().guid(),
  adjustmentNo: Joi.string().example('ADJ-261006-0A1B2C3D'),
  userId: Joi.string().guid(),
  ledger: Joi.string().valid('WALLET', 'POINTS'),
  direction: Joi.string().valid('CREDIT', 'DEBIT'),
  amount: Joi.number().integer().description('Paise (WALLET) or points (POINTS)'),
  amountRupees: Joi.string().allow(null),
  category: Joi.string()
    .valid('GOODWILL', 'DAMAGE_CLAIM', 'LOYALTY_BONUS', 'CORRECTION')
    .description(
      'Statement chip: DAMAGE_CLAIM → Refunds, LOYALTY_BONUS → Rewards, others → Adjustments',
    ),
  title: Joi.string(),
  reason: Joi.string(),
  status: Joi.string().valid('PENDING_APPROVAL', 'POSTED', 'REJECTED'),
  requestedBy: Joi.string().guid(),
  decidedBy: Joi.string().guid().allow(null),
  decisionReason: Joi.string().allow(null),
  decidedAt: Joi.date().iso().allow(null),
  journalId: Joi.string().guid().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'WalletAdjustment' });

const example = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5a01',
  adjustmentNo: 'ADJ-261006-0A1B2C3D',
  userId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d1111',
  ledger: 'WALLET',
  direction: 'CREDIT',
  amount: 112000,
  amountRupees: '1120.00',
  category: 'DAMAGE_CLAIM',
  title: 'Cold Box Damage Refund',
  reason: 'Cold box arrived damaged at Tanuku C&F; 2 vials replaced value',
  status: 'PENDING_APPROVAL',
  requestedBy: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  journalId: null,
  createdAt: '2026-10-06T05:50:00.000Z',
};

export const ADJUSTMENT_DOCS = {
  create: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Request a manual wallet / points adjustment',
    description:
      '**`Idempotency-Key` header required.** Creates a PENDING_APPROVAL request; nothing moves until **another** staff member approves it (segregation of duties). 422 `ABOVE_LIMIT` (setting `adjustmentMaxPaise` / `adjustmentMaxPoints`). Audited.',
    auth: AUTH_ADMIN,
    permission: 'wallet.adjust',
    rateLimit: '60 writes per user per minute',
    requestExample: {
      userId: example.userId,
      ledger: 'WALLET',
      direction: 'CREDIT',
      amount: 112000,
      category: 'DAMAGE_CLAIM',
      title: 'Cold Box Damage Refund',
      reason: example.reason,
    },
    success: {
      status: 201,
      description: 'Requested',
      data: adjustmentSchema,
      example: ok(example),
    },
    errors: [400, 422],
  },
  approve: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Approve (post) an adjustment',
    description:
      'Posts the journal in the same transaction (wallet: ADJUSTMENT_CREDIT / _DEBIT; points: ADJUSTMENT lot or FIFO debit). 403 when you requested it yourself. 409 `ALREADY_DECIDED`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_POINTS` (the request stays pending). Audited.',
    auth: AUTH_ADMIN,
    permission: 'wallet.approve',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Verified with the depot in-charge photos' },
    success: {
      status: 200,
      description: 'Posted',
      data: adjustmentSchema,
      example: ok({ ...example, status: 'POSTED' }),
    },
    errors: [404, 409, 422],
  },
  reject: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Reject an adjustment',
    description: 'Reason required; never by the requester (403). Audited.',
    auth: AUTH_ADMIN,
    permission: 'wallet.approve',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Duplicate of ADJ-261005-77AA10C2' },
    success: {
      status: 200,
      description: 'Rejected',
      data: adjustmentSchema,
      example: ok({ ...example, status: 'REJECTED' }),
    },
    errors: [404, 409, 422],
  },
  get: {
    tag: ADMIN_WALLET_TAG,
    summary: 'One adjustment',
    auth: AUTH_ADMIN,
    permission: 'wallet.view',
    success: {
      status: 200,
      description: 'Adjustment',
      data: adjustmentSchema,
      example: ok(example),
    },
    errors: [404, 422],
  },
  list: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Adjustments (approval queue)',
    description: 'Newest first. Filters: `status` (PENDING_APPROVAL = the queue), `userId`.',
    auth: AUTH_ADMIN,
    permission: 'wallet.view',
    success: {
      status: 200,
      description: 'A page of adjustments',
      data: adjustmentSchema,
      paginated: true,
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
