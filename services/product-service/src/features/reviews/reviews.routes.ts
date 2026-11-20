import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, rateLimit, requireAuth } from '../../middleware/guards.js';
import { idParams } from '../../middleware/http.js';
import { REVIEW_DOCS } from './reviews.docs.js';
import type {
  AdminReviewQuery,
  AnalyticsQuery,
  CreateReviewInput,
  ModerationAction,
  PublicReviewQuery,
  ReportInput,
  ReportListQuery,
  UpdateReviewInput,
} from './reviews.types.js';
import { MODERATION_ACTIONS } from './reviews.types.js';
import {
  adminListSchema,
  analyticsSchema,
  bulkSchema,
  createSchema,
  historySchema,
  moderateSchema,
  pageSchema,
  productSummarySchema,
  publicListSchema,
  reportListSchema,
  reportSchema,
  resolveSchema,
  summarySchema,
  updateSchema,
  votesSchema,
} from './reviews.validation.js';

const c = (request: FastifyRequest) => request.diScope.resolve('reviewsController');

interface Id {
  id: string;
}
interface Slug {
  slugOrId: string;
}
interface Page {
  cursor?: string;
  limit: number;
}

const customer = requireAuth('CUSTOMER');

/**
 * Mounted at `/catalog/products` next to the products storefront (gateway `/v1/catalog/products`):
 * product-scoped reads (public, cached) and "write a review" (customer).
 */
export const reviewsProductRoutes: FastifyPluginAsync = async (app) => {
  const read = rateLimit('review-read', 120, 60);

  app.get<{ Params: Slug; Querystring: PublicReviewQuery }>(
    '/:slugOrId/reviews',
    { schema: { ...publicListSchema, ...routeDocs(REVIEW_DOCS.publicList) }, preHandler: read },
    (req, reply) => c(req).publicList(req, reply),
  );
  app.get<{ Params: Slug }>(
    '/:slugOrId/rating-summary',
    { schema: { ...summarySchema, ...routeDocs(REVIEW_DOCS.summary) }, preHandler: read },
    (req, reply) => c(req).summary(req, reply),
  );
  app.post<{ Params: Slug; Body: CreateReviewInput }>(
    '/:slugOrId/reviews',
    {
      schema: { ...createSchema, ...routeDocs(REVIEW_DOCS.create) },
      preHandler: [customer, rateLimit('review-write', 10, 3_600)],
    },
    (req, reply) => c(req).create(req, reply),
  );
};

/** Mounted at `/catalog/reviews` (gateway `/v1/catalog/reviews`). Customer, own records only. */
export const reviewsCustomerRoutes: FastifyPluginAsync = async (app) => {
  const write = [customer, rateLimit('review-write', 10, 3_600)];
  const vote = [customer, rateLimit('review-vote', 60, 60)];

  app.get<{ Querystring: Page }>(
    '/pending',
    { schema: { ...pageSchema, ...routeDocs(REVIEW_DOCS.pending) }, preHandler: customer },
    (req) => c(req).pending(req),
  );
  app.get<{ Querystring: Page }>(
    '/me',
    { schema: { ...pageSchema, ...routeDocs(REVIEW_DOCS.mine) }, preHandler: customer },
    (req) => c(req).mine(req),
  );
  app.get<{ Querystring: { reviewIds: string | string[] } }>(
    '/votes',
    { schema: { ...votesSchema, ...routeDocs(REVIEW_DOCS.votes) }, preHandler: customer },
    (req) => c(req).votes(req),
  );
  app.patch<{ Params: Id; Body: UpdateReviewInput }>(
    '/:id',
    { schema: { ...updateSchema, ...routeDocs(REVIEW_DOCS.update) }, preHandler: write },
    (req, reply) => c(req).update(req, reply),
  );
  app.delete<{ Params: Id }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(REVIEW_DOCS.remove) }, preHandler: write },
    (req, reply) => c(req).remove(req, reply),
  );
  app.put<{ Params: Id }>(
    '/:id/helpful',
    { schema: { ...idParams, ...routeDocs(REVIEW_DOCS.vote) }, preHandler: vote },
    (req) => c(req).vote(req),
  );
  app.delete<{ Params: Id }>(
    '/:id/helpful',
    { schema: { ...idParams, ...routeDocs(REVIEW_DOCS.unvote) }, preHandler: vote },
    (req) => c(req).unvote(req),
  );
  app.post<{ Params: Id; Body: ReportInput }>(
    '/:id/reports',
    {
      schema: { ...reportSchema, ...routeDocs(REVIEW_DOCS.report) },
      preHandler: [customer, rateLimit('review-report', 20, 86_400)],
    },
    (req, reply) => c(req).report(req, reply),
  );
};

/** Mounted at `/admin/catalog/reviews` (gateway `/v1/admin/catalog/reviews`). */
export const reviewsAdminRoutes: FastifyPluginAsync = async (app) => {
  const view = admin('reviews.view');
  const moderate = admin('reviews.moderate');

  app.get<{ Querystring: AdminReviewQuery }>(
    '/',
    { schema: { ...adminListSchema, ...routeDocs(REVIEW_DOCS.adminList) }, preHandler: view },
    (req) => c(req).adminList(req),
  );
  // Static segments before `/:id`.
  app.get<{ Querystring: ReportListQuery }>(
    '/reports',
    { schema: { ...reportListSchema, ...routeDocs(REVIEW_DOCS.reports) }, preHandler: view },
    (req) => c(req).reports(req),
  );
  app.post<{ Params: Id; Body: { decision: 'UPHOLD' | 'DISMISS'; note: string } }>(
    '/reports/:id/resolve',
    { schema: { ...resolveSchema, ...routeDocs(REVIEW_DOCS.resolveReport) }, preHandler: moderate },
    (req) => c(req).resolveReport(req),
  );
  app.get<{ Querystring: AnalyticsQuery }>(
    '/analytics',
    { schema: { ...analyticsSchema, ...routeDocs(REVIEW_DOCS.analytics) }, preHandler: view },
    (req) => c(req).analytics(req),
  );
  app.get<{ Params: { productId: string } }>(
    '/products/:productId/summary',
    {
      schema: { ...productSummarySchema, ...routeDocs(REVIEW_DOCS.productSummary) },
      preHandler: view,
    },
    (req) => c(req).productSummary(req),
  );
  app.post<{ Body: { ids: string[]; action: ModerationAction; reason?: string | null } }>(
    '/bulk-status',
    { schema: { ...bulkSchema, ...routeDocs(REVIEW_DOCS.bulk) }, preHandler: moderate },
    (req) => c(req).bulk(req),
  );
  app.get<{ Params: Id }>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(REVIEW_DOCS.adminDetail) }, preHandler: view },
    (req, reply) => c(req).adminDetail(req, reply),
  );
  app.get<{ Params: Id; Querystring: Page }>(
    '/:id/history',
    { schema: { ...historySchema, ...routeDocs(REVIEW_DOCS.history) }, preHandler: view },
    (req) => c(req).history(req),
  );
  // One route per moderation action (own Swagger entry each).
  for (const action of MODERATION_ACTIONS) {
    app.post<{ Params: Id; Body: { reason?: string | null } }>(
      `/:id/${action}`,
      {
        schema: { ...moderateSchema, ...routeDocs(REVIEW_DOCS.moderate(action)) },
        preHandler: moderate,
      },
      (req, reply) => c(req).moderate(req, reply, action),
    );
  }
};
