import { createHash } from 'node:crypto';

import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { actorOf } from '../audit/index.js';
import type {
  AdminListQuery,
  CreateLayoutInput,
  FeedKey,
  HomeMeta,
  HomePage,
  PreviewQuery,
  PublishInput,
  ReasonInput,
  ReorderInput,
  ReplaceLayoutInput,
} from './home.types.js';
import { parseIfMatch } from './home.validation.js';

type Req<T extends object = object> = FastifyRequest<T>;
export interface IdParams {
  id: string;
}

const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);

/** HTTP only: context, ETag / 304, envelopes. */
export class HomeController {
  constructor(
    private readonly deps: Pick<
      Cradle,
      'homeService' | 'homeAdminService' | 'homeFeedsService' | 'homeContextService' | 'config'
    >,
  ) {}

  // ── Public ──

  async layout(request: Req<{ Querystring: { page: HomePage } }>, reply: FastifyReply) {
    const ctx = await this.deps.homeContextService.build(request);
    const { view, meta } = await this.deps.homeService.layout(request.query.page, ctx);
    request.log.info(
      {
        home: {
          page: view.page,
          layoutNo: view.layoutNo,
          sections: view.sections.length,
          userType: ctx.userType,
          sdui: ctx.sdui,
          degraded: meta.degraded,
          stale: meta.stale,
          timings: meta.timings,
        },
      },
      'home layout served',
    );
    return this.conditional(request, reply, view, meta);
  }

  async sectionPage(
    request: Req<{
      Params: { sectionKey: string };
      Querystring: { page: HomePage; cursor?: string; limit: number };
    }>,
    reply: FastifyReply,
  ) {
    const ctx = await this.deps.homeContextService.build(request);
    const { data, meta } = await this.deps.homeService.sectionPage(
      request.query.page,
      request.params.sectionKey,
      ctx,
      request.query.cursor,
      request.query.limit,
    );
    return this.conditional(request, reply, data, meta);
  }

  async sectionsBatch(
    request: Req<{ Querystring: { page: HomePage; keys: string } }>,
    reply: FastifyReply,
  ) {
    const ctx = await this.deps.homeContextService.build(request);
    const { data, meta } = await this.deps.homeService.sectionsBatch(
      request.query.page,
      request.query.keys.split(','),
      ctx,
    );
    return this.conditional(request, reply, data, meta);
  }

  async feeds(request: Req<{ Querystring: { keys: string } }>, reply: FastifyReply) {
    const ctx = await this.deps.homeContextService.build(request);
    const data = await this.deps.homeFeedsService.feeds(
      request.query.keys.split(',') as FeedKey[],
      ctx,
    );
    void reply.header('cache-control', 'private, no-store');
    return { success: true, data, meta: { authState: ctx.authState } };
  }

  /**
   * Personal response: `private, no-cache` + an ETag over the body (so a 304 is exact for this
   * caller's segment: platform, region, user type, app version, language, A/B bucket).
   */
  private conditional(request: FastifyRequest, reply: FastifyReply, data: unknown, meta: HomeMeta) {
    if (this.deps.config.APP_ENV === 'prod') delete meta.timings;
    const etag = `W/"${createHash('sha1')
      .update(JSON.stringify({ data, authState: meta.authState }))
      .digest('base64url')}"`;
    void reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send({ success: true, data, meta });
  }

  // ── Admin ──

  async list(request: Req<{ Querystring: AdminListQuery }>) {
    return paginated(await this.deps.homeAdminService.list(request.query));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    const layout = await this.deps.homeAdminService.get(request.params.id);
    return reply.header('etag', `"${String(layout.version)}"`).send(ok(layout));
  }

  async create(request: Req<{ Body: CreateLayoutInput }>, reply: FastifyReply) {
    const layout = await this.deps.homeAdminService.create(request.body, actorOf(request));
    return reply
      .code(201)
      .header('etag', `"${String(layout.version)}"`)
      .send(ok(layout));
  }

  async replace(request: Req<{ Params: IdParams; Body: ReplaceLayoutInput }>, reply: FastifyReply) {
    const { layout, warnings } = await this.deps.homeAdminService.replace(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return reply
      .header('etag', `"${String(layout.version)}"`)
      .send({ success: true, data: layout, meta: { warnings } });
  }

  async reorder(request: Req<{ Params: IdParams; Body: ReorderInput }>, reply: FastifyReply) {
    const layout = await this.deps.homeAdminService.reorder(
      request.params.id,
      request.body.keys,
      ifMatch(request),
      actorOf(request),
    );
    return reply.header('etag', `"${String(layout.version)}"`).send(ok(layout));
  }

  async preview(request: Req<{ Params: IdParams; Querystring: PreviewQuery }>) {
    const { view, meta } = await this.deps.homeAdminService.preview(
      request.params.id,
      request.query,
    );
    return { success: true, data: view, meta };
  }

  async validate(request: Req<{ Params: IdParams }>) {
    return ok(await this.deps.homeAdminService.validate(request.params.id, actorOf(request)));
  }

  async publish(request: Req<{ Params: IdParams; Body: PublishInput }>, reply: FastifyReply) {
    const layout = await this.deps.homeAdminService.publish(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return reply.header('etag', `"${String(layout.version)}"`).send(ok(layout));
  }

  async rollback(request: Req<{ Params: IdParams; Body: ReasonInput }>, reply: FastifyReply) {
    const layout = await this.deps.homeAdminService.rollback(
      request.params.id,
      request.body.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.header('etag', `"${String(layout.version)}"`).send(ok(layout));
  }

  async history(
    request: Req<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>,
  ) {
    return paginated(await this.deps.homeAdminService.history(request.params.id, request.query));
  }
}
