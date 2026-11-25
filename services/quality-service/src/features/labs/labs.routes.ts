import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, callerOf, globalWrite } from '../../middleware/guards.js';
import { labsDocs } from './labs.docs.js';
import type { LabInput, LabUpdate } from './labs.types.js';
import * as V from './labs.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('labsService');

/** W16.08 labs on both panels (writes need a GLOBAL `quality.lab_manage`). */
export const labsRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = labsDocs(aud);
    const read = audRead(aud, 'quality.view');
    app.get<{ Querystring: { status?: 'ACTIVE' | 'INACTIVE' } }>(
      '/labs',
      { schema: { ...V.listSchema, ...routeDocs(D.list) }, preHandler: read },
      async (req) => ok(await svc(req).list(req.query)),
    );
    app.get<{ Params: { id: string } }>(
      '/labs/:id',
      { schema: { ...V.getSchema, ...routeDocs(D.get) }, preHandler: read },
      async (req) => ok(await svc(req).get(req.params.id)),
    );
    app.post<{ Body: LabInput }>(
      '/labs',
      {
        schema: { ...V.createSchema, ...routeDocs(D.create) },
        preHandler: globalWrite('quality.lab_manage'),
      },
      async (req, reply) =>
        reply.code(201).send(ok(await svc(req).create(callerOf(req), req.body))),
    );
    app.put<{ Params: { id: string }; Body: LabUpdate }>(
      '/labs/:id',
      {
        schema: { ...V.updateSchema, ...routeDocs(D.update) },
        preHandler: globalWrite('quality.lab_manage'),
      },
      async (req) => ok(await svc(req).update(callerOf(req), req.params.id, req.body)),
    );
    app.post<{ Params: { id: string } }>(
      '/labs/:id/test-connection',
      { schema: { ...V.getSchema, ...routeDocs(D.testConnection) }, preHandler: read },
      async (req) => ok(await svc(req).testConnection(req.params.id)),
    );
  };
