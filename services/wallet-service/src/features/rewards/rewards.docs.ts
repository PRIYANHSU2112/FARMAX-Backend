import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_CUSTOMER, ok } from '../../docs/shared.js';

export const REWARDS_TAG = 'Reward Points';

const entrySchema = Joi.object({
  id: Joi.string().guid(),
  journalNo: Joi.string().example('PJ-261005-1A2B3C4D'),
  kind: Joi.string()
    .valid('EARN', 'CASHBACK', 'MATURE', 'CONVERT', 'EXPIRE', 'REVERSAL', 'ADJUSTMENT')
    .description(
      'EARN (order delivered, PENDING first) · CASHBACK (first UPI top-up) · MATURE (pending → available, delta 0) · CONVERT (to wallet money) · EXPIRE · REVERSAL (refund took points back) · ADJUSTMENT',
    ),
  deltaPts: Joi.number().integer().example(4805).description('"+4,805 Pts" / "-5,000 Pts"'),
  points: Joi.number().integer(),
  title: Joi.string().example('Order reward'),
  subtitle: Joi.string().allow(null).example('ORD-26-0091842'),
  availableAfter: Joi.number().integer().example(18420).description('"Bal: 18,420"'),
  pendingAfter: Joi.number().integer(),
  createdAt: Joi.date().iso(),
}).meta({ className: 'PointsEntry' });

export const REWARD_DOCS = {
  summary: {
    tag: REWARDS_TAG,
    summary: 'My reward points ("18,420 Reward Points · Worth ₹1,842")',
    description:
      'Straight from the points ledger. `pendingPts` = earned on delivered orders, spendable after the hold (refund window). `debtPts` > 0 only after a refund took back more points than were left (the next points earned settle it first). `expiringSoon` = points expiring in the next 30 days.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Points summary',
      data: Joi.object({
        availablePts: Joi.number().integer(),
        valuePaise: Joi.number().integer(),
        value: Joi.string(),
        pendingPts: Joi.number().integer(),
        debtPts: Joi.number().integer(),
        lifetimeEarned: Joi.number().integer(),
        expiringSoon: Joi.object({
          points: Joi.number().integer(),
          firstExpiresAt: Joi.date().iso().allow(null),
          withinDays: Joi.number().integer(),
        }),
        conversion: Joi.object({
          pointValuePaise: Joi.number().integer().description('10 = 10 points per ₹1'),
          minPoints: Joi.number().integer(),
          stepPoints: Joi.number().integer(),
          eligible: Joi.boolean().description('availablePts ≥ minPoints'),
        }),
      }).meta({ className: 'RewardsSummary' }),
      example: ok({
        availablePts: 18420,
        valuePaise: 184200,
        value: '1842.00',
        pendingPts: 4805,
        debtPts: 0,
        lifetimeEarned: 31205,
        expiringSoon: { points: 278, firstExpiresAt: '2026-12-04T00:00:00.000Z', withinDays: 30 },
        conversion: { pointValuePaise: 10, minPoints: 1000, stepPoints: 100, eligible: true },
      }),
    },
    errors: [429],
  },
  ledger: {
    tag: REWARDS_TAG,
    summary: 'Points Ledger (newest first, cursor pages)',
    description:
      'Every points movement, newest first. Group by `createdAt` month on the client. `availableAfter` is the "Bal:" column.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Entries',
      data: entrySchema,
      paginated: true,
      example: {
        success: true,
        data: [
          {
            id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8a01',
            journalNo: 'PJ-261005-1A2B3C4D',
            kind: 'EARN',
            deltaPts: 4805,
            points: 4805,
            title: 'Order reward',
            subtitle: 'ORD-26-0091842',
            availableAfter: 18420,
            pendingAfter: 4805,
            createdAt: '2026-10-05T06:40:00.000Z',
          },
        ],
        meta: { nextCursor: null, limit: 20 },
      },
    },
    errors: [422, 429],
  },
  convert: {
    tag: REWARDS_TAG,
    summary: 'Convert points to wallet money ("Convert →")',
    description:
      '**`Idempotency-Key` header required.** Points (soonest-expiring first) are taken and the wallet is credited (`pointValuePaise` each) in ONE transaction — both or neither. Same key + same body replays the first result; same key + other body → 422 `IDEMPOTENCY_KEY_REUSED`. 422 `BELOW_MINIMUM` · `NOT_A_MULTIPLE` · `INSUFFICIENT_POINTS`. The wallet statement shows "Points Redeemed to Cash".',
    auth: AUTH_CUSTOMER,
    rateLimit: '5 per user per minute',
    requestExample: { points: 5000 },
    success: {
      status: 200,
      description: 'Converted',
      data: Joi.object({
        pointsJournalNo: Joi.string(),
        walletJournalNo: Joi.string(),
        points: Joi.number().integer(),
        creditedPaise: Joi.number().integer(),
        credited: Joi.string(),
        availablePtsAfter: Joi.number().integer(),
        walletBalanceAfterPaise: Joi.number().integer(),
        replayed: Joi.boolean(),
      }).meta({ className: 'PointsConversion' }),
      example: ok({
        pointsJournalNo: 'PJ-261002-77AA10C2',
        walletJournalNo: 'WJ-261002-5E61B0D9',
        points: 5000,
        creditedPaise: 50000,
        credited: '500.00',
        availablePtsAfter: 13420,
        walletBalanceAfterPaise: 12489265,
        replayed: false,
      }),
    },
    errors: [400, 422, 503],
    errorExamples: {
      422: {
        message: 'Not enough points',
        details: {
          reason: 'INSUFFICIENT_POINTS',
          availablePts: 820,
          minPoints: 1000,
          stepPoints: 100,
        },
      },
    },
  },
} satisfies Record<string, RouteDocs>;
