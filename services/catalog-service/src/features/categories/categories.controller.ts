import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type { Tagged } from './categories.service.js';
import type {
  AdminCategoryListQuery,
  CreateCategoryInput,
  MoveCategoryInput,
  ReorderCategoriesInput,
  TreeQuery,
  UpdateCategoryInput,
} from './categories.types.js';
import { parseIfMatch } from './categories.validation.js';

export interface IdParams {
  id: string;
}
export interface SlugParams {
  slug: string;
}
type Req<T extends object = object> = FastifyRequest<T>;

/** Browsers/CDNs may reuse a public read for 60 s and serve it stale for 5 min while refetching. */
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);

/** HTTP only: read the request, call the service, shape the response (ETag / 304 / 201 / 204). */
export class CategoriesController {
  private readonly categoriesService: Cradle['categoriesService'];

  constructor({ categoriesService }: Pick<Cradle, 'categoriesService'>) {
    this.categoriesService = categoriesService;
  }

  /** Conditional GET: unchanged snapshot → 304 with no body (no serialisation at all). */
  private conditional<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    result: Tagged<T>,
    cacheControl: string,
  ) {
    void reply.header('etag', result.etag).header('cache-control', cacheControl);
    if (request.headers['if-none-match'] === result.etag) return reply.code(304).send();
    return reply.send(ok(result.data));
  }

  private withVersion<T extends { version: number }>(reply: FastifyReply, view: T) {
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  // ── Storefront ──

  async tree(request: Req<{ Querystring: TreeQuery }>, reply: FastifyReply) {
    const result = await this.categoriesService.publicTree(request.query.maxDepth);
    return this.conditional(request, reply, result, PUBLIC_CACHE);
  }

  async bySlug(request: Req<{ Params: SlugParams }>, reply: FastifyReply) {
    const result = await this.categoriesService.publicDetail(request.params.slug);
    return this.conditional(request, reply, result, PUBLIC_CACHE);
  }

  async subcategories(
    request: Req<{ Params: SlugParams; Querystring: TreeQuery }>,
    reply: FastifyReply,
  ) {
    const result = await this.categoriesService.publicSubcategories(
      request.params.slug,
      request.query.maxDepth,
    );
    return this.conditional(request, reply, result, PUBLIC_CACHE);
  }

  // ── Admin ──

  async list(request: Req<{ Querystring: AdminCategoryListQuery }>) {
    return paginated(await this.categoriesService.list(request.query));
  }

  async adminTree(request: FastifyRequest, reply: FastifyReply) {
    const result = await this.categoriesService.adminTree();
    return this.conditional(request, reply, result, 'private, no-cache');
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.withVersion(reply, await this.categoriesService.detail(request.params.id));
  }

  async history(
    request: Req<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>,
  ) {
    return paginated(await this.categoriesService.history(request.params.id, request.query));
  }

  async create(request: Req<{ Body: CreateCategoryInput }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => {
      const view = await this.categoriesService.create(request.body, actorOf(request));
      void reply.header('etag', `"${String(view.version)}"`);
      return { status: 201, body: ok(view) };
    });
    return reply.code(result.status).send(result.body);
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateCategoryInput }>, reply: FastifyReply) {
    return this.withVersion(
      reply,
      await this.categoriesService.update(
        request.params.id,
        request.body,
        ifMatch(request),
        actorOf(request),
      ),
    );
  }

  async move(request: Req<{ Params: IdParams; Body: MoveCategoryInput }>, reply: FastifyReply) {
    return this.withVersion(
      reply,
      await this.categoriesService.move(
        request.params.id,
        request.body,
        ifMatch(request),
        actorOf(request),
      ),
    );
  }

  async reorder(request: Req<{ Body: ReorderCategoriesInput }>) {
    return ok(await this.categoriesService.reorder(request.body, actorOf(request)));
  }

  async remove(
    request: Req<{ Params: IdParams; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.categoriesService.remove(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }
}
