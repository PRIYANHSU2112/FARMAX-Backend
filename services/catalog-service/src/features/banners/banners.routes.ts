import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit } from '../../middleware/guards.js';
import type { CodeParams, IdParams, PageQuery } from './banners.controller.js';
import { BANNER_DOCS, PLACEMENT_DOCS } from './banners.docs.js';
import type {
  AdminBannerListQuery,
  AdminPlacementListQuery,
  CreateBannerInput,
  CreatePlacementInput,
  PublicBannerQuery,
  ReorderBannersInput,
  StatusInput,
  UpdateBannerInput,
  UpdatePlacementInput,
} from './banners.types.js';
import {
  bannerListSchema,
  codeParamsSchema,
  createBannerSchema,
  createPlacementSchema,
  deleteSchema,
  historySchema,
  idParamsSchema,
  placementListSchema,
  publicListSchema,
  reorderSchema,
  statusSchema,
  updateBannerSchema,
  updatePlacementSchema,
} from './banners.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('bannersController');

/** Mounted at `/catalog/banners` (gateway `/v1/catalog/banners`). Public, served from memory. */
export const bannersRoutes: FastifyPluginAsync = async (app) => {
  const limit = rateLimit('banner-read', 300, 60);

  app.get<{ Querystring: PublicBannerQuery }>(
    '/',
    { schema: { ...publicListSchema, ...routeDocs(BANNER_DOCS.publicList) }, preHandler: limit },
    (req, reply) => c(req).publicList(req, reply),
  );

  app.get<{ Params: CodeParams }>(
    '/placements/:code',
    { schema: { ...codeParamsSchema, ...routeDocs(BANNER_DOCS.publicByCode) }, preHandler: limit },
    (req, reply) => c(req).publicByCode(req, reply),
  );
};

/** Mounted at `/admin/catalog/banner-placements` (gateway `/v1/admin/catalog/banner-placements`). */
export const placementsAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');
  const D = PLACEMENT_DOCS;

  app.get<{ Querystring: AdminPlacementListQuery }>(
    '/',
    { schema: { ...placementListSchema, ...routeDocs(D.list) }, preHandler: manage },
    (req) => c(req).listPlacements(req),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParamsSchema, ...routeDocs(D.get) }, preHandler: manage },
    (req, reply) => c(req).getPlacement(req, reply),
  );
  app.get<{ Params: IdParams; Querystring: PageQuery }>(
    '/:id/history',
    { schema: { ...historySchema, ...routeDocs(D.history) }, preHandler: manage },
    (req) => c(req).placementHistory(req),
  );
  app.post<{ Body: CreatePlacementInput }>(
    '/',
    { schema: { ...createPlacementSchema, ...routeDocs(D.create) }, preHandler: manage },
    (req, reply) => c(req).createPlacement(req, reply),
  );
  app.patch<{ Params: IdParams; Body: UpdatePlacementInput }>(
    '/:id',
    { schema: { ...updatePlacementSchema, ...routeDocs(D.update) }, preHandler: manage },
    (req, reply) => c(req).updatePlacement(req, reply),
  );
  app.patch<{ Params: IdParams; Body: StatusInput }>(
    '/:id/status',
    { schema: { ...statusSchema, ...routeDocs(D.status) }, preHandler: manage },
    (req, reply) => c(req).setPlacementStatus(req, reply),
  );
  app.delete<{ Params: IdParams; Querystring: { reason: string } }>(
    '/:id',
    { schema: { ...deleteSchema, ...routeDocs(D.remove) }, preHandler: manage },
    (req, reply) => c(req).removePlacement(req, reply),
  );
};

/** Mounted at `/admin/catalog/banners` (gateway `/v1/admin/catalog/banners`). */
export const bannersAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');
  const D = BANNER_DOCS;

  app.get<{ Querystring: AdminBannerListQuery }>(
    '/',
    { schema: { ...bannerListSchema, ...routeDocs(D.list) }, preHandler: manage },
    (req) => c(req).listBanners(req),
  );
  app.post<{ Body: ReorderBannersInput }>(
    '/reorder',
    { schema: { ...reorderSchema, ...routeDocs(D.reorder) }, preHandler: manage },
    (req) => c(req).reorder(req),
  );
  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParamsSchema, ...routeDocs(D.get) }, preHandler: manage },
    (req, reply) => c(req).getBanner(req, reply),
  );
  app.get<{ Params: IdParams; Querystring: PageQuery }>(
    '/:id/history',
    { schema: { ...historySchema, ...routeDocs(D.history) }, preHandler: manage },
    (req) => c(req).bannerHistory(req),
  );
  app.post<{ Body: CreateBannerInput }>(
    '/',
    { schema: { ...createBannerSchema, ...routeDocs(D.create) }, preHandler: manage },
    (req, reply) => c(req).createBanner(req, reply),
  );
  app.patch<{ Params: IdParams; Body: UpdateBannerInput }>(
    '/:id',
    { schema: { ...updateBannerSchema, ...routeDocs(D.update) }, preHandler: manage },
    (req, reply) => c(req).updateBanner(req, reply),
  );
  app.patch<{ Params: IdParams; Body: StatusInput }>(
    '/:id/status',
    { schema: { ...statusSchema, ...routeDocs(D.status) }, preHandler: manage },
    (req, reply) => c(req).setBannerStatus(req, reply),
  );
  app.delete<{ Params: IdParams; Querystring: { reason: string } }>(
    '/:id',
    { schema: { ...deleteSchema, ...routeDocs(D.remove) }, preHandler: manage },
    (req, reply) => c(req).removeBanner(req, reply),
  );
};
