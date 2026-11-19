import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin } from '../../middleware/guards.js';
import { idParams, reasonQuery } from '../../middleware/http.js';
import { ATTRIBUTE_DOCS } from './attributes.docs.js';
import type {
  CreateAttributeInput,
  PutComplianceProfileInput,
  UpdateAttributeInput,
} from './attributes.types.js';
import {
  categoryParamsSchema,
  categoryQuerySchema,
  createAttributeSchema,
  putProfileSchema,
  updateAttributeSchema,
} from './attributes.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('attributesController');

/** Mounted at `/admin/catalog/product-attributes`. */
export const attributesAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');

  app.get<{ Querystring: { categoryId: string } }>(
    '/',
    { schema: { ...categoryQuerySchema, ...routeDocs(ATTRIBUTE_DOCS.list) }, preHandler: manage },
    (req) => c(req).list(req),
  );
  app.post<{ Body: CreateAttributeInput }>(
    '/',
    {
      schema: { ...createAttributeSchema, ...routeDocs(ATTRIBUTE_DOCS.create) },
      preHandler: manage,
    },
    (req, reply) => c(req).create(req, reply),
  );
  app.patch<{ Params: { id: string }; Body: UpdateAttributeInput }>(
    '/:id',
    {
      schema: { ...updateAttributeSchema, ...routeDocs(ATTRIBUTE_DOCS.update) },
      preHandler: manage,
    },
    (req, reply) => c(req).update(req, reply),
  );
  app.delete<{ Params: { id: string }; Querystring: { reason: string } }>(
    '/:id',
    {
      schema: { ...idParams, ...reasonQuery, ...routeDocs(ATTRIBUTE_DOCS.remove) },
      preHandler: manage,
    },
    (req, reply) => c(req).remove(req, reply),
  );
};

/** Mounted at `/admin/catalog/compliance-profiles`. */
export const complianceAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');

  app.get<{ Params: { categoryId: string } }>(
    '/:categoryId',
    {
      schema: { ...categoryParamsSchema, ...routeDocs(ATTRIBUTE_DOCS.getProfile) },
      preHandler: manage,
    },
    (req) => c(req).getProfile(req),
  );
  app.put<{ Params: { categoryId: string }; Body: PutComplianceProfileInput }>(
    '/:categoryId',
    {
      schema: { ...putProfileSchema, ...routeDocs(ATTRIBUTE_DOCS.putProfile) },
      preHandler: manage,
    },
    (req, reply) => c(req).putProfile(req, reply),
  );
  app.delete<{ Params: { categoryId: string }; Querystring: { reason: string } }>(
    '/:categoryId',
    {
      schema: {
        ...categoryParamsSchema,
        ...reasonQuery,
        ...routeDocs(ATTRIBUTE_DOCS.removeProfile),
      },
      preHandler: manage,
    },
    (req, reply) => c(req).removeProfile(req, reply),
  );
};
