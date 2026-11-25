import { paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { type Audience, audRead } from '../../middleware/guards.js';
import { auditDocs } from './audit.docs.js';
import { auditQuery } from './audit.validation.js';

interface AuditQuery {
  targetType?: string;
  targetId?: string;
  actorUserId?: string;
  cursor?: string;
  limit: number;
}

/** `GET /audit` on both panels (same handler). */
export const auditRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = auditDocs(aud);
    app.get<{ Querystring: AuditQuery }>(
      '/audit',
      { schema: { ...auditQuery, ...routeDocs(D.list) }, preHandler: audRead(aud, 'quality.view') },
      async (req) => paginated(await req.diScope.resolve('auditService').list(req.query)),
    );
  };
