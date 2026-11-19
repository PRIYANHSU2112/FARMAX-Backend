import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import type { IdParams } from './example.controller.js';
import { EXAMPLE_DOCS } from './example.docs.js';
import type { CreateExampleInput, ExampleListQuery } from './example.types.js';
import { createExampleSchema, getExampleSchema, listExamplesSchema } from './example.validation.js';

/**
 * Mounted at `/examples`. Controllers are resolved per request from the DI scope, so tests can
 * swap providers after the app is built. Add permission checks next to `requireAuth`.
 * Swagger docs per route live in `example.docs.ts`.
 */
export const exampleRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ExampleListQuery }>(
    '/',
    {
      schema: { ...listExamplesSchema, ...routeDocs(EXAMPLE_DOCS.list) },
      preHandler: [requireAuth],
    },
    (request) => request.diScope.resolve('exampleController').list(request),
  );

  app.get<{ Params: IdParams }>(
    '/:id',
    { schema: { ...getExampleSchema, ...routeDocs(EXAMPLE_DOCS.get) }, preHandler: [requireAuth] },
    (request) => request.diScope.resolve('exampleController').get(request),
  );

  app.post<{ Body: CreateExampleInput }>(
    '/',
    {
      schema: { ...createExampleSchema, ...routeDocs(EXAMPLE_DOCS.create) },
      preHandler: [requireAuth],
    },
    (request, reply) => request.diScope.resolve('exampleController').create(request, reply),
  );
};
