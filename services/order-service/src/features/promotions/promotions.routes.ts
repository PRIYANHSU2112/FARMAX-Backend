import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin } from '../../middleware/guards.js';
import type { IdParams } from './promotions.controller.js';
import { PROMOTION_DOCS } from './promotions.docs.js';
import type {
  CreatePromotionInput,
  PromotionListQuery,
  StatusInput,
  UpdatePromotionInput,
} from './promotions.types.js';
import {
  createPromotionSchema,
  getPromotionSchema,
  listPromotionsSchema,
  redemptionsSchema,
  statusSchema,
  updatePromotionSchema,
} from './promotions.validation.js';

const c = (req: FastifyRequest) => req.diScope.resolve('promotionsController');

/** Mounted at `/admin/promotions` (gateway: `/v1/admin/promotions`). Staff only. */
export const promotionsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: PromotionListQuery }>(
    '/',
    {
      schema: { ...listPromotionsSchema, ...routeDocs(PROMOTION_DOCS.list) },
      preHandler: admin('pricing.view'),
    },
    (req) => c(req).list(req),
  );
  app.post<{ Body: CreatePromotionInput }>(
    '/',
    {
      schema: { ...createPromotionSchema, ...routeDocs(PROMOTION_DOCS.create) },
      preHandler: admin('pricing.manage'),
    },
    (req, reply) => c(req).create(req, reply),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getPromotionSchema, ...routeDocs(PROMOTION_DOCS.get) },
      preHandler: admin('pricing.view'),
    },
    (req, reply) => c(req).get(req, reply),
  );
  app.patch<{ Params: IdParams; Body: UpdatePromotionInput }>(
    '/:id',
    {
      schema: { ...updatePromotionSchema, ...routeDocs(PROMOTION_DOCS.update) },
      preHandler: admin('pricing.manage'),
    },
    (req, reply) => c(req).update(req, reply),
  );
  app.post<{ Params: IdParams; Body: StatusInput }>(
    '/:id/status',
    {
      schema: { ...statusSchema, ...routeDocs(PROMOTION_DOCS.status) },
      preHandler: admin('pricing.manage'),
    },
    (req, reply) => c(req).status(req, reply),
  );
  app.get<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>(
    '/:id/redemptions',
    {
      schema: { ...redemptionsSchema, ...routeDocs(PROMOTION_DOCS.redemptions) },
      preHandler: admin('pricing.view'),
    },
    (req) => c(req).redemptions(req),
  );
};
