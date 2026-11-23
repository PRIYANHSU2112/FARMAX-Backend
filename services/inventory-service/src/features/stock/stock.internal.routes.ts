import { ok } from '@farmx/common/response';
import type { FastifyPluginAsync } from 'fastify';

import { internalGuard } from '../../middleware/guards.js';

/**
 * Mounted at `/internal/inventory` (service token; never routed by the gateway, not in Swagger).
 * warehouse-service pulls these figures every minute for the W2 screens (D-56 P3).
 */
export const stockInternalRoutes: FastifyPluginAsync = async (app) => {
  const guard = internalGuard(app);
  if (guard === null) return;
  app.get('/warehouse-stats', { schema: { hide: true }, onRequest: [guard] }, async (req) =>
    ok(await req.diScope.resolve('stockService').warehouseStats()),
  );
};
