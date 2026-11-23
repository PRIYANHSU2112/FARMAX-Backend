import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead } from '../../middleware/guards.js';
import { idParams } from '../../middleware/http.js';
import { STATS_DOCS } from './stats.docs.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('statsService');

/** Mounted at `/admin/warehouses`: W2.03 overview cards and stock tab. */
export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/:id/overview',
    {
      schema: { ...idParams, ...routeDocs(STATS_DOCS.overview) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).overview(callerOf(req), req.params.id)),
  );
  app.get<{ Params: { id: string } }>(
    '/:id/stock-by-category',
    {
      schema: { ...idParams, ...routeDocs(STATS_DOCS.stockByCategory) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => ok(await svc(req).stockByCategory(callerOf(req), req.params.id)),
  );
};
