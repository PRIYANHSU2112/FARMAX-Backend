import { internalAuth } from '@farmx/common/middleware';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

/**
 * Mounted at `/internal/access`, service-to-service only (never routed by the gateway).
 * Not registered when INTERNAL_SERVICE_TOKEN is unset.
 *   GET /:userId/permissions   other services call it when auth's Redis permission cache
 *                              misses (proposed D-23); the call re-populates that cache.
 *                              `warehouses` = extra grants per warehouse (D-56).
 *   GET /recipients            ACTIVE staff holding a permission (GLOBAL, or at one warehouse):
 *                              notification-service PERMISSION audiences.
 *   GET /scope-members         active members of one warehouse and their roles there
 *                              (warehouse-service Team screen, D-56).
 *   GET /warehouse-roles       roles that can be granted at a warehouse, with usage (D-56).
 */
export const accessInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  // onRequest: callers without the token learn nothing about the API (runs before validation).
  const guard = internalAuth(token);

  app.get<{ Params: { userId: string } }>(
    '/:userId/permissions',
    {
      schema: {
        hide: true,
        params: Joi.object({ userId: Joi.string().guid().required() }),
      },
      onRequest: [guard],
    },
    async (request) => {
      const access = await request.diScope
        .resolve('accessService')
        .getUserAccess(request.params.userId);
      return {
        success: true,
        data: { permissions: access.permissions, warehouses: access.warehouses },
      };
    },
  );

  app.get<{ Querystring: { permission: string; warehouseId?: string } }>(
    '/recipients',
    {
      schema: {
        hide: true,
        querystring: Joi.object({
          permission: Joi.string()
            .pattern(/^[a-z_]+\.[a-z_]+$/)
            .max(80)
            .required(),
          warehouseId: Joi.string().guid(),
        }),
      },
      onRequest: [guard],
    },
    async (request) => {
      const { permission, warehouseId } = request.query;
      const holders = await request.diScope
        .resolve('accessService')
        .listPermissionHolderIds(permission, warehouseId ?? null);
      const userIds = await request.diScope
        .resolve('usersService')
        .filterActiveIds(holders, 'INTERNAL');
      return { success: true, data: { userIds } };
    },
  );

  app.get<{ Querystring: { scopeType: 'WAREHOUSE'; scopeId: string } }>(
    '/scope-members',
    {
      schema: {
        hide: true,
        querystring: Joi.object({
          scopeType: Joi.string().valid('WAREHOUSE').required(),
          scopeId: Joi.string().guid().required(),
        }),
      },
      onRequest: [guard],
    },
    async (request) => {
      const { scopeType, scopeId } = request.query;
      const members = await request.diScope
        .resolve('accessService')
        .listScopeMembers(scopeType, scopeId);
      return { success: true, data: { members } };
    },
  );

  app.get('/warehouse-roles', { schema: { hide: true }, onRequest: [guard] }, async (request) => {
    const roles = await request.diScope.resolve('accessService').listWarehouseRoleTemplates();
    return { success: true, data: { roles } };
  });
};
