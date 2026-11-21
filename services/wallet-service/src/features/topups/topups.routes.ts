import { UnauthorizedError } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { AuthUser } from '@farmx/common/types';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { customerRead, customerWrite } from '../../middleware/guards.js';
import { idempotencyKeyOf, requestHash } from '../../middleware/http.js';
import { TOPUP_DOCS } from './topups.docs.js';
import type { CreateTopupInput } from './topups.types.js';
import { createTopupSchema, getTopupSchema } from './topups.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('topupsService');
const userOf = (req: FastifyRequest): AuthUser => {
  if (req.user === null) throw new UnauthorizedError();
  return req.user;
};

/** Mounted at `/wallet/topups` (gateway: `/v1/wallet/topups`). Customers, own top-ups only. */
export const topupsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/options',
    { schema: { ...routeDocs(TOPUP_DOCS.options) }, preHandler: customerRead },
    async (req) => ok(await svc(req).options(userOf(req))),
  );

  app.post<{ Body: CreateTopupInput }>(
    '/',
    {
      schema: { ...createTopupSchema, ...routeDocs(TOPUP_DOCS.create) },
      preHandler: customerWrite('topup-create', 10),
    },
    async (req) => {
      const key = idempotencyKeyOf(req);
      return ok(await svc(req).create(userOf(req), key, requestHash(req.body), req.body));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: { ...getTopupSchema, ...routeDocs(TOPUP_DOCS.get) },
      preHandler: customerWrite('topup-status', 30),
    },
    async (req) => ok(await svc(req).get(userOf(req), req.params.id)),
  );
};
