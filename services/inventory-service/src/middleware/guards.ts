import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate, internalAuth } from '@farmx/common/middleware';
import { hitRateLimit, inventoryKeys } from '@farmx/infra/redis';
import type {
  FastifyInstance,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

/**
 * Permission keys this service checks (must exist in auth's permissions.catalog.ts). GLOBAL keys
 * only: inventory is administered centrally; warehouse-scoped grants arrive with the WMS phase.
 */
export const INVENTORY_PERMISSIONS = new Set([
  'inventory.view',
  'inventory.configure',
  'inventory.receive',
  'inventory.exception_raise',
  'inventory.adjust',
  'inventory.write_off',
]);

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
  if (!INVENTORY_PERMISSIONS.has(key))
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
        ? inventoryKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : inventoryKeys.rateLimit(action, 'user', userId);
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

/** Admin reads: staff + permission. */
export const admin = (permission: string) => [requireStaff, requirePermission(permission)];

/** Admin writes: staff + permission + 60 writes / minute per user. */
export const adminWrite = (permission: string) => [
  requireStaff,
  requirePermission(permission),
  rateLimit('admin-write', 60, 60),
];

/**
 * `/internal/*` (service-to-service, never routed by the gateway, D-27): the shared token, checked
 * in onRequest — BEFORE body validation, so callers without it learn nothing about the API.
 * Returns null when INTERNAL_SERVICE_TOKEN is unset — the caller then registers no routes.
 */
export const internalGuard = (app: FastifyInstance): onRequestAsyncHookHandler | null => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  return token === undefined ? null : internalAuth(token);
};
