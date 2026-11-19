import { ForbiddenError, UnauthorizedError } from '@farmx/common/errors';
import type { preHandlerAsyncHookHandler } from 'fastify';

import { PERMISSION_KEYS } from './permissions.catalog.js';

/**
 * preHandler (after `requireAuth`): the caller must hold `permissionKey` (default deny).
 * Unknown keys throw at route registration, so a typo can never silently open a route.
 */
export const requirePermission = (permissionKey: string): preHandlerAsyncHookHandler => {
  if (!PERMISSION_KEYS.has(permissionKey)) {
    throw new Error(`requirePermission: unknown permission "${permissionKey}"`);
  }
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope
      .resolve('accessService')
      .hasPermission(request.user.id, permissionKey);
    if (!allowed) throw new ForbiddenError();
  };
};
