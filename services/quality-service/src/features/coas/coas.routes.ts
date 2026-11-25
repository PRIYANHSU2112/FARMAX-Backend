import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  type Audience,
  audRead,
  audWrite,
  callerOf,
  globalWrite,
} from '../../middleware/guards.js';
import { coasDocs } from './coas.docs.js';
import type {
  CoaListQuery,
  ResultsInput,
  ReviewInput,
  SampleResultsInput,
  UploadInput,
} from './coas.types.js';
import * as V from './coas.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('coasService');

/** W16.05 / W16.06 / W16.10 on both panels (approval needs a GLOBAL `traceability.coa_verify`). */
export const coasRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = coasDocs(aud);
    const read = audRead(aud, 'quality.view');
    const publish = audWrite(aud, 'traceability.coa_publish');

    app.get<{ Querystring: CoaListQuery }>(
      '/coas',
      { schema: { ...V.listSchema, ...routeDocs(D.list) }, preHandler: read },
      async (req) => paginated(await svc(req).list(callerOf(req), req.query)),
    );
    app.get<{ Params: { id: string } }>(
      '/coas/:id',
      { schema: { ...V.getSchema, ...routeDocs(D.get) }, preHandler: read },
      async (req) => ok(await svc(req).get(callerOf(req), req.params.id)),
    );
    app.post<{ Body: UploadInput }>(
      '/coas',
      { schema: { ...V.uploadSchema, ...routeDocs(D.upload) }, preHandler: publish },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).upload(callerOf(req), req.body))),
    );
    app.post<{ Params: { id: string }; Body: { batchId?: string; expectedVersion: number } }>(
      '/coas/:id/confirm-mapping',
      {
        schema: { ...V.confirmMappingSchema, ...routeDocs(D.confirmMapping) },
        preHandler: publish,
      },
      async (req) => ok(await svc(req).confirmMapping(callerOf(req), req.params.id, req.body)),
    );
    app.put<{ Params: { id: string }; Body: ResultsInput }>(
      '/coas/:id/results',
      { schema: { ...V.resultsSchema, ...routeDocs(D.results) }, preHandler: publish },
      async (req) => ok(await svc(req).enterResults(callerOf(req), req.params.id, req.body)),
    );
    app.put<{ Params: { id: string }; Body: SampleResultsInput }>(
      '/samples/:id/results',
      { schema: { ...V.sampleResultsSchema, ...routeDocs(D.sampleResults) }, preHandler: publish },
      async (req) => ok(await svc(req).sampleResults(callerOf(req), req.params.id, req.body)),
    );
    app.post<{ Params: { id: string }; Body: ReviewInput }>(
      '/coas/:id/review',
      {
        schema: { ...V.reviewSchema, ...routeDocs(D.review) },
        preHandler: globalWrite('traceability.coa_verify'),
      },
      async (req) => ok(await svc(req).review(callerOf(req), req.params.id, req.body)),
    );
  };
