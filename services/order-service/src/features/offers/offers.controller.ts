import { UnauthorizedError } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyRequest } from 'fastify';

import type { OffersInput, PreviewInput } from './offers.types.js';

/** HTTP only: read the request, call the service, wrap the response. */
export class OffersController {
  private readonly service: Cradle['offersService'];

  constructor({ offersService }: Pick<Cradle, 'offersService'>) {
    this.service = offersService;
  }

  async offers(request: FastifyRequest<{ Body: OffersInput }>) {
    if (request.user === null) throw new UnauthorizedError();
    return ok(await this.service.offers(request.user, request.body));
  }

  async preview(request: FastifyRequest<{ Body: PreviewInput }>) {
    if (request.user === null) throw new UnauthorizedError();
    return ok(await this.service.preview(request.user, request.body));
  }
}
