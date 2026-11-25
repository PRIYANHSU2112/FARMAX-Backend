import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { type Audience, audRead, callerOf, rateLimit } from '../../middleware/guards.js';
import { idempotencyKeyOf } from '../../middleware/http.js';
import { releaseDocs } from './release.docs.js';
import type { DecisionInput } from './release.types.js';
import * as V from './release.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('releaseService');

/**
 * W16.07 on both panels. The decision route checks the kind's permission in the service
 * (RELEASE / RECALL need GLOBAL keys; QUARANTINE `quality.hold_create`).
 */
export const releaseRoutes =
  (aud: Audience): FastifyPluginAsync =>
  async (app) => {
    const D = releaseDocs(aud);
    const read = audRead(aud, 'quality.view');
    const write = [...read, rateLimit('write', 60, 60)];

    app.get<{ Params: { batchId: string } }>(
      '/batches/:batchId/release-check',
      { schema: { ...V.releaseCheckSchema, ...routeDocs(D.releaseCheck) }, preHandler: read },
      async (req) => ok(await svc(req).releaseCheck(req.params.batchId)),
    );
    app.post<{ Params: { batchId: string }; Body: DecisionInput }>(
      '/batches/:batchId/decisions',
      { schema: { ...V.decideSchema, ...routeDocs(D.decide) }, preHandler: write },
      async (req, reply) =>
        reply
          .code(201)
          .send(
            ok(
              await svc(req).decide(
                callerOf(req),
                req.params.batchId,
                req.body,
                idempotencyKeyOf(req),
              ),
            ),
          ),
    );
    app.get<{ Params: { batchId: string } }>(
      '/batches/:batchId/decisions',
      { schema: { ...V.decisionsListSchema, ...routeDocs(D.list) }, preHandler: read },
      async (req) => ok(await svc(req).list(req.params.batchId)),
    );
    app.get<{ Params: { id: string } }>(
      '/decisions/:id',
      { schema: { ...V.decisionSchema, ...routeDocs(D.get) }, preHandler: read },
      async (req) => ok(await svc(req).get(req.params.id)),
    );
    app.post<{ Params: { id: string } }>(
      '/decisions/:id/retry',
      { schema: { ...V.decisionSchema, ...routeDocs(D.retry) }, preHandler: write },
      async (req) => ok(await svc(req).retry(callerOf(req), req.params.id)),
    );
  };
