import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit } from '../../middleware/guards.js';
import type { IdParams, SlugParams } from './categories.controller.js';
import { CATEGORY_DOCS } from './categories.docs.js';
import type {
  AdminCategoryListQuery,
  CreateCategoryInput,
  MoveCategoryInput,
  ReorderCategoriesInput,
  TreeQuery,
  UpdateCategoryInput,
} from './categories.types.js';
import {
  adminListSchema,
  createSchema,
  deleteSchema,
  historySchema,
  idParamsSchema,
  moveSchema,
  reorderSchema,
  slugParamsSchema,
  subcategoriesSchema,
  treeSchema,
  updateSchema,
} from './categories.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('categoriesController');

/** Mounted at `/catalog/categories` (gateway `/v1/catalog/categories`). Public storefront reads. */
export const categoriesRoutes: FastifyPluginAsync = async (app) => {
  const limit = rateLimit('category-read', 120, 60);

  app.get<{ Querystring: TreeQuery }>(
    '/',
    { schema: { ...treeSchema, ...routeDocs(CATEGORY_DOCS.tree) }, preHandler: limit },
    (req, reply) => c(req).tree(req, reply),
  );

  app.get<{ Params: SlugParams }>(
    '/:slug',
    { schema: { ...slugParamsSchema, ...routeDocs(CATEGORY_DOCS.bySlug) }, preHandler: limit },
    (req, reply) => c(req).bySlug(req, reply),
  );

  app.get<{ Params: SlugParams; Querystring: TreeQuery }>(
    '/:slug/subcategories',
    {
      schema: { ...subcategoriesSchema, ...routeDocs(CATEGORY_DOCS.subcategories) },
      preHandler: limit,
    },
    (req, reply) => c(req).subcategories(req, reply),
  );
};

/** Mounted at `/admin/catalog/categories` (gateway `/v1/admin/catalog/categories`). */
export const categoriesAdminRoutes: FastifyPluginAsync = async (app) => {
  const view = admin('catalogue.view');
  const create = admin('catalogue.create');
  const update = admin('catalogue.update');

  app.get<{ Querystring: AdminCategoryListQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(CATEGORY_DOCS.list) }, preHandler: view },
    (req) => c(req).list(req),
  );

  // Static segment: registered before `/:id`, and Fastify prefers static matches anyway.
  app.get('/tree', { schema: routeDocs(CATEGORY_DOCS.adminTree), preHandler: view }, (req, reply) =>
    c(req).adminTree(req, reply),
  );

  app.post<{ Body: ReorderCategoriesInput }>(
    '/reorder',
    { schema: { ...reorderSchema, ...routeDocs(CATEGORY_DOCS.reorder) }, preHandler: update },
    (req) => c(req).reorder(req),
  );

  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...idParamsSchema, ...routeDocs(CATEGORY_DOCS.get) }, preHandler: view },
    (req, reply) => c(req).get(req, reply),
  );

  app.get<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>(
    '/:id/history',
    { schema: { ...historySchema, ...routeDocs(CATEGORY_DOCS.history) }, preHandler: view },
    (req) => c(req).history(req),
  );

  app.post<{ Body: CreateCategoryInput }>(
    '/',
    { schema: { ...createSchema, ...routeDocs(CATEGORY_DOCS.create) }, preHandler: create },
    (req, reply) => c(req).create(req, reply),
  );

  app.patch<{ Params: IdParams; Body: UpdateCategoryInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(CATEGORY_DOCS.update) }, preHandler: update },
    (req, reply) => c(req).update(req, reply),
  );

  app.post<{ Params: IdParams; Body: MoveCategoryInput }>(
    '/:id/move',
    { schema: { ...moveSchema, ...routeDocs(CATEGORY_DOCS.move) }, preHandler: update },
    (req, reply) => c(req).move(req, reply),
  );

  app.delete<{ Params: IdParams; Querystring: { reason: string } }>(
    '/:id',
    { schema: { ...deleteSchema, ...routeDocs(CATEGORY_DOCS.remove) }, preHandler: update },
    (req, reply) => c(req).remove(req, reply),
  );
};
