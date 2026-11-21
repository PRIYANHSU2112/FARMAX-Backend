import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, ok } from '../../docs/shared.js';
import { ADMIN_WALLET_TAG } from '../adjustments/index.js';

const accountSchema = Joi.object({
  userId: Joi.string().guid(),
  balancePaise: Joi.number().integer(),
  balance: Joi.string(),
  currency: Joi.string(),
  status: Joi.string().valid('ACTIVE', 'FROZEN'),
  frozenReason: Joi.string().allow(null),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'AdminWalletAccount' });

export const CONSOLE_DOCS = {
  accounts: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Customer wallets',
    description: 'Newest first. Filters: `status` (FROZEN = frozen wallets), `userId`.',
    auth: AUTH_ADMIN,
    permission: 'wallet.view',
    success: {
      status: 200,
      description: 'A page of wallets',
      data: accountSchema,
      paginated: true,
    },
    errors: [422],
  },
  account: {
    tag: ADMIN_WALLET_TAG,
    summary: 'One customer: wallet, points and latest movements',
    auth: AUTH_ADMIN,
    permission: 'wallet.view',
    success: {
      status: 200,
      description: 'Customer wallet',
      data: Joi.object({
        userId: Joi.string().guid(),
        wallet: Joi.object().unknown(true).description('Same shape as GET /v1/wallet'),
        points: Joi.object().unknown(true).description('Same shape as GET /v1/rewards'),
        recentTransactions: Joi.array().items(Joi.object().unknown(true)),
        recentPoints: Joi.array().items(Joi.object().unknown(true)),
      }),
    },
    errors: [422],
  },
  freeze: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Freeze a wallet',
    description:
      'Debits (wallet checkout, debit adjustments) are refused with `ACCOUNT_FROZEN`; refunds and credits still land. Reason required; audited.',
    auth: AUTH_ADMIN,
    permission: 'wallet.adjust',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Chargeback dispute under investigation' },
    success: { status: 200, description: 'Wallet after the change' },
    errors: [422],
  },
  unfreeze: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Unfreeze a wallet',
    description: 'Reason required; audited.',
    auth: AUTH_ADMIN,
    permission: 'wallet.adjust',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: "Dispute closed in the customer's favour" },
    success: { status: 200, description: 'Wallet after the change' },
    errors: [422],
  },
  journals: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Wallet journals (all customers)',
    description: 'Newest first. Filters: `userId`, `kind`, `category`, `from` / `to` (ISO).',
    auth: AUTH_ADMIN,
    permission: 'wallet.view',
    success: { status: 200, description: 'A page of journals', paginated: true },
    errors: [422],
  },
  settings: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Wallet and reward-points rules',
    description:
      'Top-up limits and chips, first-top-up cashback, point value, earn rate, hold, expiry, conversion minimum / step, adjustment limits.',
    auth: AUTH_ADMIN,
    permission: 'wallet.view',
    success: {
      status: 200,
      description: 'Settings',
      example: ok({
        topupMinPaise: 10000,
        topupMaxPaise: 5000000,
        topupDailyMaxPaise: 10000000,
        maxBalancePaise: 20000000,
        topupPresetsPaise: [50000, 70000, 90000, 100000, 200000, 500000],
        topupWindowMinutes: 30,
        firstTopupCashback: { enabled: true, method: 'upi', percentBps: 1000, maxPaise: 5000 },
        pointValuePaise: 10,
        pointsEarnPaisePerPoint: 1000,
        pointsHoldDays: 7,
        pointsExpiryMonths: 12,
        pointsMinConvert: 1000,
        pointsConvertStep: 100,
        pointsExpiryNoticeDays: 7,
        adjustmentMaxPaise: 10000000,
        adjustmentMaxPoints: 1000000,
      }),
    },
  },
  setSetting: {
    tag: ADMIN_WALLET_TAG,
    summary: 'Change one rule',
    description:
      'Validated like a read plus cross-field rules (min ≤ max, minimum convert a multiple of the step). Reason required; audited. Other replicas apply it within 15 s.',
    auth: AUTH_ADMIN,
    permission: 'wallet.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: { value: 7, reason: 'Returns window shortened to 7 days by policy' },
    success: { status: 200, description: 'All settings after the change' },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
