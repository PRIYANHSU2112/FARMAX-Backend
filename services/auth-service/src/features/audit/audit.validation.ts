import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

import { AUDIT_TARGET_TYPES } from './audit.types.js';

/** GET /admin/audit-logs */
export const listAuditLogsSchema = {
  querystring: Joi.object({
    cursor: Joi.string().guid(),
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
    actorUserId: Joi.string().guid(),
    subjectUserId: Joi.string().guid(),
    targetType: Joi.string().valid(...AUDIT_TARGET_TYPES),
    targetId: Joi.string().guid(),
    action: Joi.string().pattern(/^[a-z][a-z_]*\.[a-z][a-z_]*$/),
    from: Joi.date().iso(),
    to: Joi.date()
      .iso()
      .when('from', { is: Joi.exist(), then: Joi.date().greater(Joi.ref('from')) }),
  }),
};
