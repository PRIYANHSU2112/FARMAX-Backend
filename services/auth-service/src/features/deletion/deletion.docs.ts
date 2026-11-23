import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { USER_TAG } from '../sessions/index.js';
import { AUTH_TAG } from '../tokens/index.js';

const requestSchema = Joi.object({
  id: Joi.string().guid(),
  status: Joi.string().valid('PENDING', 'CANCELLED', 'COMPLETED'),
  requestedAt: Joi.date().iso(),
  scheduledFor: Joi.date().iso().description('Personal data is erased after this moment'),
}).meta({ className: 'AccountDeletionRequest' });

const AUTH =
  'Bearer access token (full scope) of a customer, vendor or logistics user. Staff accounts are closed by an administrator (403).';

export const DELETION_DOCS = {
  status: {
    tag: USER_TAG,
    auth: AUTH,
    summary: 'Delete Account screen',
    description: 'Pending request (if any), the grace period and the "You will lose" list.',
    success: {
      status: 200,
      description: 'Status',
      data: Joi.object({
        request: requestSchema.allow(null),
        graceDays: Joi.number().integer().example(30),
        youWillLose: Joi.array().items(Joi.string()),
      }),
    },
  },
  otp: {
    tag: USER_TAG,
    auth: AUTH,
    summary: 'Send the delete-confirmation OTP',
    description: 'Step-up check: a code to the account\'s verified phone, needed by "Yes, Delete".',
    rateLimit: '5 per user per hour (+ 60 s resend cooldown)',
    success: {
      status: 200,
      description: 'Sent',
      data: Joi.object({
        sent: Joi.boolean(),
        destination: Joi.string().example('+91******4417'),
        expiresIn: Joi.number(),
        resendAfter: Joi.number(),
      }),
    },
    errors: [422],
  },
  request: {
    tag: USER_TAG,
    auth: AUTH,
    summary: 'Delete my account ("Yes, Delete")',
    description:
      'Schedules deletion after the grace period (default 30 days). At once: the account becomes PENDING_DELETION, **every session ends** (all access tokens stop working in every service, live-chat sockets close) and normal login answers 403 `ACCOUNT_PENDING_DELETION`. To change your mind use **account recovery** (OTP → recovery token → cancel). After the grace period personal data is erased and `user.deleted.v1` tells every service to scrub its copies.',
    rateLimit: '10 per user per hour',
    requestExample: { otp: '123456', reason: 'Not farming any more' },
    success: {
      status: 201,
      description: 'Scheduled',
      data: Joi.object({ request: requestSchema, graceDays: Joi.number().integer() }),
    },
    errors: [401, 409, 422],
  },
  recoveryOtp: {
    tag: AUTH_TAG,
    public: true,
    summary: 'Account recovery — send OTP',
    description:
      'For an account scheduled for deletion. Always answers `{ sent: true }` (no account enumeration).',
    rateLimit: '5 per phone and 20 per IP per hour',
    requestExample: { phone: '+919876544417' },
    success: { status: 200, description: 'Accepted', data: Joi.object({ sent: Joi.boolean() }) },
    errors: [422],
  },
  recoveryVerify: {
    tag: AUTH_TAG,
    public: true,
    summary: 'Account recovery — verify OTP',
    description:
      'Returns a single-use **recovery token** (10 minutes). It is not an access token: it only works on `cancel-deletion`.',
    rateLimit: '10 per phone and 30 per IP per hour',
    requestExample: { phone: '+919876544417', code: '123456' },
    success: {
      status: 200,
      description: 'Recovery token',
      data: Joi.object({
        recoveryToken: Joi.string(),
        expiresIn: Joi.number().integer().example(600),
      }),
    },
    errors: [401, 422],
  },
  cancel: {
    tag: AUTH_TAG,
    public: true,
    summary: 'Account recovery — cancel the deletion',
    description:
      'Consumes the recovery token (single use) and restores the account to ACTIVE. Then log in normally (OTP login); old sessions stay ended.',
    rateLimit: '20 per IP per hour',
    requestExample: { recoveryToken: '<from /auth/account-recovery/verify>' },
    success: {
      status: 200,
      description: 'Restored',
      data: Joi.object({ restored: Joi.boolean() }),
    },
    errors: [401, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
