import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import { hitRateLimit, notificationKeys } from '@farmx/infra/redis';
import type { preHandlerAsyncHookHandler } from 'fastify';

/** Permission keys this service checks (both exist in auth's permissions.catalog.ts). */
export const NOTIFICATION_PERMISSIONS = new Set(['notifications.view', 'notifications.manage']);

/** preHandler: valid, non-revoked access token of ANY user type with FULL scope (own inbox). */
export const requireUser: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
  if (request.user?.scope !== 'full') throw new ForbiddenError('Finish sign-in first');
};

/** preHandler: valid, non-revoked access token of an INTERNAL (staff) user with FULL scope. */
const requireStaff: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
  const user = request.user;
  if (user?.scope !== 'full') throw new ForbiddenError('Finish MFA enrolment first');
  if (user.userType !== 'INTERNAL') throw new ForbiddenError();
};

/** preHandler (after requireStaff): default deny. Unknown keys throw at registration. */
export const requirePermission = (key: string): preHandlerAsyncHookHandler => {
  if (!NOTIFICATION_PERMISSIONS.has(key))
    throw new Error(`requirePermission: unknown permission "${key}"`);
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope
      .resolve('accessClient')
      .hasPermission(request.user.id, key);
    if (!allowed) throw new ForbiddenError();
  };
};

/**
 * preHandler: fixed-window limit per user (or IP), 1 atomic Redis round trip.
 * Redis down → allow (availability over limiting).
 */
export const rateLimit =
  (action: string, limit: number, windowSeconds: number): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const userId = request.user?.id;
    const key =
      userId === undefined
        ? notificationKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : notificationKeys.rateLimit(action, 'user', userId);
    let result;
    try {
      result = await hitRateLimit(request.diScope.resolve('redis'), key, limit, windowSeconds);
    } catch (err) {
      request.log.warn({ err }, 'rate limit store unavailable; allowing');
      return;
    }
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new RateLimitError(result.retryAfterSeconds);
    }
  };

/** Own-inbox writes (read, devices, preferences): token + per-user limit per minute. */
export const userWrite = (action: string, limit: number) => [
  requireUser,
  rateLimit(action, limit, 60),
];

/** Admin reads: staff + permission. */
export const admin = (permission: string) => [requireStaff, requirePermission(permission)];

/** Admin writes: staff + permission + 30 writes / minute per user (sends fan out widely). */
export const adminWrite = (permission: string) => [
  requireStaff,
  requirePermission(permission),
  rateLimit('admin-write', 30, 60),
];
