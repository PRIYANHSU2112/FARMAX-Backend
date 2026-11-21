import { createHash } from 'node:crypto';

import { ok, paginated } from '@farmx/common/response';
import { internalAuth } from '@farmx/common/middleware';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, customer, idempotent, rateLimit } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { CONTENT_DOCS as D } from './content.docs.js';
import type {
  AdminListQuery,
  CorrectionChanges,
  CreateInput,
  DraftPatch,
  FeedQuery,
  HeldCopy,
  PublishInput,
  SearchQuery,
} from './content.types.js';
import * as V from './content.validation.js';

interface Id {
  id: string;
}
interface Rev {
  id: string;
  revisionId: string;
}

const ifMatch = (req: FastifyRequest) => V.parseIfMatch(req.headers['if-match']);
const userOf = (req: FastifyRequest) => actorOf(req).userId;

/** Mounted at `/farms/content`: the customer app (News & updates, alerts, knowledge library). */
export const contentRoutes: FastifyPluginAsync = async (app) => {
  const svc = (req: FastifyRequest) => req.diScope.resolve('contentService');

  app.get('/topics', { schema: routeDocs(D.topics), preHandler: customer }, async (req) =>
    ok(await svc(req).topics()),
  );
  app.get<{ Querystring: FeedQuery }>(
    '/feed',
    { schema: { ...V.feedSchema, ...routeDocs(D.feed) }, preHandler: customer },
    async (req) => ok(await svc(req).feed(userOf(req), req.query)),
  );
  app.get<{ Querystring: SearchQuery }>(
    '/search',
    {
      schema: { ...V.searchSchema, ...routeDocs(D.search) },
      preHandler: [...customer, rateLimit('content-search', 60, 60)],
    },
    async (req) => paginated(await svc(req).search(userOf(req), req.query)),
  );
  app.get<{ Querystring: { offline?: boolean; cursor?: string; limit: number } }>(
    '/library',
    { schema: { ...V.librarySchema, ...routeDocs(D.library) }, preHandler: customer },
    async (req) => paginated(await svc(req).library(userOf(req), req.query)),
  );
  app.post<{ Body: { held: HeldCopy[] } }>(
    '/library/sync',
    { schema: { ...V.syncSchema, ...routeDocs(D.sync) }, preHandler: customer },
    async (req) => ok(await svc(req).sync(userOf(req), req.body.held)),
  );
  app.get<{ Params: { idOrSlug: string }; Querystring: { farmId?: string } }>(
    '/:idOrSlug',
    { schema: { ...V.detailSchema, ...routeDocs(D.detail) }, preHandler: customer },
    async (req, reply) => {
      const body = ok(await svc(req).detail(userOf(req), req.params.idOrSlug, req.query.farmId));
      const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 20)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );
  app.put<{ Params: Id; Body: { offline: boolean; downloadedVersion?: number | null } }>(
    '/:id/save',
    { schema: { ...V.saveSchema, ...routeDocs(D.save) }, preHandler: customer },
    async (req) => ok(await svc(req).save(userOf(req), req.params.id, req.body)),
  );
  app.delete<{ Params: Id }>(
    '/:id/save',
    { schema: { ...V.unsaveSchema, ...routeDocs(D.unsave) }, preHandler: customer },
    async (req, reply) => {
      await svc(req).unsave(userOf(req), req.params.id);
      return reply.code(204).send();
    },
  );
  app.put<{ Params: Id; Body: { helpful: boolean } }>(
    '/:id/feedback',
    { schema: { ...V.feedbackSchema, ...routeDocs(D.feedback) }, preHandler: customer },
    async (req) => ok(await svc(req).feedback(userOf(req), req.params.id, req.body.helpful)),
  );
  app.post<{ Params: Id }>(
    '/:id/share',
    {
      schema: { ...V.shareSchema, ...routeDocs(D.share) },
      preHandler: [...customer, rateLimit('content-share', 30, 60)],
    },
    async (req, reply) => {
      await svc(req).share(req.params.id);
      return reply.code(204).send();
    },
  );
};

