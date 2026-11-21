import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import { callKeys, hitRateLimit } from '@farmx/infra/redis';
import type { preHandlerAsyncHookHandler } from 'fastify';

/** Permission keys this service checks (all exist in auth's permissions.catalog.ts). */
export const CALL_PERMISSIONS = new Set(['sales.view', 'sales.manage', 'sales.configure']);

/** preHandler: valid, non-revoked access token with FULL scope (any user type). */
const requireUser: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
  if (request.user?.scope !== 'full') throw new ForbiddenError('Finish sign-in first');
};

/** preHandler: an INTERNAL (staff) user. */
const requireStaff: preHandlerAsyncHookHandler = async function (request, reply) {
  await requireUser.call(this, request, reply);
  if (request.user?.userType !== 'INTERNAL') throw new ForbiddenError();
};

/** preHandler (after requireStaff): default deny. Unknown keys throw at registration. */
export const requirePermission = (key: string): preHandlerAsyncHookHandler => {
  if (!CALL_PERMISSIONS.has(key)) throw new Error(`requirePermission: unknown permission "${key}"`);
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope.resolve('accessClient').hasPermission(request.user.id, key);
    if (!allowed) throw new ForbiddenError();
  };
};

/** Fixed-window limit per user (or IP). Redis down → allow (availability over limiting). */
export const rateLimit =
  (action: string, limit: number, windowSeconds: number): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const userId = request.user?.id;
    const key =
      userId === undefined
        ? callKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : callKeys.rateLimit(action, 'user', userId);
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

/** preHandler: a CUSTOMER (farmer) with full scope. Customers act on their own records only. */
export const requireCustomer: preHandlerAsyncHookHandler = async function (request, reply) {
  await requireUser.call(this, request, reply);
  if (request.user?.userType !== 'CUSTOMER') throw new ForbiddenError();
};

/**
 * preHandler: the caller has an ACTIVE expert profile (staff or vendor login). Authorised by
 * identity, not a permission: an expert only ever reads / changes their own profile and queue.
 * The profile id is stored on `request.expertId`.
 */
export const requireExpert: preHandlerAsyncHookHandler = async function (request, reply) {
  await requireUser.call(this, request, reply);
  const user = request.user;
  if (user === null || (user.userType !== 'INTERNAL' && user.userType !== 'VENDOR'))
    throw new ForbiddenError();
  const expertId = await request.diScope.resolve('expertsService').activeIdOfUser(user.id);
  if (expertId === null) throw new ForbiddenError('No active expert profile for this user');
  request.expertId = expertId;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireExpert`. */
    expertId?: string;
  }
}

/** Customer reads: token + 120 / min. */
export const customerRead = [requireCustomer, rateLimit('customer-read', 120, 60)];

/** Expert routes: token + profile + 120 / min. */
export const expert = [requireExpert, rateLimit('expert', 120, 60)];

/** Admin reads: staff + permission. */
export const admin = (permission: string) => [requireStaff, requirePermission(permission)];

/** Admin writes: staff + permission + 60 writes / minute per user. */
export const adminWrite = (permission: string) => [
  requireStaff,
  requirePermission(permission),
  rateLimit('admin-write', 60, 60),
];
