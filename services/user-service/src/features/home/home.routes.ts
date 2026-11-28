import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, optionalAuth, rateLimit } from '../../middleware/guards.js';
import type { IdParams } from './home.controller.js';
import { HOME_DOCS as D } from './home.docs.js';
import type {
  AdminListQuery,
  CreateLayoutInput,
  HomePage,
  PreviewQuery,
  PublishInput,
  ReasonInput,
  ReorderInput,
  ReplaceLayoutInput,
} from './home.types.js';
import {
  adminListSchema,
  categoriesPageSchema,
  createSchema,
  feedsSchema,
  historySchema,
  idParamsSchema,
  layoutSchema,
  previewSchema,
  publishSchema,
  reasonSchema,
  reorderSchema,
  replaceSchema,
  sectionPageSchema,
  sectionsBatchSchema,
} from './home.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('homeController');

/** A whole layout (30 sections × 50 items) can exceed the service's 64 KB default body limit. */
const LAYOUT_BODY_LIMIT = 1_048_576;

/**
 * Mounted at `/home` (gateway `/v1/home`). Public, optional auth (never 401). `/categories` is the
 * fixed-shape All Categories screen (one call). Rate limits per user
 * when the token is valid, else per IP. `optionalAuth` runs first so the limiter sees the user.
 */
export const homeRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { page: HomePage } }>(
    '/layout',
    {
      schema: { ...layoutSchema, ...routeDocs(D.layout) },
      preHandler: [optionalAuth, rateLimit('home-layout', 120, 60)],
    },
    (req, reply) => c(req).layout(req, reply),
  );
  app.get(
    '/categories',
    {
      schema: { ...categoriesPageSchema, ...routeDocs(D.categoriesPage) },
      preHandler: [optionalAuth, rateLimit('home-categories', 120, 60)],
    },
    (req, reply) => c(req).categoriesPage(req, reply),
  );
  const sections = [optionalAuth, rateLimit('home-sections', 60, 60)];
  app.get<{ Querystring: { page: HomePage; keys: string } }>(
    '/sections',
    { schema: { ...sectionsBatchSchema, ...routeDocs(D.sectionsBatch) }, preHandler: sections },
    (req, reply) => c(req).sectionsBatch(req, reply),
  );
  app.get<{
    Params: { sectionKey: string };
    Querystring: { page: HomePage; cursor?: string; limit: number };
  }>(
    '/sections/:sectionKey',
    { schema: { ...sectionPageSchema, ...routeDocs(D.sectionPage) }, preHandler: sections },
    (req, reply) => c(req).sectionPage(req, reply),
  );
  app.get<{ Querystring: { keys: string } }>(
    '/feeds',
    {
      schema: { ...feedsSchema, ...routeDocs(D.feeds) },
      preHandler: [optionalAuth, rateLimit('home-feeds', 30, 60)],
    },
    (req, reply) => c(req).feeds(req, reply),
  );
};

/** Mounted a t `/admin/home` (gateway `/v1/admin/home`). Staff with `home_layout.*`. */
export const homeAdminRoutes: FastifyPluginAsync = async (app) => {
  const view = admin('home_layout.view');
  const manage = admin('home_layout.manage');
  const publish = admin('home_layout.publish');

  app.get<{ Querystring: AdminListQuery }>(
    '/layouts',
    { schema: { ...adminListSchema, ...routeDocs(D.list) }, preHandler: view },
    (req) => c(req).list(req),
  );
  app.get<{ Params: IdParams }>(
    '/layouts/:id',
    { schema: { ...idParamsSchema, ...routeDocs(D.get) }, preHandler: view },
    (req, reply) => c(req).get(req, reply),
  );
  app.post<{ Body: CreateLayoutInput }>(
    '/layouts',
    { schema: { ...createSchema, ...routeDocs(D.create) }, preHandler: manage },
    (req, reply) => c(req).create(req, reply),
  );
  app.put<{ Params: IdParams; Body: ReplaceLayoutInput }>(
    '/layouts/:id',
    {
      schema: { ...replaceSchema, ...routeDocs(D.replace) },
      preHandler: manage,
      bodyLimit: LAYOUT_BODY_LIMIT,
    },
    (req, reply) => c(req).replace(req, reply),
  );
  app.put<{ Params: IdParams; Body: ReorderInput }>(
    '/layouts/:id/sections/reorder',
    { schema: { ...reorderSchema, ...routeDocs(D.reorder) }, preHandler: manage },
    (req, reply) => c(req).reorder(req, reply),
  );
  app.get<{ Params: IdParams; Querystring: PreviewQuery }>(
    '/layouts/:id/preview',
    { schema: { ...previewSchema, ...routeDocs(D.preview) }, preHandler: view },
    (req) => c(req).preview(req),
  );
  app.post<{ Params: IdParams }>(
    '/layouts/:id/validate',
    { schema: { ...idParamsSchema, ...routeDocs(D.validate) }, preHandler: manage },
    (req) => c(req).validate(req),
  );
  app.post<{ Params: IdParams; Body: PublishInput }>(
    '/layouts/:id/publish',
    { schema: { ...publishSchema, ...routeDocs(D.publish) }, preHandler: publish },
    (req, reply) => c(req).publish(req, reply),
  );
  app.post<{ Params: IdParams; Body: ReasonInput }>(
    '/layouts/:id/rollback',
    { schema: { ...reasonSchema, ...routeDocs(D.rollback) }, preHandler: publish },
    (req, reply) => c(req).rollback(req, reply),
  );
  app.get<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>(
    '/layouts/:id/history',
    { schema: { ...historySchema, ...routeDocs(D.history) }, preHandler: view },
    (req) => c(req).history(req),
  );
};
