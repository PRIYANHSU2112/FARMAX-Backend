import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../access/index.js';
import { AUDIT_DOCS } from './audit.docs.js';
import type { AuditListQuery } from './audit.types.js';
import { listAuditLogsSchema } from './audit.validation.js';

/** Mounted at `/admin/audit-logs`. */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: AuditListQuery }>(
    '/',
    {
      schema: { ...listAuditLogsSchema, ...routeDocs(AUDIT_DOCS.list) },
      preHandler: [requireAuth, requirePermission(AUDIT_DOCS.list.permission)],
    },
    (request) => request.diScope.resolve('auditController').list(request),
  );
};
