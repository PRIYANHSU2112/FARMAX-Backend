import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, audWrite, callerOf } from '../../middleware/guards.js';
import { samplesDocs } from './samples.docs.js';
import type { SampleAction } from './samples.rules.js';
import type { SampleActionInput, SampleCreateInput, SampleListQuery } from './samples.types.js';
import * as V from './samples.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('samplesService');
const ACTIONS: SampleAction[] = ['collect', 'send', 'lab-status', 'flag', 'cancel'];

/** W16.01–W16.04 on both panels. */
export const samplesRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = samplesDocs(aud);
    const read = audRead(aud, 'quality.view');
    const write = audWrite(aud, 'quality.hold_create');

    app.get<{ Querystring: { warehouseId?: string } }>(
      '/samples/summary',
      { schema: { ...V.summarySchema, ...routeDocs(D.summary) }, preHandler: read },
      async (req) => ok(await svc(req).summary(callerOf(req), req.query.warehouseId)),
    );
    app.get<{ Querystring: SampleListQuery }>(
      '/samples',
      { schema: { ...V.listSchema, ...routeDocs(D.list) }, preHandler: read },
      async (req) => paginated(await svc(req).list(callerOf(req), req.query)),
    );
    app.post<{ Body: SampleCreateInput }>(
      '/samples',
      { schema: { ...V.createSchema, ...routeDocs(D.create) }, preHandler: write },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).create(callerOf(req), req.body))),
    );
    app.get<{ Params: { id: string } }>(
      '/samples/:id',
      { schema: { ...V.getSchema, ...routeDocs(D.get) }, preHandler: read },
      async (req) => ok(await svc(req).get(callerOf(req), req.params.id)),
    );
    for (const action of ACTIONS)
      app.post<{ Params: { id: string }; Body: SampleActionInput }>(
        `/samples/:id/${action}`,
        {
          schema: { ...V.actionSchemas[action], ...routeDocs(D.action(action)) },
          preHandler: write,
        },
        async (req) => ok(await svc(req).act(callerOf(req), req.params.id, action, req.body)),
      );
  };
