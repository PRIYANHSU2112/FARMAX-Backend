import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUDIT_TARGET_TYPES } from './audit.types.js';

export const ADMIN_AUDIT_TAG = 'Admin Audit Logs';

/** Response schema (docs only), published as the reusable `AuditLog` component. */
const auditLogSchema = Joi.object({
  id: Joi.string().guid(),
  actorUserId: Joi.string().guid().description('Who did it (nil uuid = system)'),
  action: Joi.string().example('user.status_changed').description('<target>.<verb>'),
  targetType: Joi.string()
    .valid(...AUDIT_TARGET_TYPES)
    .meta({ className: 'AuditTargetType' }),
  targetId: Joi.string().guid(),
  subjectUserId: Joi.string().guid().allow(null),
  before: Joi.object().unknown(true).allow(null),
  after: Joi.object().unknown(true).allow(null),
  reason: Joi.string().allow(null),
  metadata: Joi.object().unknown(true).allow(null),
  ip: Joi.string().allow(null),
  userAgent: Joi.string().allow(null),
  requestId: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'AuditLog' });

const exampleEntry = {
  id: '0193a5f3-0000-7000-8000-00000000a001',
  actorUserId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e00',
  action: 'user.status_changed',
  targetType: 'user',
  targetId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01',
  subjectUserId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01',
  before: { status: 'ACTIVE' },
  after: { status: 'SUSPENDED' },
  reason: 'Policy breach',
  metadata: { revokedSessions: 2 },
  ip: '203.0.113.10',
  userAgent: 'Mozilla/5.0',
  requestId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e6f',
  createdAt: '2026-11-11T06:00:00.000Z',
};

export const AUDIT_DOCS = {
  list: {
    tag: ADMIN_AUDIT_TAG,
    summary: 'List admin audit log entries',
    description:
      'Append-only log of every admin change. Newest first, cursor pagination. ' +
      'Filter by actor, affected user, target, action and time range (`from` ≤ createdAt < `to`).',
    permission: 'audit_logs.view',
    success: {
      status: 200,
      description: 'A page of audit entries',
      data: auditLogSchema,
      paginated: true,
      example: { success: true, data: [exampleEntry], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
