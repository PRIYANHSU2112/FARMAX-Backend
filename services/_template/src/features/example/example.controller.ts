import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { CreateExampleInput, ExampleListQuery } from './example.types.js';

export interface IdParams {
  id: string;
}

/** HTTP only: read the request, call the service, wrap the response. No business rules. */
export class ExampleController {
  private readonly exampleService: Cradle['exampleService'];

  constructor({ exampleService }: Pick<Cradle, 'exampleService'>) {
    this.exampleService = exampleService;
  }

  async list(request: FastifyRequest<{ Querystring: ExampleListQuery }>) {
    return paginated(await this.exampleService.list(request.query));
  }

  async get(request: FastifyRequest<{ Params: IdParams }>) {
    return ok(await this.exampleService.get(request.params.id));
  }

  async create(request: FastifyRequest<{ Body: CreateExampleInput }>, reply: FastifyReply) {
    if (request.user === null) throw new UnauthorizedError();
    const created = await this.exampleService.create(request.body, request.user.id);
    return reply.code(201).send(ok(created));
  }
}
