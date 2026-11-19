import { ok } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ifMatch, sendConditional, withVersion } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import type {
  CreateLookupInput,
  LookupGroup,
  LookupListQuery,
  UpdateLookupInput,
} from './lookups.types.js';

type Req<T extends object = object> = FastifyRequest<T>;
interface IdParams {
  id: string;
}

export class LookupsController {
  private readonly lookupsService: Cradle['lookupsService'];

  constructor({ lookupsService }: Pick<Cradle, 'lookupsService'>) {
    this.lookupsService = lookupsService;
  }

  async publicList(request: Req<{ Querystring: { group?: LookupGroup } }>, reply: FastifyReply) {
    return sendConditional(
      request,
      reply,
      ok(await this.lookupsService.publicList(request.query.group)),
    );
  }

  async list(request: Req<{ Querystring: LookupListQuery }>) {
    return ok(await this.lookupsService.list(request.query));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return ok(withVersion(reply, await this.lookupsService.detail(request.params.id)));
  }

  async create(request: Req<{ Body: CreateLookupInput }>, reply: FastifyReply) {
    const view = await this.lookupsService.create(request.body, actorOf(request));
    return reply.code(201).send(ok(withVersion(reply, view)));
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateLookupInput }>, reply: FastifyReply) {
    const view = await this.lookupsService.update(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return ok(withVersion(reply, view));
  }

  async remove(
    request: Req<{ Params: IdParams; Querystring: { reason: string } }>,
    reply: FastifyReply,
  ) {
    await this.lookupsService.remove(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }
}
