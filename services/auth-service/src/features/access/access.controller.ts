import { ok, paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { actorFromRequest } from '../audit/index.js';
import type {
  CreateRoleInput,
  RoleListQuery,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from './access.types.js';

export interface RoleIdParams {
  id: string;
}

export class AccessController {
  private readonly accessService: Cradle['accessService'];

  constructor({ accessService }: Pick<Cradle, 'accessService'>) {
    this.accessService = accessService;
  }

  async listRoles(request: FastifyRequest<{ Querystring: RoleListQuery }>) {
    return paginated(await this.accessService.listRoles(request.query));
  }

  async getRole(request: FastifyRequest<{ Params: RoleIdParams }>) {
    return ok(await this.accessService.getRole(request.params.id));
  }

  async createRole(request: FastifyRequest<{ Body: CreateRoleInput }>, reply: FastifyReply) {
    const role = await this.accessService.createRole(request.body, actorFromRequest(request));
    return reply.code(201).send(ok(role));
  }

  async updateRole(request: FastifyRequest<{ Params: RoleIdParams; Body: UpdateRoleInput }>) {
    return ok(
      await this.accessService.updateRole(
        request.params.id,
        request.body,
        actorFromRequest(request),
      ),
    );
  }

  async archiveRole(request: FastifyRequest<{ Params: RoleIdParams; Body: { reason: string } }>) {
    return ok(
      await this.accessService.archiveRole(
        request.params.id,
        request.body.reason,
        actorFromRequest(request),
      ),
    );
  }

  async setRolePermissions(
    request: FastifyRequest<{ Params: RoleIdParams; Body: SetRolePermissionsInput }>,
  ) {
    return ok(
      await this.accessService.setRolePermissions(
        request.params.id,
        request.body,
        actorFromRequest(request),
      ),
    );
  }

  listPermissions() {
    return ok(this.accessService.listPermissions());
  }
}
