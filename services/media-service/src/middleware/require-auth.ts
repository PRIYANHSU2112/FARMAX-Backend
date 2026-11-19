import { ForbiddenError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import type { preHandlerAsyncHookHandler } from 'fastify';

/**
 * preHandler: valid, non-revoked access token from auth-service with FULL scope (enrolment-only
 * tokens are refused). Sets `request.user`.
 */
export const requireAuth: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
  if (request.user?.scope !== 'full') throw new ForbiddenError('Finish MFA enrolment first');
};
