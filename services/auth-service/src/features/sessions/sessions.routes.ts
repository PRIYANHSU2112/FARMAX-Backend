import { UnauthorizedError } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { SESSIONS_DOCS } from './sessions.docs.js';
import { revokeOwnSessionSchema } from './sessions.validation.js';

const userOf = (request: FastifyRequest) => {
  if (request.user === null) throw new UnauthorizedError();
  return request.user;
};

/** Mounted at `/me/sessions`. Thin handlers: the service holds the logic. */
export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { schema: routeDocs(SESSIONS_DOCS.list), preHandler: [requireAuth] },
    async (request) => {
      const user = userOf(request);
      return ok(
        await request.diScope.resolve('sessionsService').listForUser(user.id, user.sessionId),
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: { ...revokeOwnSessionSchema, ...routeDocs(SESSIONS_DOCS.revoke) },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      await request.diScope
        .resolve('sessionsService')
        .revokeOwnSession(userOf(request).id, request.params.id);
      return reply.code(204).send();
    },
  );
};
