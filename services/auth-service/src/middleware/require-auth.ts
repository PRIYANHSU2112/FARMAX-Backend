import { ForbiddenError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

const verifyBearer = async function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this as never, request, reply);
};

/**
 * preHandler: requires a valid, non-revoked `Authorization: Bearer <access token>` with FULL
 * scope and sets `request.user`. Combine with `requirePermission(key)` for admin routes.
 */
export const requireAuth: preHandlerAsyncHookHandler = async function (request, reply) {
  await verifyBearer.call(this, request, reply);
  if (request.user?.scope !== 'full') {
    throw new ForbiddenError('Finish MFA enrolment first (POST /me/mfa/totp/enroll)');
  }
};

/** Like `requireAuth`, but also accepts MFA-enrolment-only tokens (enrolment endpoints only). */
export const requireAuthAllowingEnrollment: preHandlerAsyncHookHandler = async function (
  request,
  reply,
) {
  await verifyBearer.call(this, request, reply);
};
