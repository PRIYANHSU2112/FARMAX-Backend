import { internalAuth } from '@farmx/common/middleware';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit } from '../../middleware/guards.js';
import { idParams, reasonQuery } from '../../middleware/http.js';
import { PRODUCT_DOCS } from './products.docs.js';
import type { StatusAction } from './products.status.js';
import { TRANSITIONS } from './products.status.js';
import type {
  AdminListQuery,
  CreateProductInput,
  MediaInput,
  PublicListQuery,
  UpdateMediaInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from './products.types.js';
import {
  addMediaSchema,
  addVariantSchema,
  adminListSchema,
  createSchema,
  deleteMediaSchema,
  deleteVariantSchema,
  filtersSchema,
  flagsSchema,
  historySchema,
  publicListSchema,
  referenceBlockSchema,
  referenceParamsSchema,
  slugOrIdSchema,
  statusSchema,
  updateMediaSchema,
  updateSchema,
  updateVariantSchema,
  productIdsSchema,
  variantActionSchema,
  variantIdsSchema,
} from './products.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('productsController');

interface Id {
  id: string;
}
interface Reason {
  reason: string;
}

/** Mounted at `/catalog/products` (gateway `/v1/catalog/products`). Public storefront reads. */
export const productsRoutes: FastifyPluginAsync = async (app) => {
  const limit = rateLimit('product-read', 120, 60);

  app.get<{ Querystring: PublicListQuery }>(
    '/',
    { schema: { ...publicListSchema, ...routeDocs(PRODUCT_DOCS.publicList) }, preHandler: limit },
    (req, reply) => c(req).publicList(req, reply),
  );
  // Static segment before `/:slugOrId`.
  app.get<{ Querystring: { categoryId?: string } }>(
    '/filters',
    { schema: { ...filtersSchema, ...routeDocs(PRODUCT_DOCS.filters) }, preHandler: limit },
    (req, reply) => c(req).filters(req, reply),
  );
  app.get<{ Params: { slugOrId: string } }>(
    '/:slugOrId',
    { schema: { ...slugOrIdSchema, ...routeDocs(PRODUCT_DOCS.publicDetail) }, preHandler: limit },
    (req, reply) => c(req).publicDetail(req, reply),
  );
  app.get<{ Params: { slugOrId: string } }>(
    '/:slugOrId/alternatives',
    { schema: { ...slugOrIdSchema, ...routeDocs(PRODUCT_DOCS.alternatives) }, preHandler: limit },
    (req, reply) => c(req).alternatives(req, reply),
  );
};

/** Mounted at `/admin/catalog/products` (gateway `/v1/admin/catalog/products`). */
export const productsAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');

  app.get<{ Querystring: AdminListQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(PRODUCT_DOCS.list) }, preHandler: manage },
    (req) => c(req).list(req),
  );
  app.get<{ Params: Id }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(PRODUCT_DOCS.get) }, preHandler: manage },
    (req, reply) => c(req).get(req, reply),
  );
  app.get<{ Params: Id; Querystring: { cursor?: string; limit: number } }>(
    '/:id/history',
    { schema: { ...historySchema, ...routeDocs(PRODUCT_DOCS.history) }, preHandler: manage },
    (req) => c(req).history(req),
  );
  app.get<{ Params: Id }>(
    '/:id/compliance',
    { schema: { ...idParams, ...routeDocs(PRODUCT_DOCS.compliance) }, preHandler: manage },
    (req) => c(req).compliance(req),
  );
  app.post<{ Body: CreateProductInput }>(
    '/',
    { schema: { ...createSchema, ...routeDocs(PRODUCT_DOCS.create) }, preHandler: manage },
    (req, reply) => c(req).create(req, reply),
  );
  app.patch<{ Params: Id; Body: UpdateProductInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(PRODUCT_DOCS.update) }, preHandler: manage },
    (req, reply) => c(req).update(req, reply),
  );
  app.patch<{ Params: Id; Body: { isActive?: boolean; isFeatured?: boolean } & Reason }>(
    '/:id/flags',
    { schema: { ...flagsSchema, ...routeDocs(PRODUCT_DOCS.flags) }, preHandler: manage },
    (req, reply) => c(req).flags(req, reply),
  );
  // Lifecycle: one route per action, each with its own permission (publish actions are sensitive).
  for (const action of Object.keys(TRANSITIONS) as StatusAction[]) {
    app.post<{ Params: Id; Body: Reason }>(
      `/:id/${action}`,
      {
        schema: { ...statusSchema, ...routeDocs(PRODUCT_DOCS[action]) },
        preHandler: admin(TRANSITIONS[action].permission),
      },
      (req, reply) => c(req).status(action)(req, reply),
    );
  }
  app.delete<{ Params: Id; Querystring: Reason }>(
    '/:id',
    {
      schema: { ...idParams, ...reasonQuery, ...routeDocs(PRODUCT_DOCS.remove) },
      preHandler: manage,
    },
    (req, reply) => c(req).remove(req, reply),
  );

  // Variants
  app.post<{ Params: Id; Body: VariantInput & Reason }>(
    '/:id/variants',
    { schema: { ...addVariantSchema, ...routeDocs(PRODUCT_DOCS.addVariant) }, preHandler: manage },
    (req, reply) => c(req).addVariant(req, reply),
  );
  app.patch<{ Params: Id & { variantId: string }; Body: UpdateVariantInput }>(
    '/:id/variants/:variantId',
    {
      schema: { ...updateVariantSchema, ...routeDocs(PRODUCT_DOCS.updateVariant) },
      preHandler: manage,
    },
    (req, reply) => c(req).updateVariant(req, reply),
  );
  app.post<{ Params: Id & { variantId: string }; Body: Reason }>(
    '/:id/variants/:variantId/default',
    {
      schema: { ...variantActionSchema, ...routeDocs(PRODUCT_DOCS.setDefaultVariant) },
      preHandler: manage,
    },
    (req, reply) => c(req).setDefaultVariant(req, reply),
  );
  app.delete<{
    Params: Id & { variantId: string };
    Querystring: Reason & { newDefaultVariantId?: string };
  }>(
    '/:id/variants/:variantId',
    {
      schema: { ...deleteVariantSchema, ...routeDocs(PRODUCT_DOCS.removeVariant) },
      preHandler: manage,
    },
    (req, reply) => c(req).removeVariant(req, reply),
  );

  // Media
  app.post<{ Params: Id; Body: MediaInput }>(
    '/:id/media',
    { schema: { ...addMediaSchema, ...routeDocs(PRODUCT_DOCS.addMedia) }, preHandler: manage },
    (req, reply) => c(req).addMedia(req, reply),
  );
  app.patch<{ Params: Id & { mediaId: string }; Body: UpdateMediaInput }>(
    '/:id/media/:mediaId',
    {
      schema: { ...updateMediaSchema, ...routeDocs(PRODUCT_DOCS.updateMedia) },
      preHandler: manage,
    },
    (req) => c(req).updateMedia(req),
  );
  app.delete<{ Params: Id & { mediaId: string }; Querystring: Reason }>(
    '/:id/media/:mediaId',
    {
      schema: { ...deleteMediaSchema, ...routeDocs(PRODUCT_DOCS.removeMedia) },
      preHandler: manage,
    },
    (req, reply) => c(req).removeMedia(req, reply),
  );
};

/**
 * Mounted at `/internal/products` (never routed by the gateway, D-27; not in Swagger).
 * Disabled when INTERNAL_SERVICE_TOKEN is unset.
 */
export const productsInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  const guard = [internalAuth(token)];

  app.post<{ Body: { refType: 'CATEGORY' | 'BRAND'; refId: string } }>(
    '/reference-blocks',
    { schema: { hide: true, ...referenceBlockSchema }, preHandler: guard },
    (req, reply) => c(req).block(req, reply),
  );
  app.delete<{ Params: { refType: 'CATEGORY' | 'BRAND'; refId: string } }>(
    '/reference-blocks/:refType/:refId',
    { schema: { hide: true, ...referenceParamsSchema }, preHandler: guard },
    (req, reply) => c(req).unblock(req, reply),
  );
  app.get<{ Querystring: { ids: string | string[] } }>(
    '/variants',
    { schema: { hide: true, ...variantIdsSchema }, preHandler: guard },
    (req) => c(req).variantFacts(req),
  );
  app.get<{ Querystring: { ids: string | string[] } }>(
    '/cards',
    { schema: { hide: true, ...productIdsSchema }, preHandler: guard },
    (req) => c(req).internalCards(req),
  );
};
