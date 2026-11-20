import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { ifMatch, sendConditional, withVersion } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
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
import { toIdArray } from './reviews.validation.js';

type Req<T extends object = object> = FastifyRequest<T>;
interface IdParams {
  id: string;
}
interface SlugParams {
  slugOrId: string;
}
interface Page {
  cursor?: string;
  limit: number;
}

const userIdOf = (request: FastifyRequest): string => {
  if (request.user === null) throw new Error('route is missing requireAuth');
  return request.user.id;
};

/** HTTP only: read the request, call the service, shape the response. */
export class ReviewsController {
  private readonly reviewsService: Cradle['reviewsService'];
  private readonly moderationService: Cradle['moderationService'];

  constructor({
    reviewsService,
    moderationService,
  }: Pick<Cradle, 'reviewsService' | 'moderationService'>) {
    this.reviewsService = reviewsService;
    this.moderationService = moderationService;
  }

  // ── Storefront ──

  async publicList(
    request: Req<{ Params: SlugParams; Querystring: PublicReviewQuery }>,
    reply: FastifyReply,
  ) {
    const page = await this.reviewsService.publicList(request.params.slugOrId, request.query);
    return sendConditional(request, reply, paginated(page));
  }

  async summary(request: Req<{ Params: SlugParams }>, reply: FastifyReply) {
    return sendConditional(
      request,
      reply,
      ok(await this.reviewsService.summary(request.params.slugOrId)),
    );
  }

  // ── Customer ──

  async create(request: Req<{ Params: SlugParams; Body: CreateReviewInput }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => {
      const view = await this.reviewsService.create(
        request.params.slugOrId,
        request.body,
        actorOf(request),
      );
      void reply.header('etag', `"${String(view.version)}"`);
      return { status: 201, body: ok(view) };
    });
    return reply.code(result.status).send(result.body);
  }

  async pending(request: Req<{ Querystring: Page }>) {
    return paginated(await this.reviewsService.pending(userIdOf(request), request.query));
  }

  async mine(request: Req<{ Querystring: Page }>) {
    return paginated(await this.reviewsService.mine(userIdOf(request), request.query));
  }

  async votes(request: Req<{ Querystring: { reviewIds: string | string[] } }>) {
    const ids = await this.reviewsService.votedIds(
      userIdOf(request),
      toIdArray(request.query.reviewIds),
    );
    return ok({ helpfulReviewIds: ids });
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateReviewInput }>, reply: FastifyReply) {
    const view = await this.reviewsService.update(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async remove(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    await this.reviewsService.remove(request.params.id, actorOf(request));
    return reply.code(204).send();
  }

  async vote(request: Req<{ Params: IdParams }>) {
    return ok(await this.reviewsService.vote(request.params.id, userIdOf(request), true));
  }

  async unvote(request: Req<{ Params: IdParams }>) {
    return ok(await this.reviewsService.vote(request.params.id, userIdOf(request), false));
  }

  async report(request: Req<{ Params: IdParams; Body: ReportInput }>, reply: FastifyReply) {
    const result = await this.reviewsService.report(
      request.params.id,
      request.body,
      actorOf(request),
    );
    return reply.code(201).send(ok(result));
  }

  // ── Admin ──

  async adminList(request: Req<{ Querystring: AdminReviewQuery }>) {
    return paginated(await this.moderationService.list(request.query));
  }

  async adminDetail(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return ok(withVersion(reply, await this.moderationService.detail(request.params.id)));
  }

  async history(request: Req<{ Params: IdParams; Querystring: Page }>) {
    return paginated(await this.moderationService.history(request.params.id, request.query));
  }

  async moderate(
    request: Req<{ Params: IdParams; Body: { reason?: string | null } }>,
    reply: FastifyReply,
    action: ModerationAction,
  ) {
    const view = await this.moderationService.moderate(
      request.params.id,
      action,
      request.body.reason ?? null,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async bulk(
    request: Req<{ Body: { ids: string[]; action: ModerationAction; reason?: string | null } }>,
  ) {
    const results = await this.moderationService.bulk(
      request.body.ids,
      request.body.action,
      request.body.reason ?? null,
      actorOf(request),
    );
    return ok({
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  }

  async reports(request: Req<{ Querystring: ReportListQuery }>) {
    return paginated(await this.moderationService.reports(request.query));
  }

  async resolveReport(
    request: Req<{ Params: IdParams; Body: { decision: 'UPHOLD' | 'DISMISS'; note: string } }>,
  ) {
    return ok(
      await this.moderationService.resolveReport(
        request.params.id,
        request.body.decision,
        request.body.note,
        actorOf(request),
      ),
    );
  }

  async productSummary(request: Req<{ Params: { productId: string } }>) {
    return ok(await this.moderationService.productSummary(request.params.productId));
  }

  async analytics(request: Req<{ Querystring: AnalyticsQuery }>) {
    return ok(await this.moderationService.analytics(request.query));
  }
}
