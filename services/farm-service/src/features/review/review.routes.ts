import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { admin, customer } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { REVIEW_DOCS } from './review.docs.js';
import type { DecisionInput, OwnerClaim, QueueQuery } from './review.types.js';
import {
  assignSchema,
  caseParams,
  claimSchema,
  decisionSchema,
  queueSchema,
  verificationSchema,
} from './review.validation.js';

/** Mounted at `/farms`: the customer's verification screens. */
export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/:id/verification',
    {
      schema: { ...verificationSchema, ...routeDocs(REVIEW_DOCS.verification) },
      preHandler: customer,
    },
    async (req) =>
      ok(
        await req.diScope.resolve('reviewService').verification(actorOf(req).userId, req.params.id),
      ),
  );
  app.post<{ Params: { id: string }; Body: { claim: OwnerClaim } }>(
    '/:id/verification/claim',
    { schema: { ...claimSchema, ...routeDocs(REVIEW_DOCS.claim) }, preHandler: customer },
    async (req) =>
      ok(
        await req.diScope
          .resolve('reviewService')
          .claim(actorOf(req), req.params.id, req.body.claim),
      ),
  );
};

/** Mounted at `/admin/farms`: review queue and decisions. */
export const reviewAdminRoutes: FastifyPluginAsync = async (app) => {
  const guard = admin('customers.verify');
  app.get<{ Querystring: QueueQuery }>(
    '/review-queue',
    { schema: { ...queueSchema, ...routeDocs(REVIEW_DOCS.queue) }, preHandler: guard },
    async (req) =>
      paginated(await req.diScope.resolve('reviewService').queue(req.query, actorOf(req).userId)),
  );
  app.get<{ Params: { caseId: string } }>(
    '/review-cases/:caseId',
    { schema: { ...caseParams, ...routeDocs(REVIEW_DOCS.getCase) }, preHandler: guard },
    async (req) => ok(await req.diScope.resolve('reviewService').getCase(req.params.caseId)),
  );
  app.post<{ Params: { caseId: string }; Body: { assigneeUserId: string } }>(
    '/review-cases/:caseId/assign',
    { schema: { ...assignSchema, ...routeDocs(REVIEW_DOCS.assign) }, preHandler: guard },
    async (req) =>
      ok(
        await req.diScope
          .resolve('reviewService')
          .assign(actorOf(req), req.params.caseId, req.body.assigneeUserId),
      ),
  );
  app.post<{ Params: { caseId: string }; Body: DecisionInput }>(
    '/review-cases/:caseId/decision',
    { schema: { ...decisionSchema, ...routeDocs(REVIEW_DOCS.decide) }, preHandler: guard },
    async (req) =>
      ok(
        await req.diScope
          .resolve('reviewService')
          .decide(actorOf(req), req.params.caseId, req.body),
      ),
  );
};
