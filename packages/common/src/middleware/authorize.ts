import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import type { AuthUser } from '../types/index.js';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

const requireUser = (request: FastifyRequest): AuthUser => {
  if (request.user === null) throw new UnauthorizedError();
  return request.user;
};

/**
 * preHandler (after `authenticate`): caller must hold at least one of the role keys.
 * Prefer permission checks (`requirePermission` in auth-service); roles are dynamic data.
 */
export const requireRoles =
  (...roles: string[]): preHandlerAsyncHookHandler =>
  async (request) => {
    const user = requireUser(request);
    if (!user.roles.some((role) => roles.includes(role))) throw new ForbiddenError();
  };
