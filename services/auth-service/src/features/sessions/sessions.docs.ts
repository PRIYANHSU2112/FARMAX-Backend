import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

/** Self-service section in Swagger (the logged-in user's own resources). */
export const USER_TAG = 'User';

export const sessionSchema = Joi.object({
  id: Joi.string().guid(),
  deviceId: Joi.string().guid().allow(null),
  ip: Joi.string().allow(null).example('203.0.113.10'),
  userAgent: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
  lastUsedAt: Joi.date().iso(),
  idleExpiresAt: Joi.date().iso(),
  absoluteExpiresAt: Joi.date().iso(),
  current: Joi.boolean().description('true for the session making this request'),
}).meta({ className: 'Session' });

const example = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e10',
  deviceId: null,
  ip: '203.0.113.10',
  userAgent: 'FarmX/1.0 (Android 14)',
  createdAt: '2026-11-11T05:00:00.000Z',
  lastUsedAt: '2026-11-11T06:00:00.000Z',
  idleExpiresAt: '2026-12-11T06:00:00.000Z',
  absoluteExpiresAt: '2027-02-09T05:00:00.000Z',
  current: true,
};

export const SESSIONS_DOCS = {
  list: {
    tag: USER_TAG,
    summary: 'My active sessions',
    description: 'Every device/browser where you are logged in (max 100, most recent first).',
    success: {
      status: 200,
      description: 'Active sessions',
      data: Joi.array().items(sessionSchema),
      example: { success: true, data: [example] },
    },
  },
  revoke: {
    tag: USER_TAG,
    summary: 'Log out one session',
    description:
      'Ends that session: its refresh token stops working and its access tokens are blocked.',
    success: { status: 204, description: 'Revoked' },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
