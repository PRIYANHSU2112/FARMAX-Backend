import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { idempotencyKeyOf, requestHash } from '../../middleware/http.js';
import { type Actor, actorOf } from '../audit/index.js';
import { ADJUSTMENT_DOCS } from './adjustments.docs.js';
import type { AdjustmentListQuery, CreateAdjustmentInput } from './adjustments.types.js';
import {
  approveSchema,
  createAdjustmentSchema,
  getAdjustmentSchema,
  listAdjustmentsSchema,
  rejectSchema,
} from './adjustments.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('adjustmentsService');
const staffOf = (req: FastifyRequest): Actor & { userId: string } => {
  const actor = actorOf(req);
  if (actor.userId === null) throw new UnauthorizedError();
  return { ...actor, userId: actor.userId };
};

/** Mounted at `/admin/wallet/adjustments` (gateway: `/v1/admin/wallet/adjustments`). Staff. */
export const adjustmentsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: AdjustmentListQuery }>(
    '/',
    {
      schema: { ...listAdjustmentsSchema, ...routeDocs(ADJUSTMENT_DOCS.list) },
      preHandler: admin('wallet.view'),
    },
    async (req) => paginated(await svc(req).list(req.query)),
  );

  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: { ...getAdjustmentSchema, ...routeDocs(ADJUSTMENT_DOCS.get) },
      preHandler: admin('wallet.view'),
    },
    async (req) => ok(await svc(req).get(req.params.id)),
  );

  app.post<{ Body: CreateAdjustmentInput }>(
    '/',
    {
      schema: { ...createAdjustmentSchema, ...routeDocs(ADJUSTMENT_DOCS.create) },
      preHandler: adminWrite('wallet.adjust'),
    },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const view = await svc(req).create(staffOf(req), key, requestHash(req.body), req.body);
      return reply.status(201).send(ok(view));
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/approve',
    {
      schema: { ...approveSchema, ...routeDocs(ADJUSTMENT_DOCS.approve) },
      preHandler: adminWrite('wallet.approve'),
    },
    async (req) => ok(await svc(req).approve(staffOf(req), req.params.id, req.body.reason ?? null)),
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/reject',
    {
      schema: { ...rejectSchema, ...routeDocs(ADJUSTMENT_DOCS.reject) },
      preHandler: adminWrite('wallet.approve'),
    },
    async (req) => ok(await svc(req).reject(staffOf(req), req.params.id, req.body.reason)),
  );
};
