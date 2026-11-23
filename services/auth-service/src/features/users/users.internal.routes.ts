import { NotFoundError } from '@farmx/common/errors';
import { internalAuth } from '@farmx/common/middleware';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

import { USER_TYPES, type UserType } from './users.types.js';

const ID = Joi.string().guid();

/**
 * Mounted at `/internal/users`, service-to-service only (never routed by the gateway, hidden
 * from docs). notification-service resolves delivery addresses and APP-wide audiences here.
 * Not registered when INTERNAL_SERVICE_TOKEN is unset.
 */
export const usersInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  const guard = internalAuth(token);

  app.get<{ Params: { id: string } }>(
    '/:id/contact',
    { schema: { hide: true, params: Joi.object({ id: ID.required() }) }, onRequest: [guard] },
    async (request) => {
      const contact = await request.diScope.resolve('usersService').getContact(request.params.id);
      if (contact === null) throw new NotFoundError('User not found');
      return { success: true, data: contact };
    },
  );

  // POST (not GET): up to 100 ids do not fit a query string. warehouse-service team / manager names.
  app.post<{ Body: { ids: string[] } }>(
    '/contacts',
    {
      schema: {
        hide: true,
        body: Joi.object({
          ids: Joi.array().items(ID.required()).min(1).max(100).unique().required(),
        }),
      },
      onRequest: [guard],
    },
    async (request) => {
      const contacts = await request.diScope.resolve('usersService').getContacts(request.body.ids);
      return { success: true, data: { contacts } };
    },
  );

  app.get<{ Querystring: { userType: UserType; cursor?: string; limit: number } }>(
    '/ids',
    {
      schema: {
        hide: true,
        querystring: Joi.object({
          userType: Joi.string()
            .valid(...USER_TYPES)
            .required(),
          cursor: ID,
          limit: Joi.number().integer().min(1).max(1000).default(500),
        }),
      },
      onRequest: [guard],
    },
    async (request) => {
      const { userType, cursor, limit } = request.query;
      const ids = await request.diScope
        .resolve('usersService')
        .listActiveIds(userType, cursor, limit);
      const nextCursor = ids.length === limit ? (ids.at(-1) ?? null) : null;
      return { success: true, data: { ids, nextCursor } };
    },
  );
};
