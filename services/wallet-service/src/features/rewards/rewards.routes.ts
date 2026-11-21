import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { AuthUser } from '@farmx/common/types';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { customerRead, customerWrite } from '../../middleware/guards.js';
import { idempotencyKeyOf, requestHash } from '../../middleware/http.js';
import { REWARD_DOCS } from './rewards.docs.js';
import type { ConvertInput } from './rewards.types.js';
import { convertSchema, ledgerSchema } from './rewards.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('rewardsService');
const userOf = (req: FastifyRequest): AuthUser => {
  if (req.user === null) throw new UnauthorizedError();
  return req.user;
};

/** Mounted at `/rewards` (gateway: `/v1/rewards`). Customers, own points only. */
export const rewardsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { schema: { ...routeDocs(REWARD_DOCS.summary) }, preHandler: customerRead },
    async (req) => ok(await svc(req).summary(userOf(req).id)),
  );

  app.get<{ Querystring: { cursor?: string; limit: number } }>(
    '/ledger',
    { schema: { ...ledgerSchema, ...routeDocs(REWARD_DOCS.ledger) }, preHandler: customerRead },
    async (req) => paginated(await svc(req).ledger(userOf(req).id, req.query)),
  );

  app.post<{ Body: ConvertInput }>(
    '/convert',
    {
      schema: { ...convertSchema, ...routeDocs(REWARD_DOCS.convert) },
      preHandler: customerWrite('points-convert', 5),
    },
    async (req) => {
      const key = idempotencyKeyOf(req);
      return ok(await svc(req).convert(userOf(req), key, requestHash(req.body), req.body));
    },
  );
};
