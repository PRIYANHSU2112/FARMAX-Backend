import { ok } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ifMatch, withVersion } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import type {
  CreateAttributeInput,
  PutComplianceProfileInput,
  UpdateAttributeInput,
} from './attributes.types.js';

type Req<T extends object = object> = FastifyRequest<T>;

export class AttributesController {
  private readonly attributesService: Cradle['attributesService'];

  constructor({ attributesService }: Pick<Cradle, 'attributesService'>) {
    this.attributesService = attributesService;
  }

  async list(request: Req<{ Querystring: { categoryId: string } }>) {
    return ok(await this.attributesService.forCategory(request.query.categoryId));
  }

  async create(request: Req<{ Body: CreateAttributeInput }>, reply: FastifyReply) {
    const view = await this.attributesService.create(request.body, actorOf(request));
    return reply.code(201).send(ok(withVersion(reply, view)));
  }

  async update(
    request: Req<{ Params: { id: string }; Body: UpdateAttributeInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.attributesService.update(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async remove(
    request: Req<{ Params: { id: string }; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.attributesService.remove(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }

  async getProfile(request: Req<{ Params: { categoryId: string } }>) {
    return ok(await this.attributesService.profileForCategory(request.params.categoryId));
  }

  async putProfile(
    request: Req<{ Params: { categoryId: string }; Body: PutComplianceProfileInput }>,
    reply: FastifyReply,
  ) {
    const view = await this.attributesService.putProfile(
      request.params.categoryId,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async removeProfile(
    request: Req<{ Params: { categoryId: string }; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.attributesService.removeProfile(
      request.params.categoryId,
      request.query.reason,
      actorOf(request),
    );
    return reply.code(204).send();
  }
}
