import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit } from '../../middleware/guards.js';
import { idParams, reasonQuery } from '../../middleware/http.js';
import { LOOKUP_DOCS } from './lookups.docs.js';
import type {
  CreateLookupInput,
  LookupGroup,
  LookupListQuery,
  UpdateLookupInput,
} from './lookups.types.js';
import {
  adminListSchema,
  createSchema,
  publicListSchema,
  updateSchema,
} from './lookups.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('lookupsController');

/** Mounted at `/catalog/lookups` (gateway `/v1/catalog/lookups`). */
export const lookupsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { group?: LookupGroup } }>(
    '/',
    {
      schema: { ...publicListSchema, ...routeDocs(LOOKUP_DOCS.publicList) },
      preHandler: rateLimit('lookup-read', 120, 60),
    },
    (req, reply) => c(req).publicList(req, reply),
  );
};

/** Mounted at `/admin/catalog/lookups` (gateway `/v1/admin/catalog/lookups`). */
export const lookupsAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');

  app.get<{ Querystring: LookupListQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(LOOKUP_DOCS.list) }, preHandler: manage },
    (req) => c(req).list(req),
  );
  app.get<{ Params: { id: string } }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(LOOKUP_DOCS.get) }, preHandler: manage },
    (req, reply) => c(req).get(req, reply),
  );
  app.post<{ Body: CreateLookupInput }>(
    '/',
    { schema: { ...createSchema, ...routeDocs(LOOKUP_DOCS.create) }, preHandler: manage },
    (req, reply) => c(req).create(req, reply),
  );
  app.patch<{ Params: { id: string }; Body: UpdateLookupInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(LOOKUP_DOCS.update) }, preHandler: manage },
    (req, reply) => c(req).update(req, reply),
  );
  app.delete<{ Params: { id: string }; Querystring: { reason: string } }>(
    '/:id',
    {
      schema: { ...idParams, ...reasonQuery, ...routeDocs(LOOKUP_DOCS.remove) },
      preHandler: manage,
    },
    (req, reply) => c(req).remove(req, reply),
  );
};
