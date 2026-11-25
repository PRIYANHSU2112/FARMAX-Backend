import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, callerOf, globalWrite } from '../../middleware/guards.js';
import { specsDocs } from './specs.docs.js';
import type { SpecInput } from './specs.types.js';
import * as V from './specs.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('specsService');

/** W16.09 specs on both panels (writes need a GLOBAL `quality.spec_manage`). */
export const specsRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = specsDocs(aud);
    const read = audRead(aud, 'quality.view');
    app.get<{ Querystring: { q?: string; cursor?: string; limit: number } }>(
      '/specs',
      { schema: { ...V.listSchema, ...routeDocs(D.list) }, preHandler: read },
      async (req) => paginated(await svc(req).list(req.query)),
    );
    app.get<{ Params: { variantId: string } }>(
      '/specs/:variantId',
      { schema: { ...V.getSchema, ...routeDocs(D.get) }, preHandler: read },
      async (req) => ok(await svc(req).get(req.params.variantId)),
    );
    app.get<{ Params: { variantId: string } }>(
      '/specs/:variantId/history',
      { schema: { ...V.getSchema, ...routeDocs(D.history) }, preHandler: read },
      async (req) => ok(await svc(req).history(req.params.variantId)),
    );
    app.put<{ Params: { variantId: string }; Body: SpecInput }>(
      '/specs/:variantId',
      {
        schema: { ...V.putSchema, ...routeDocs(D.put) },
        preHandler: globalWrite('quality.spec_manage'),
      },
      async (req) => ok(await svc(req).put(callerOf(req), req.params.variantId, req.body)),
    );
  };
