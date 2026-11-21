import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit } from '../../middleware/guards.js';
import { idParams, reasonQuery } from '../../middleware/http.js';
import { DISEASE_DOCS } from './diseases.docs.js';
import type {
  CreateDiseaseInput,
  DiseaseListQuery,
  PublicDiseaseQuery,
  UpdateDiseaseInput,
} from './diseases.types.js';
import {
  adminListSchema,
  createSchema,
  publicListSchema,
  updateSchema,
} from './diseases.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('diseasesController');

/** Mounted at `/catalog/diseases` (gateway `/v1/catalog/diseases`). */
export const diseasesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: PublicDiseaseQuery }>(
    '/',
    {
      schema: { ...publicListSchema, ...routeDocs(DISEASE_DOCS.publicList) },
      preHandler: rateLimit('disease-read', 120, 60),
    },
    (req, reply) => c(req).publicList(req, reply),
  );
};

/** Mounted at `/admin/catalog/diseases` (gateway `/v1/admin/catalog/diseases`). */
export const diseasesAdminRoutes: FastifyPluginAsync = async (app) => {
  const manage = admin('catalogue.manage');

  app.get<{ Querystring: DiseaseListQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(DISEASE_DOCS.list) }, preHandler: manage },
    (req) => c(req).list(req),
  );
  app.get<{ Params: { id: string } }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(DISEASE_DOCS.get) }, preHandler: manage },
    (req, reply) => c(req).get(req, reply),
  );
  app.post<{ Body: CreateDiseaseInput }>(
    '/',
    { schema: { ...createSchema, ...routeDocs(DISEASE_DOCS.create) }, preHandler: manage },
    (req, reply) => c(req).create(req, reply),
  );
  app.patch<{ Params: { id: string }; Body: UpdateDiseaseInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(DISEASE_DOCS.update) }, preHandler: manage },
    (req, reply) => c(req).update(req, reply),
  );
  app.delete<{ Params: { id: string }; Querystring: { reason: string } }>(
    '/:id',
    {
      schema: { ...idParams, ...reasonQuery, ...routeDocs(DISEASE_DOCS.remove) },
      preHandler: manage,
    },
    (req, reply) => c(req).remove(req, reply),
  );
};
