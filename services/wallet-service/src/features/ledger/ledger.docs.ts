import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_CUSTOMER, ok } from '../../docs/shared.js';
import { CATEGORIES, KINDS } from './ledger.validation.js';

export const WALLET_TAG = 'Wallet';

const balanceSchema = Joi.object({
  balancePaise: Joi.number()
    .integer()
    .example(12489265)
    .description('Integer paise (source of truth)'),
  balance: Joi.string().example('124892.65').description('Rupees, 2 decimals (display)'),
  currency: Joi.string().example('INR'),
  status: Joi.string()
    .valid('ACTIVE', 'FROZEN')
    .description('FROZEN: spending is blocked; refunds still land'),
  frozenReason: Joi.string().allow(null),
  week: Joi.object({
    creditsPaise: Joi.number().integer().description('Money in during the last 7 days'),
    credits: Joi.string().example('9684.20'),
    changePercent: Joi.string()
      .allow(null)
      .example('8.42')
      .description('Balance change vs. 7 days ago (null when it was ₹0)'),
  }),
}).meta({ className: 'WalletBalance' });

const transactionSchema = Joi.object({
  id: Joi.string().guid(),
  journalNo: Joi.string().example('WJ-261006-3C1D2E4F'),
  kind: Joi.string().valid(...KINDS),
  category: Joi.string()
    .valid(...CATEGORIES)
    .description('Filter chip: TOPUPS · PURCHASES · REFUNDS · REWARDS · ADJUSTMENTS'),
  direction: Joi.string().valid('CREDIT', 'DEBIT'),
  amountPaise: Joi.number().integer().example(112000).description('Signed: + in, − out'),
  amount: Joi.string().example('1120.00'),
  title: Joi.string().example('Cold Box Damage Refund'),
  subtitle: Joi.string().allow(null).example('Tanuku C&F'),
  statusLabel: Joi.string()
    .example('Direct Credit')
    .description('Wallet Added · Completed · Refunded · Direct Credit · Debited · Reversed'),
  balanceAfterPaise: Joi.number().integer().allow(null),
  refType: Joi.string().allow(null),
  refId: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'WalletTransaction' });

const txExample = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6b01',
  journalNo: 'WJ-261004-5E61B0D9',
  kind: 'ORDER_DEBIT',
  category: 'PURCHASES',
  direction: 'DEBIT',
  amountPaise: -125000,
  amount: '-1250.00',
  title: 'Used at Checkout',
  subtitle: 'ORD-26-0091857',
  statusLabel: 'Completed',
  balanceAfterPaise: 12489265,
  refType: 'PAYMENT',
  refId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9e01',
  createdAt: '2026-10-04T04:00:00.000Z',
};

export const LEDGER_DOCS = {
  transactions: {
    tag: WALLET_TAG,
    summary: 'Wallet Statement / Transaction History (newest first, cursor pages)',
    description:
      'Own wallet movements, newest first. Filters: `category` (chips), `from` (inclusive) / `to` (exclusive) ISO dates. Group by month on the client ("OCTOBER 2026").',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'A page of transactions',
      data: transactionSchema,
      paginated: true,
      example: { success: true, data: [txExample], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422, 429],
  },
  transactionCounts: {
    tag: WALLET_TAG,
    summary: 'Filter-chip counts ("All Entries (24)", "Refunds", …)',
    description: 'Counts per category for the same optional date range.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Counts',
      data: Joi.object({
        all: Joi.number().integer(),
        byCategory: Joi.object(
          Object.fromEntries(CATEGORIES.map((c) => [c, Joi.number().integer()])),
        ),
      }).meta({ className: 'WalletTransactionCounts' }),
      example: ok({
        all: 24,
        byCategory: { TOPUPS: 6, PURCHASES: 11, REFUNDS: 3, REWARDS: 3, ADJUSTMENTS: 1 },
      }),
    },
    errors: [422, 429],
  },
  transaction: {
    tag: WALLET_TAG,
    summary: 'One wallet transaction',
    description: 'Own transactions only; any other id answers 404.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Transaction',
      data: transactionSchema,
      example: ok(txExample),
    },
    errors: [404, 422, 429],
  },
  balance: {
    tag: WALLET_TAG,
    summary: 'My wallet balance',
    description:
      'Read from the PostgreSQL ledger (never a cache). `week` drives "+₹9,684.20 this week" and "+8.42%". A customer who never received money has ₹0 and status ACTIVE. Closed-loop wallet: money can only be spent on FarmX orders (no transfer or withdrawal).',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Balance',
      data: balanceSchema,
      example: ok({
        balancePaise: 12489265,
        balance: '124892.65',
        currency: 'INR',
        status: 'ACTIVE',
        frozenReason: null,
        week: { creditsPaise: 968420, credits: '9684.20', changePercent: '8.42' },
      }),
    },
    errors: [401, 403, 429],
  },
} satisfies Record<string, RouteDocs>;
