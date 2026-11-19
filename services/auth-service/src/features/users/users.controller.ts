import { UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { actorFromRequest } from '../audit/index.js';
import type {
  ChangeStatusInput,
  CreateUserInput,
  ReasonInput,
  SetRolesInput,
  UpdateUserInput,
  UserListQuery,
} from './users.types.js';

export interface IdParams {
  id: string;
}

/** HTTP only: read the request, call the service, wrap the response. */
export class UsersController {
  private readonly usersService: Cradle['usersService'];

  constructor({ usersService }: Pick<Cradle, 'usersService'>) {
    this.usersService = usersService;
  }

  async list(request: FastifyRequest<{ Querystring: UserListQuery }>) {
    return paginated(await this.usersService.list(request.query));
  }

  async get(request: FastifyRequest<{ Params: IdParams }>) {
    return ok(await this.usersService.get(request.params.id));
  }

  async create(request: FastifyRequest<{ Body: CreateUserInput }>, reply: FastifyReply) {
    const user = await this.usersService.create(request.body, actorFromRequest(request));
    return reply.code(201).send(ok(user));
  }

  async update(request: FastifyRequest<{ Params: IdParams; Body: UpdateUserInput }>) {
    return ok(
      await this.usersService.update(request.params.id, request.body, actorFromRequest(request)),
    );
  }

  async setRoles(request: FastifyRequest<{ Params: IdParams; Body: SetRolesInput }>) {
    return ok(
      await this.usersService.setRoles(request.params.id, request.body, actorFromRequest(request)),
    );
  }

  async changeStatus(request: FastifyRequest<{ Params: IdParams; Body: ChangeStatusInput }>) {
    return ok(
      await this.usersService.changeStatus(
        request.params.id,
        request.body,
        actorFromRequest(request),
      ),
    );
  }

  async block(request: FastifyRequest<{ Params: IdParams; Body: ReasonInput }>) {
    return ok(
      await this.usersService.block(
        request.params.id,
        request.body.reason,
        actorFromRequest(request),
      ),
    );
  }

  async unblock(request: FastifyRequest<{ Params: IdParams; Body: ReasonInput }>) {
    return ok(
      await this.usersService.unblock(
        request.params.id,
        request.body.reason,
        actorFromRequest(request),
      ),
    );
  }

  async sessions(request: FastifyRequest<{ Params: IdParams }>) {
    return ok(await this.usersService.listSessions(request.params.id));
  }

  async remove(
    request: FastifyRequest<{ Params: IdParams; Body: ReasonInput }>,
    reply: FastifyReply,
  ) {
    await this.usersService.softDelete(
      request.params.id,
      request.body.reason,
      actorFromRequest(request),
    );
    return reply.code(204).send();
  }

  async forceLogout(request: FastifyRequest<{ Params: IdParams; Body: ReasonInput }>) {
    return ok(
      await this.usersService.forceLogout(
        request.params.id,
        request.body.reason,
        actorFromRequest(request),
      ),
    );
  }

  /** GET /me — the caller's own profile, roles and effective permissions. */
  async me(request: FastifyRequest) {
    if (request.user === null) throw new UnauthorizedError();
    return ok(await this.usersService.getMe(request.user.id));
  }
}
