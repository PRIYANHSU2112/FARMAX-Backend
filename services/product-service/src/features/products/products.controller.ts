import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { ifMatch, sendConditional, withVersion } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import type { StatusAction } from './products.status.js';
import type {
  AdminListQuery,
  CreateProductInput,
  MediaInput,
  PublicListQuery,
  UpdateMediaInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from './products.types.js';
import { toArray } from './products.validation.js';

type Req<T extends object = object> = FastifyRequest<T>;
interface IdParams {
  id: string;
}
interface VariantParams extends IdParams {
  variantId: string;
}
interface MediaParams extends IdParams {
  mediaId: string;
}
interface Reason {
  reason: string;
}

/** HTTP only: read the request, call the service, shape the response. */
export class ProductsController {
  private readonly productsService: Cradle['productsService'];
  private readonly storefrontService: Cradle['storefrontService'];

  constructor({
    productsService,
    storefrontService,
  }: Pick<Cradle, 'productsService' | 'storefrontService'>) {
    this.productsService = productsService;
    this.storefrontService = storefrontService;
  }

  // ── Storefront ──

  async publicList(request: Req<{ Querystring: PublicListQuery }>, reply: FastifyReply) {
    const q = request.query;
    const query: PublicListQuery = {
      ...q,
      brandId: toArray(q.brandId as string | string[] | undefined),
      species: toArray(q.species as string | string[] | undefined),
      route: toArray(q.route as string | string[] | undefined),
    };
    return sendConditional(request, reply, paginated(await this.storefrontService.list(query)));
  }

  async publicDetail(request: Req<{ Params: { slugOrId: string } }>, reply: FastifyReply) {
    return sendConditional(
      request,
      reply,
      ok(await this.storefrontService.detail(request.params.slugOrId)),
    );
  }

  async alternatives(request: Req<{ Params: { slugOrId: string } }>, reply: FastifyReply) {
    return sendConditional(
      request,
      reply,
      ok(await this.storefrontService.alternatives(request.params.slugOrId)),
    );
  }

  async filters(request: Req<{ Querystring: { categoryId?: string } }>, reply: FastifyReply) {
    return sendConditional(
      request,
      reply,
      ok(await this.storefrontService.filters(request.query.categoryId)),
    );
  }

  // ── Admin reads ──

  async list(request: Req<{ Querystring: AdminListQuery }>) {
    return paginated(await this.productsService.list(request.query));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return ok(withVersion(reply, await this.productsService.detail(request.params.id)));
  }

  async history(
    request: Req<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>,
  ) {
    return paginated(await this.productsService.history(request.params.id, request.query));
  }

  async compliance(request: Req<{ Params: IdParams }>) {
    return ok(await this.productsService.complianceReport(request.params.id));
  }

  // ── Admin writes ──

  async create(request: Req<{ Body: CreateProductInput }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => {
      const view = await this.productsService.create(request.body, actorOf(request));
      void reply.header('etag', `"${String(view.version)}"`);
      return { status: 201, body: ok(view) };
    });
    return reply.code(result.status).send(result.body);
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateProductInput }>, reply: FastifyReply) {
    const view = await this.productsService.update(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async flags(
    request: Req<{
      Params: IdParams;
      Body: { isActive?: boolean; isFeatured?: boolean; reason: string };
    }>,
    reply: FastifyReply,
  ) {
    const view = await this.productsService.setFlags(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  /** One handler per lifecycle action (each route carries its own permission). */
  status(action: StatusAction) {
    return async (request: Req<{ Params: IdParams; Body: Reason }>, reply: FastifyReply) => {
      const view = await this.productsService.transition(
        request.params.id,
        action,
        request.body.reason,
        ifMatch(request),
        actorOf(request),
      );
      return ok(withVersion(reply, view));
    };
  }

  async remove(request: Req<{ Params: IdParams; Querystring: Reason }>, reply: FastifyReply) {
    await this.productsService.remove(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }

  // ── Variants ──

  async addVariant(
    request: Req<{ Params: IdParams; Body: VariantInput & Reason }>,
    reply: FastifyReply,
  ) {
    const view = await this.productsService.addVariant(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(201).send(ok(withVersion(reply, view)));
  }

  async updateVariant(
    request: Req<{ Params: VariantParams; Body: UpdateVariantInput }>,
    reply: FastifyReply,
  ) {
    const { id, variantId } = request.params;
    const view = await this.productsService.updateVariant(
      id,
      variantId,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async setDefaultVariant(
    request: Req<{ Params: VariantParams; Body: Reason }>,
    reply: FastifyReply,
  ) {
    const { id, variantId } = request.params;
    const view = await this.productsService.setDefaultVariant(
      id,
      variantId,
      request.body.reason,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async removeVariant(
    request: Req<{ Params: VariantParams; Querystring: Reason & { newDefaultVariantId?: string } }>,
    reply: FastifyReply,
  ) {
    const { id, variantId } = request.params;
    const view = await this.productsService.removeVariant(
      id,
      variantId,
      request.query,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  // ── Media ──

  async addMedia(request: Req<{ Params: IdParams; Body: MediaInput }>, reply: FastifyReply) {
    const view = await this.productsService.addMedia(
      request.params.id,
      request.body,
      actorOf(request),
    );
    return reply.code(201).send(ok(view));
  }

  async updateMedia(request: Req<{ Params: MediaParams; Body: UpdateMediaInput }>) {
    const { id, mediaId } = request.params;
    return ok(await this.productsService.updateMedia(id, mediaId, request.body, actorOf(request)));
  }

  async removeMedia(
    request: Req<{ Params: MediaParams; Querystring: Reason }>,
    reply: FastifyReply,
  ) {
    const { id, mediaId } = request.params;
    await this.productsService.removeMedia(id, mediaId, request.query.reason, actorOf(request));
    return reply.code(204).send();
  }

  // ── Internal ──

  async block(
    request: Req<{ Body: { refType: 'CATEGORY' | 'BRAND'; refId: string } }>,
    reply: FastifyReply,
  ) {
    await this.productsService.blockReference(request.body.refType, request.body.refId);
    return reply.code(201).send(ok({ blocked: true }));
  }

  async unblock(
    request: Req<{ Params: { refType: 'CATEGORY' | 'BRAND'; refId: string } }>,
    reply: FastifyReply,
  ) {
    await this.productsService.unblockReference(request.params.refType, request.params.refId);
    return reply.code(204).send();
  }

  async variantFacts(request: Req<{ Querystring: { ids: string | string[] } }>) {
    return ok(await this.productsService.variantFacts(toArray(request.query.ids) ?? []));
  }

  async internalCards(request: Req<{ Querystring: { ids: string | string[] } }>) {
    return ok(await this.storefrontService.internalCards(toArray(request.query.ids) ?? []));
  }
}
