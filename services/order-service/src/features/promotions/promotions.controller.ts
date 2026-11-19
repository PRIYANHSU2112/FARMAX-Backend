import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { actorOf } from '../audit/index.js';
import type {
  CreatePromotionInput,
  PromotionListQuery,
  StatusInput,
  UpdatePromotionInput,
} from './promotions.types.js';

export interface IdParams {
  id: string;
}

/** HTTP only: read the request, call the service, wrap the response. */
export class PromotionsController {
  private readonly service: Cradle['promotionsService'];

  constructor({ promotionsService }: Pick<Cradle, 'promotionsService'>) {
    this.service = promotionsService;
  }

  async list(request: FastifyRequest<{ Querystring: PromotionListQuery }>) {
    return paginated(await this.service.list(request.query));
  }

  async get(request: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) {
    const view = await this.service.get(request.params.id);
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  async create(request: FastifyRequest<{ Body: CreatePromotionInput }>, reply: FastifyReply) {
    const view = await this.service.create(actorOf(request), request.body);
    return reply
      .code(201)
      .header('etag', `"${String(view.version)}"`)
      .send(ok(view));
  }

  async update(
    request: FastifyRequest<{ Params: IdParams; Body: UpdatePromotionInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.service.update(actorOf(request), request.params.id, request.body);
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  async status(
    request: FastifyRequest<{ Params: IdParams; Body: StatusInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.service.changeStatus(actorOf(request), request.params.id, request.body);
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  async redemptions(
    request: FastifyRequest<{ Params: IdParams; Querystring: { cursor?: string; limit: number } }>,
  ) {
    return paginated(await this.service.redemptions(request.params.id, request.query));
  }
}
