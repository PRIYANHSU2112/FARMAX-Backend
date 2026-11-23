import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

import { callerOf, rateLimit, staffOnly, staffRead } from '../../middleware/guards.js';
import { PORTAL_DOCS } from './portal.docs.js';

/** Mounted at `/admin/wms` (gateway `/v1/admin/wms`): the portal shell. */
export const portalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { schema: routeDocs(PORTAL_DOCS.me), preHandler: staffOnly }, async (req) =>
    ok(await req.diScope.resolve('portalService').me(callerOf(req), req.user?.roles ?? [])),
  );
  app.get<{ Querystring: { q: string } }>(
    '/search',
    {
      schema: {
        querystring: Joi.object({ q: Joi.string().trim().min(2).max(60).required() }),
        ...routeDocs(PORTAL_DOCS.search),
      },
      preHandler: [...staffRead('warehouse.view'), rateLimit('search', 60, 60)],
    },
    async (req) =>
      ok(await req.diScope.resolve('portalService').search(callerOf(req), req.query.q)),
  );
};
