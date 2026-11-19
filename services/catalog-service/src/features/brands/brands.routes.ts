import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit } from '../../middleware/guards.js';
import type { IdParams, SlugOrIdParams } from './brands.controller.js';
import { BRAND_DOCS } from './brands.docs.js';
import type {
  AdminBrandListQuery,
  BrandListQuery,
  CreateBrandInput,
  SetBrandStatusInput,
  UpdateBrandInput,
} from './brands.types.js';
import {
  adminListSchema,
  createSchema,
  deleteSchema,
  historySchema,
  idParamsSchema,
  publicListSchema,
  slugOrIdParamsSchema,
  statusSchema,
  updateSchema,
} from './brands.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('brandsController');

/** Mounted at `/catalog/brands` (gateway `/v1/catalog/brands`). Public storefront reads. */
export const brandsRoutes: FastifyPluginAsync = async (app) => {
  const limit = rateLimit('brand-read', 120, 60);

  app.get<{ Querystring: BrandListQuery }>(
    '/',
    { schema: { ...publicListSchema, ...routeDocs(BRAND_DOCS.publicList) }, preHandler: limit },
    (req, reply) => c(req).publicList(req, reply),
  );

  app.get<{ Params: SlugOrIdParams }>(
    '/:slugOrId',
    {
      schema: { ...slugOrIdParamsSchema, ...routeDocs(BRAND_DOCS.publicDetail) },
      preHandler: limit,
    },
    (req, reply) => c(req).publicDetail(req, reply),
  );
};

/** Mounted at `/admin/catalog/brands` (gateway `/v1/admin/catalog/brands`). */
export const brandsAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');

  app.get<{ Querystring: AdminBrandListQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(BRAND_DOCS.list) }, preHandler: manage },
    (req) => c(req).list(req),
  );

  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParamsSchema, ...routeDocs(BRAND_DOCS.get) }, preHandler: manage },
    (req, reply) => c(req).get(req, reply),
  );

  app.get<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>(
    '/:id/history',
    { schema: { ...historySchema, ...routeDocs(BRAND_DOCS.history) }, preHandler: manage },
    (req) => c(req).history(req),
  );

  app.post<{ Body: CreateBrandInput }>(
    '/',
    { schema: { ...createSchema, ...routeDocs(BRAND_DOCS.create) }, preHandler: manage },
    (req, reply) => c(req).create(req, reply),
  );

  app.patch<{ Params: IdParams; Body: UpdateBrandInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(BRAND_DOCS.update) }, preHandler: manage },
    (req, reply) => c(req).update(req, reply),
  );

  app.patch<{ Params: IdParams; Body: SetBrandStatusInput }>(
    '/:id/status',
    { schema: { ...statusSchema, ...routeDocs(BRAND_DOCS.status) }, preHandler: manage },
    (req, reply) => c(req).setStatus(req, reply),
  );

  app.delete<{ Params: IdParams; Querystring: { reason: string } }>(
    '/:id',
    { schema: { ...deleteSchema, ...routeDocs(BRAND_DOCS.remove) }, preHandler: manage },
    (req, reply) => c(req).remove(req, reply),
  );
};
