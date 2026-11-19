import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { idempotent } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import type { AddressView, CreateAddressInput, UpdateAddressInput } from './addresses.types.js';
import { parseIfMatch } from './addresses.validation.js';

export interface IdParams {
  id: string;
}
export interface UserParams {
  userId: string;
}
export interface UserAddressParams {
  userId: string;
  id: string;
}
export interface PageQuery {
  cursor?: string;
  limit: number;
}
type Req<T extends object = object> = FastifyRequest<T>;

const ifMatch = (request: FastifyRequest) => parseIfMatch(request.headers['if-match']);
const userIdOf = (request: FastifyRequest) => actorOf(request).userId;

/** HTTP only: read the request, call the service, shape the response (ETag / 201 / 204). */
export class AddressesController {
  private readonly addressesService: Cradle['addressesService'];

  constructor({ addressesService }: Pick<Cradle, 'addressesService'>) {
    this.addressesService = addressesService;
  }

  private versioned(reply: FastifyReply, view: AddressView) {
    void reply.header('etag', `"${String(view.version)}"`);
    return ok(view);
  }

  // ── Customer ──

  async list(request: FastifyRequest) {
    return ok(await this.addressesService.list(userIdOf(request)));
  }

  async get(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.versioned(
      reply,
      await this.addressesService.get(userIdOf(request), request.params.id),
    );
  }

  async create(request: Req<{ Body: CreateAddressInput }>, reply: FastifyReply) {
    const result = await idempotent(request, async () => ({
      status: 201,
      body: ok(await this.addressesService.create(request.body, actorOf(request))),
    }));
    return reply
      .code(result.status)
      .header('etag', `"${String(result.body.data.version)}"`)
      .send(result.body);
  }

  async update(request: Req<{ Params: IdParams; Body: UpdateAddressInput }>, reply: FastifyReply) {
    const view = await this.addressesService.update(
      request.params.id,
      request.body,
      ifMatch(request),
      actorOf(request),
    );
    return this.versioned(reply, view);
  }

  async setDefault(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    return this.versioned(
      reply,
      await this.addressesService.setDefault(request.params.id, actorOf(request)),
    );
  }

  async remove(request: Req<{ Params: IdParams }>, reply: FastifyReply) {
    await this.addressesService.remove(request.params.id, ifMatch(request), actorOf(request));
    return reply.code(204).send();
  }

  // ── Admin ──

  async adminList(request: Req<{ Params: UserParams; Querystring: { includeDeleted: boolean } }>) {
    return ok(
      await this.addressesService.adminList(request.params.userId, request.query.includeDeleted),
    );
  }

  async adminHistory(request: Req<{ Params: UserAddressParams; Querystring: PageQuery }>) {
    return paginated(
      await this.addressesService.adminHistory(
        request.params.userId,
        request.params.id,
        request.query,
      ),
    );
  }

  // ── Internal ──

  async snapshot(request: Req<{ Params: UserAddressParams }>) {
    return ok(await this.addressesService.snapshot(request.params.userId, request.params.id));
  }
}
