import { internalAuth } from '@farmx/common/middleware';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

/**
 * Mounted at `/internal/access` — service-to-service only (never routed by the gateway).
 * Other services call it when auth's Redis permission cache misses (proposed D-23); the call
 * itself re-populates that cache. Not registered when INTERNAL_SERVICE_TOKEN is unset.
 */
export const accessInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;

  app.get<{ Params: { userId: string } }>(
    '/:userId/permissions',
    {
      schema: {
        hide: true,
        params: Joi.object({ userId: Joi.string().guid().required() }),
      },
      preHandler: [internalAuth(token)],
    },
    async (request) => {
      const access = await request.diScope
        .resolve('accessService')
        .getUserAccess(request.params.userId);
      return { success: true, data: { permissions: access.permissions } };
    },
  );
};
