import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../access/index.js';
import type { IdParams } from './users.controller.js';
import { USERS_DOCS } from './users.docs.js';
import type {
  ChangeStatusInput,
  CreateUserInput,
  ReasonInput,
  SetRolesInput,
  UpdateUserInput,
  UserListQuery,
} from './users.types.js';
import {
  changeStatusSchema,
  createUserSchema,
  getUserSchema,
  listUsersSchema,
  reasonSchema,
  setRolesSchema,
  userSessionsSchema,
  updateUserSchema,
} from './users.validation.js';

/** `requireAuth` then the permission check (default deny). */
const guard = (permission: string) => [requireAuth, requirePermission(permission)];

/**
 * Admin user management, mounted at `/admin/users`
 * (public: `/v1/auth/admin/users` through the gateway).
 */
export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: UserListQuery }>(
    '/',
    {
      schema: { ...listUsersSchema, ...routeDocs(USERS_DOCS.list) },
      preHandler: guard(USERS_DOCS.list.permission),
    },
    (request) => request.diScope.resolve('usersController').list(request),
  );

  app.get<{ Params: IdParams }>(
    '/:id',
    {
      schema: { ...getUserSchema, ...routeDocs(USERS_DOCS.get) },
      preHandler: guard(USERS_DOCS.get.permission),
    },
    (request) => request.diScope.resolve('usersController').get(request),
  );

  app.post<{ Body: CreateUserInput }>(
    '/',
    {
      schema: { ...createUserSchema, ...routeDocs(USERS_DOCS.create) },
      preHandler: guard(USERS_DOCS.create.permission),
    },
    (request, reply) => request.diScope.resolve('usersController').create(request, reply),
  );

  app.patch<{ Params: IdParams; Body: UpdateUserInput }>(
    '/:id',
    {
      schema: { ...updateUserSchema, ...routeDocs(USERS_DOCS.update) },
      preHandler: guard(USERS_DOCS.update.permission),
    },
    (request) => request.diScope.resolve('usersController').update(request),
  );

  app.put<{ Params: IdParams; Body: SetRolesInput }>(
    '/:id/roles',
    {
      schema: { ...setRolesSchema, ...routeDocs(USERS_DOCS.setRoles) },
      preHandler: guard(USERS_DOCS.setRoles.permission),
    },
    (request) => request.diScope.resolve('usersController').setRoles(request),
  );

  app.post<{ Params: IdParams; Body: ReasonInput }>(
    '/:id/block',
    {
      schema: { ...reasonSchema, ...routeDocs(USERS_DOCS.block) },
      preHandler: guard(USERS_DOCS.block.permission),
    },
    (request) => request.diScope.resolve('usersController').block(request),
  );

  app.post<{ Params: IdParams; Body: ReasonInput }>(
    '/:id/unblock',
    {
      schema: { ...reasonSchema, ...routeDocs(USERS_DOCS.unblock) },
      preHandler: guard(USERS_DOCS.unblock.permission),
    },
    (request) => request.diScope.resolve('usersController').unblock(request),
  );

  app.get<{ Params: IdParams }>(
    '/:id/sessions',
    {
      schema: { ...userSessionsSchema, ...routeDocs(USERS_DOCS.sessions) },
      preHandler: guard(USERS_DOCS.sessions.permission),
    },
    (request) => request.diScope.resolve('usersController').sessions(request),
  );

  app.patch<{ Params: IdParams; Body: ChangeStatusInput }>(
    '/:id/status',
    {
      schema: { ...changeStatusSchema, ...routeDocs(USERS_DOCS.changeStatus) },
      preHandler: guard(USERS_DOCS.changeStatus.permission),
    },
    (request) => request.diScope.resolve('usersController').changeStatus(request),
  );

  app.delete<{ Params: IdParams; Body: ReasonInput }>(
    '/:id',
    {
      schema: { ...reasonSchema, ...routeDocs(USERS_DOCS.remove) },
      preHandler: guard(USERS_DOCS.remove.permission),
    },
    (request, reply) => request.diScope.resolve('usersController').remove(request, reply),
  );

  app.post<{ Params: IdParams; Body: ReasonInput }>(
    '/:id/force-logout',
    {
      schema: { ...reasonSchema, ...routeDocs(USERS_DOCS.forceLogout) },
      preHandler: guard(USERS_DOCS.forceLogout.permission),
    },
    (request) => request.diScope.resolve('usersController').forceLogout(request),
  );
};

/** Mounted at `/me`: the logged-in user's own profile (any user type, full-scope token). */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { schema: routeDocs(USERS_DOCS.me), preHandler: [requireAuth] }, (request) =>
    request.diScope.resolve('usersController').me(request),
  );
};
