import { authenticate } from '@farmx/common/middleware';
import type { preHandlerAsyncHookHandler } from 'fastify';

/**
 * preHandler: requires a valid `Authorization: Bearer <access token>` and sets `request.user`.
 * The verifier is resolved per request from the container (`tokenVerifier`), so it can be
 * swapped in tests. Combine with the access module's `requirePermission(key)`.
 */
export const requireAuth: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
};
