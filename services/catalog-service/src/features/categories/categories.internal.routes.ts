import { internalAuth } from '@farmx/common/middleware';
import { ok } from '@farmx/common/response';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

/**
 * Mounted at `/internal/catalog/categories` (never routed by the gateway, D-27; not in Swagger).
 * product-service validates category assignments against the database, not the cache.
 */
export const categoriesInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;

  app.get<{ Params: { id: string } }>(
    '/:id/context',
    {
      schema: { hide: true, params: Joi.object({ id: Joi.string().guid().required() }) },
      preHandler: [internalAuth(token)],
    },
    async (request) =>
      ok(await request.diScope.resolve('categoriesService').internalContext(request.params.id)),
  );
};
