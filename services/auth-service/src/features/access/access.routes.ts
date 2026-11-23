import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import type { RoleIdParams } from './access.controller.js';
import { ACCESS_DOCS } from './access.docs.js';
import { requirePermission } from './access.guard.js';
import type {
  CreateRoleInput,
  RoleListQuery,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from './access.types.js';
import {
  archiveRoleSchema,
  createRoleSchema,
  getRoleSchema,
  listRolesSchema,
  setRolePermissionsSchema,
  updateRoleSchema,
} from './access.validation.js';

const guard = (permission: string) => [requireAuth, requirePermission(permission)];

/** Mounted at `/admin`: roles (dynamic) and the fixed permission catalog. */
export const accessRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: RoleListQuery }>(
    '/roles',
    {
      schema: { ...listRolesSchema, ...routeDocs(ACCESS_DOCS.listRoles) },
      preHandler: guard(ACCESS_DOCS.listRoles.permission),
    },
    (request) => request.diScope.resolve('accessController').listRoles(request),
  );

  app.post<{ Body: CreateRoleInput }>(
    '/roles',
    {
      schema: { ...createRoleSchema, ...routeDocs(ACCESS_DOCS.createRole) },
      preHandler: guard(ACCESS_DOCS.createRole.permission),
    },
    (request, reply) => request.diScope.resolve('accessController').createRole(request, reply),
  );

  app.get<{ Params: RoleIdParams }>(
    '/roles/:id',
    {
      schema: { ...getRoleSchema, ...routeDocs(ACCESS_DOCS.getRole) },
      preHandler: guard(ACCESS_DOCS.getRole.permission),
    },
    (request) => request.diScope.resolve('accessController').getRole(request),
  );

  app.get<{ Params: RoleIdParams }>(
    '/roles/:id/usage',
    {
      schema: { ...getRoleSchema, ...routeDocs(ACCESS_DOCS.roleUsage) },
      preHandler: guard(ACCESS_DOCS.roleUsage.permission),
    },
    (request) => request.diScope.resolve('accessController').roleUsage(request),
  );

  app.patch<{ Params: RoleIdParams; Body: UpdateRoleInput }>(
    '/roles/:id',
    {
      schema: { ...updateRoleSchema, ...routeDocs(ACCESS_DOCS.updateRole) },
      preHandler: guard(ACCESS_DOCS.updateRole.permission),
    },
    (request) => request.diScope.resolve('accessController').updateRole(request),
  );

  app.post<{ Params: RoleIdParams; Body: { reason: string } }>(
    '/roles/:id/archive',
    {
      schema: { ...archiveRoleSchema, ...routeDocs(ACCESS_DOCS.archiveRole) },
      preHandler: guard(ACCESS_DOCS.archiveRole.permission),
    },
    (request) => request.diScope.resolve('accessController').archiveRole(request),
  );

  app.put<{ Params: RoleIdParams; Body: SetRolePermissionsInput }>(
    '/roles/:id/permissions',
    {
      schema: { ...setRolePermissionsSchema, ...routeDocs(ACCESS_DOCS.setRolePermissions) },
      preHandler: guard(ACCESS_DOCS.setRolePermissions.permission),
    },
    (request) => request.diScope.resolve('accessController').setRolePermissions(request),
  );

  app.get(
    '/permissions',
    {
      schema: routeDocs(ACCESS_DOCS.listPermissions),
      preHandler: guard(ACCESS_DOCS.listPermissions.permission),
    },
    (request) => request.diScope.resolve('accessController').listPermissions(),
  );
};