/** Mounted at `/admin/farms/content`: authoring, review, approval, corrections, registers. */
export const contentAdminRoutes: FastifyPluginAsync = async (app) => {
  const svc = (req: FastifyRequest) => req.diScope.resolve('contentAdminService');

  // Topics + reviewers first (static paths win over /:id anyway).
  app.get(
    '/topics',
    { schema: routeDocs(D.topicsList), preHandler: admin('content.view') },
    async (req) => ok(await svc(req).listTopics()),
  );
  app.post<{ Body: { code: string; name: string; clinical: boolean; sortOrder: number } }>(
    '/topics',
    {
      schema: { ...V.topicCreateSchema, ...routeDocs(D.topicCreate) },
      preHandler: admin('content.manage'),
    },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createTopic(actorOf(req), req.body))),
  );
  app.patch<{
    Params: Id;
    Body: { name?: string; clinical?: boolean; sortOrder?: number; isActive?: boolean };
  }>(
    '/topics/:id',
    {
      schema: { ...V.topicUpdateSchema, ...routeDocs(D.topicUpdate) },
      preHandler: admin('content.manage'),
    },
    async (req) =>
      ok(await svc(req).updateTopic(actorOf(req), req.params.id, ifMatch(req), req.body)),
  );
  app.get(
    '/reviewers',
    { schema: routeDocs(D.reviewersList), preHandler: admin('content.publish') },
    async (req) => ok(await svc(req).listReviewers()),
  );
  app.post<{
    Body: {
      userId: string;
      displayName: string;
      qualification: string;
      registrationNo: string;
      validUntil: string;
      reason: string;
    };
  }>(
    '/reviewers',
    {
      schema: { ...V.reviewerCreateSchema, ...routeDocs(D.reviewerCreate) },
      preHandler: admin('content.publish'),
    },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createReviewer(actorOf(req), req.body))),
  );
  app.patch<{
    Params: Id;
    Body: {
      displayName?: string;
      qualification?: string;
      registrationNo?: string;
      validUntil?: string;
      isActive?: boolean;
      reason: string;
    };
  }>(
    '/reviewers/:id',
    {
      schema: { ...V.reviewerUpdateSchema, ...routeDocs(D.reviewerUpdate) },
      preHandler: admin('content.publish'),
    },
    async (req) =>
      ok(await svc(req).updateReviewer(actorOf(req), req.params.id, ifMatch(req), req.body)),
  );

  // Items
  app.get<{ Querystring: AdminListQuery }>(
    '/',
    { schema: { ...V.adminListSchema, ...routeDocs(D.list) }, preHandler: admin('content.view') },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.post<{ Body: CreateInput }>(
    '/',
    { schema: { ...V.createSchema, ...routeDocs(D.create) }, preHandler: admin('content.manage') },
    async (req, reply) => {
      const result = await idempotent(req, async () => ({
        status: 201,
        body: ok(await svc(req).create(actorOf(req), req.body)),
      }));
      return reply.code(result.status).send(result.body);
    },
  );
  app.get<{ Params: Id }>(
    '/:id',
    { schema: { ...V.adminIdSchema, ...routeDocs(D.get) }, preHandler: admin('content.view') },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.get<{ Params: Id }>(
    '/:id/stats',
    { schema: { ...V.adminIdSchema, ...routeDocs(D.stats) }, preHandler: admin('content.view') },
    async (req) => ok(await svc(req).stats(req.params.id)),
  );
  app.patch<{ Params: Id; Body: DraftPatch }>(
    '/:id',
    { schema: { ...V.updateSchema, ...routeDocs(D.update) }, preHandler: admin('content.manage') },
    async (req) => ok(await svc(req).update(actorOf(req), req.params.id, ifMatch(req), req.body)),
  );
  app.delete<{ Params: Id }>(
    '/:id',
    { schema: { ...V.adminIdSchema, ...routeDocs(D.remove) }, preHandler: admin('content.manage') },
    async (req, reply) => {
      await svc(req).remove(actorOf(req), req.params.id, ifMatch(req));
      return reply.code(204).send();
    },
  );
  app.post<{ Params: Id }>(
    '/:id/submit',
    { schema: { ...V.adminIdSchema, ...routeDocs(D.submit) }, preHandler: admin('content.manage') },
    async (req) => ok(await svc(req).submit(actorOf(req), req.params.id, ifMatch(req))),
  );
  app.post<{ Params: Id }>(
    '/:id/sign-off',
    {
      schema: { ...V.adminIdSchema, ...routeDocs(D.signOff) },
      preHandler: admin('content.review'),
    },
    async (req) => ok(await svc(req).signOff(actorOf(req), req.params.id, ifMatch(req))),
  );
  app.post<{ Params: Id; Body: PublishInput }>(
    '/:id/publish',
    {
      schema: { ...V.publishSchema, ...routeDocs(D.publish) },
      preHandler: admin('content.publish'),
    },
    async (req) => ok(await svc(req).publish(actorOf(req), req.params.id, ifMatch(req), req.body)),
  );
  app.post<{ Params: Id; Body: { reason: string } }>(
    '/:id/reject',
    { schema: { ...V.reasonSchema, ...routeDocs(D.reject) }, preHandler: admin('content.publish') },
    async (req) =>
      ok(await svc(req).reject(actorOf(req), req.params.id, ifMatch(req), req.body.reason)),
  );
  app.post<{ Params: Id; Body: { expiresAt: string; reason: string } }>(
    '/:id/extend',
    { schema: { ...V.extendSchema, ...routeDocs(D.extend) }, preHandler: admin('content.publish') },
    async (req) => ok(await svc(req).extend(actorOf(req), req.params.id, ifMatch(req), req.body)),
  );
  app.post<{ Params: Id; Body: { reason: string } }>(
    '/:id/expire-now',
    {
      schema: { ...V.reasonSchema, ...routeDocs(D.expireNow) },
      preHandler: admin('content.publish'),
    },
    async (req) =>
      ok(await svc(req).expireNow(actorOf(req), req.params.id, ifMatch(req), req.body.reason)),
  );
  app.post<{ Params: Id; Body: { reason: string; publicNote: string } }>(
    '/:id/retract',
    {
      schema: { ...V.retractSchema, ...routeDocs(D.retract) },
      preHandler: admin('content.publish'),
    },
    async (req) => ok(await svc(req).retract(actorOf(req), req.params.id, ifMatch(req), req.body)),
  );
  app.post<{ Params: Id; Body: { reason: string } }>(
    '/:id/archive',
    {
      schema: { ...V.reasonSchema, ...routeDocs(D.archive) },
      preHandler: admin('content.publish'),
    },
    async (req) =>
      ok(await svc(req).archive(actorOf(req), req.params.id, ifMatch(req), req.body.reason)),
  );
  app.post<{ Params: Id; Body: { reason?: string } }>(
    '/:id/restore',
    {
      schema: { ...V.optionalReasonSchema, ...routeDocs(D.restore) },
      preHandler: admin('content.publish'),
    },
    async (req) =>
      ok(
        await svc(req).restore(actorOf(req), req.params.id, ifMatch(req), req.body.reason ?? null),
      ),
  );

  // Corrections
  app.post<{ Params: Id; Body: { changes: CorrectionChanges; changeNote: string } }>(
    '/:id/corrections',
    {
      schema: { ...V.correctionSchema, ...routeDocs(D.requestCorrection) },
      preHandler: admin('content.manage'),
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(ok(await svc(req).requestCorrection(actorOf(req), req.params.id, req.body))),
  );
  app.post<{ Params: Rev }>(
    '/:id/corrections/:revisionId/sign-off',
    {
      schema: { ...V.revisionSchema, ...routeDocs(D.signOffCorrection) },
      preHandler: admin('content.review'),
    },
    async (req) =>
      ok(await svc(req).signOffCorrection(actorOf(req), req.params.id, req.params.revisionId)),
  );
  app.post<{ Params: Rev; Body: { notify: boolean } }>(
    '/:id/corrections/:revisionId/approve',
    {
      schema: { ...V.approveRevisionSchema, ...routeDocs(D.approveCorrection) },
      preHandler: admin('content.publish'),
    },
    async (req) =>
      ok(
        await svc(req).approveCorrection(
          actorOf(req),
          req.params.id,
          req.params.revisionId,
          req.body.notify,
        ),
      ),
  );
  app.post<{ Params: Rev; Body: { reason: string } }>(
    '/:id/corrections/:revisionId/reject',
    {
      schema: { ...V.rejectRevisionSchema, ...routeDocs(D.rejectCorrection) },
      preHandler: admin('content.publish'),
    },
    async (req) =>
      ok(
        await svc(req).rejectCorrection(
          actorOf(req),
          req.params.id,
          req.params.revisionId,
          req.body.reason,
        ),
      ),
  );
};

/** Mounted at `/internal/farms/content`: notification-service fan-out (never routed by the gateway). */
export const contentInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  app.get<{
    Params: Id;
    Querystring: { scope: 'segment' | 'savers' | 'both'; cursor?: string; limit: number };
  }>(
    '/:id/audience',
    { schema: { ...V.audienceSchema, hide: true }, preHandler: [internalAuth(token)] },
    async (req) =>
      ok(
        await req.diScope
          .resolve('contentService')
          .audience(req.params.id, req.query.scope, req.query.cursor ?? null, req.query.limit),
      ),
  );
};
