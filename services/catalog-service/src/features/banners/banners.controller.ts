import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type {
  AdminBannerListQuery,
  AdminPlacementListQuery,
  CreateBannerInput,
  CreatePlacementInput,
  PublicBannerQuery,
  ReorderBannersInput,
  StatusInput,
  UpdateBannerInput,
  UpdatePlacementInput,
} from './banners.types.js';
import { parseIfMatch } from './banners.validation.js';

export interface IdParams {
  id: string;
}
export interface CodeParams {
  code: string;
}
export interface PageQuery {
  cursor?: string;
  limit: number;
}
type Req<T extends object = object> = FastifyRequest<T>;

/** Short browser/CDN cache: schedules flip on time; ETag makes revalidation cheap (304). */
const PUBLIC_CACHE = 'public, max-age=30, stale-while-revalidate=120';
const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);

/** HTTP only: read the request, call the service, shape the response (ETag / 304 / 201 / 204). */
export class BannersController {
  private readonly bannersService: Cradle['bannersService'];

  constructor({ bannersService }: Pick<Cradle, 'bannersService'>) {
    this.bannersService = bannersService;
  }

  private conditional(request: FastifyRequest, reply: FastifyReply, etag: string, body: unknown) {
    void reply.header('etag', etag).header('cache-control', PUBLIC_CACHE);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(body);
  }

  private versioned(reply: FastifyReply, view: { version: number }) {
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  private async created(
    request: FastifyRequest,
    reply: FastifyReply,
    work: () => Promise<{ version: number }>,
  ) {
    // A replayed Idempotency-Key response carries the same body, so the ETag comes from it.
    const result = await idempotent(request, async () => ({ status: 201, body: ok(await work()) }));
    return reply
      .code(result.status)
      .header('etag', `"${String(result.body.data.version)}"`)
      .send(result.body);
  }

  // ── Storefront ──

  async publicList(request: Req<{ Querystring: PublicBannerQuery }>, reply: FastifyReply) {
    const result = await this.bannersService.publicList(request.query);
    return this.conditional(request, reply, result.etag, ok(result.data));
  }

  async publicByCode(request: Req<{ Params: CodeParams }>, reply: FastifyReply) {
    const result = await this.bannersService.publicByCode(request.params.code);
    return this.conditional(request, reply, result.etag, ok(result.data));
  }

  // ── Admin: placements ──

  async listPlacements(request: Req<{ Querystring: AdminPlacementListQuery }>) {
    return paginated(await this.bannersService.listPlacements(request.query));
  }

  async getPlacement(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.versioned(reply, await this.bannersService.placement(request.params.id));
  }

  async placementHistory(request: Req<{ Params: IdParams; Querystring: PageQuery }>) {
    return paginated(
      await this.bannersService.history('banner_placement', request.params.id, request.query),
    );
  }

  createPlacement(request: Req<{ Body: CreatePlacementInput }>, reply: FastifyReply) {
    return this.created(request, reply, () =>
      this.bannersService.createPlacement(request.body, actorOf(request)),
    );
  }

  async updatePlacement(
    request: Req<{ Params: IdParams; Body: UpdatePlacementInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.bannersService.updatePlacement(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
      'banner_placement.update',
    );
    return this.versioned(reply, view);
  }

  async setPlacementStatus(
    request: Req<{ Params: IdParams; Body: StatusInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.bannersService.updatePlacement(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
      'banner_placement.status',
    );
    return this.versioned(reply, view);
  }

  async removePlacement(
    request: Req<{ Params: IdParams; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.bannersService.removePlacement(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }

  // ── Admin: banners ──

  async listBanners(request: Req<{ Querystring: AdminBannerListQuery }>) {
    return paginated(await this.bannersService.listBanners(request.query));
  }

  async getBanner(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.versioned(reply, await this.bannersService.banner(request.params.id));
  }

  async bannerHistory(request: Req<{ Params: IdParams; Querystring: PageQuery }>) {
    return paginated(await this.bannersService.history('banner', request.params.id, request.query));
  }

  createBanner(request: Req<{ Body: CreateBannerInput }>, reply: FastifyReply) {
    return this.created(request, reply, () =>
      this.bannersService.createBanner(request.body, actorOf(request)),
    );
  }

  async updateBanner(
    request: Req<{ Params: IdParams; Body: UpdateBannerInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.bannersService.updateBanner(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
      'banner.update',
    );
    return this.versioned(reply, view);
  }

  async setBannerStatus(
    request: Req<{ Params: IdParams; Body: StatusInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.bannersService.updateBanner(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
      'banner.status',
    );
    return this.versioned(reply, view);
  }

  async reorder(request: Req<{ Body: ReorderBannersInput }>) {
    return ok(await this.bannersService.reorder(request.body, actorOf(request)));
  }

  async removeBanner(
    request: Req<{ Params: IdParams; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.bannersService.removeBanner(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }
}
