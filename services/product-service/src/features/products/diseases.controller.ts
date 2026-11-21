import { ok } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ifMatch, sendConditional, withVersion } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import type {
  CreateDiseaseInput,
  DiseaseListQuery,
  PublicDiseaseQuery,
  UpdateDiseaseInput,
} from './diseases.types.js';

type Req<T extends object = object> = FastifyRequest<T>;
interface IdParams {
  id: string;
}

export class DiseasesController {
  private readonly diseasesService: Cradle['diseasesService'];

  constructor({ diseasesService }: Pick<Cradle, 'diseasesService'>) {
    this.diseasesService = diseasesService;
  }

  async publicList(request: Req<{ Querystring: PublicDiseaseQuery }>, reply: FastifyReply) {
    return sendConditional(
      request,
      reply,
      ok(await this.diseasesService.publicList(request.query)),
    );
  }

  async list(request: Req<{ Querystring: DiseaseListQuery }>) {
    return ok(await this.diseasesService.list(request.query));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return ok(withVersion(reply, await this.diseasesService.detail(request.params.id)));
  }

  async create(request: Req<{ Body: CreateDiseaseInput }>, reply: FastifyReply) {
    const view = await this.diseasesService.create(request.body, actorOf(request));
    return reply.code(201).send(ok(withVersion(reply, view)));
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateDiseaseInput }>, reply: FastifyReply) {
    const view = await this.diseasesService.update(
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
    await this.diseasesService.remove(
      request.params.id,
      request.query.reason,
      ifMatch(request),
      actorOf(request),
    );
    return reply.code(204).send();
  }
}
