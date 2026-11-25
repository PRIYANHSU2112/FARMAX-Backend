import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import type { UserType } from '@farmx/common/types';
import { hitRateLimit, orderKeys } from '@farmx/infra/redis';
import type { preHandlerAsyncHookHandler } from 'fastify';

/**
 * Permission keys this service checks (must exist in auth's permissions.catalog.ts). Coupons and
 * campaigns already belong to the `pricing` module there ("Pricing, discounts & promotions").
 */
export const ORDER_PERMISSIONS = new Set([
  'pricing.view',
  'pricing.manage',
  'orders.view',
  'payments.view',
  'orders.update',
  'orders.cancel',
  'orders.confirm',
  'orders.configure',
  'refunds.initiate',
  'refunds.approve',
  'invoices.view',
  'invoices.export',
]);

/** preHandler: valid, non-revoked access token with FULL scope; optionally a persona. */
export const requireAuth = (...userTypes: UserType[]): preHandlerAsyncHookHandler =>
  async function (request, reply) {
    const verify = request.diScope.resolve('tokenVerifier');
    await authenticate(verify).call(this, request, reply);
    const user = request.user;
    if (user?.scope !== 'full') throw new ForbiddenError('Finish MFA enrolment first');
    if (userTypes.length > 0 && !userTypes.includes(user.userType)) throw new ForbiddenError();
  };

/** preHandler (after requireAuth): default deny. Unknown keys throw at registration. */
export const requirePermission = (key: string): preHandlerAsyncHookHandler => {
  if (!ORDER_PERMISSIONS.has(key))
    throw new Error(`requirePermission: unknown permission "${key}"`);
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope
      .resolve('accessClient')
      .hasPermission(request.user.id, key);
    if (!allowed) throw new ForbiddenError();
  };
};

/** Admin routes: INTERNAL staff, full (MFA) scope, permission key. */
export const admin = (permission: string) => [
  requireAuth('INTERNAL'),
  requirePermission(permission),
];

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
        ? orderKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : orderKeys.rateLimit(action, 'user', userId);
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

/**
 * preHandler for routes open to guests AND customers (cart): no `Authorization` header → guest
 * (request.user stays null); with one → it must be a valid CUSTOMER token (never silently a guest).
 */
export const optionalCustomer: preHandlerAsyncHookHandler = async function (request, reply) {
  if (request.headers.authorization === undefined) return;
  await requireAuth('CUSTOMER').call(this, request, reply);
};
