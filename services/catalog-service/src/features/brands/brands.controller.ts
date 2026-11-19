import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type { Tagged } from './brands.service.js';
import type {
  AdminBrandListQuery,
  BrandListQuery,
  BrandRecord,
  CreateBrandInput,
  SetBrandStatusInput,
  UpdateBrandInput,
} from './brands.types.js';
import { parseIfMatch } from './brands.validation.js';

export interface IdParams {
  id: string;
}
export interface SlugOrIdParams {
  slugOrId: string;
}
type Req<T extends object = object> = FastifyRequest<T>;

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);

/** HTTP only: read the request, call the service, shape the response (ETag / 304 / 201 / 204). */
export class BrandsController {
  private readonly brandsService: Cradle['brandsService'];

  constructor({ brandsService }: Pick<Cradle, 'brandsService'>) {
    this.brandsService = brandsService;
  }

  private conditional(request: FastifyRequest, reply: FastifyReply, etag: string, body: unknown) {
    void reply.header('etag', etag).header('cache-control', PUBLIC_CACHE);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(body);
  }

  private withVersion(reply: FastifyReply, view: BrandRecord) {
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  // ── Storefront ──

  async publicList(request: Req<{ Querystring: BrandListQuery }>, reply: FastifyReply) {
    const result = await this.brandsService.publicList(request.query);
    return this.conditional(request, reply, result.etag, paginated(result.data));
  }

  async publicDetail(request: Req<{ Params: SlugOrIdParams }>, reply: FastifyReply) {
    const result: Tagged<unknown> = await this.brandsService.publicDetail(request.params.slugOrId);
    return this.conditional(request, reply, result.etag, ok(result.data));
  }

  // ── Admin ──

  async list(request: Req<{ Querystring: AdminBrandListQuery }>) {
    return paginated(await this.brandsService.list(request.query));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.withVersion(reply, await this.brandsService.detail(request.params.id));
  }

  async history(
    request: Req<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>,
  ) {
    return paginated(await this.brandsService.history(request.params.id, request.query));
  }

  async create(request: Req<{ Body: CreateBrandInput }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => {
      const view = await this.brandsService.create(request.body, actorOf(request));
      void reply.header('etag', `"${String(view.version)}"`);
      return { status: 201, body: ok(view) };
    });
    return reply.code(result.status).send(result.body);
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateBrandInput }>, reply: FastifyReply) {
    return this.withVersion(
      reply,
      await this.brandsService.update(
        request.params.id,
        request.body,
        ifMatch(request),
        actorOf(request),
      ),
    );
  }

  async setStatus(
    request: Req<{ Params: IdParams; Body: SetBrandStatusInput }>,
    reply: FastifyReply,
  ) {
    return this.withVersion(
      reply,
      await this.brandsService.setStatus(
        request.params.id,
        request.body,
        ifMatch(request),
        actorOf(request),
      ),
    );
  }

  async remove(
    request: Req<{ Params: IdParams; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.brandsService.remove(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }
}
