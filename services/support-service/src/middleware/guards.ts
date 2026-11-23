import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import { hitRateLimit, supportKeys } from '@farmx/infra/redis';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import type { App } from './http.js';

/** Permission keys this service checks (all exist in auth's permissions.catalog.ts). */
export const SUPPORT_PERMISSIONS = new Set([
  'support.view',
  'support.manage',
  'support.assign',
  'support.escalate',
  'support.configure',
  'faq.manage',
  'legal.manage',
]);

/** Which app a requester raises tickets from. Staff (INTERNAL) raise them as WAREHOUSE users. */
const APP_OF_USER_TYPE: Record<string, App> = {
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
  LOGISTICS_PARTNER: 'LOGISTICS',
  INTERNAL: 'WAREHOUSE',
};

export const appOfUserType = (userType: string): App => {
  const app = APP_OF_USER_TYPE[userType];
  if (app === undefined) throw new ForbiddenError();
  return app;
};

/** preHandler: valid, non-revoked access token with FULL scope (any user type). */
export const requireUser: preHandlerAsyncHookHandler = async function (request, reply) {
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
  if (!SUPPORT_PERMISSIONS.has(key))
    throw new Error(`requirePermission: unknown permission "${key}"`);
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope
      .resolve('accessClient')
      .hasPermission(request.user.id, key);
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
        ? supportKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : supportKeys.rateLimit(action, 'user', userId);
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

/** The authenticated requester (customer / vendor / driver / warehouse staff) and their app. */
export interface Requester {
  userId: string;
  userType: string;
  app: App;
}

export const requesterOf = (request: FastifyRequest): Requester => {
  if (request.user === null) throw new Error('requesterOf: route is missing its auth guard');
  return {
    userId: request.user.id,
    userType: request.user.userType,
    app: appOfUserType(request.user.userType),
  };
};

/** Public reads (FAQ, legal, config): IP limit only. */
export const publicRead = [rateLimit('public-read', 240, 60)];

/** Requester reads: token + 120 / min. */
export const requesterRead = [requireUser, rateLimit('requester-read', 120, 60)];

/** Requester writes: token + 30 / min. */
export const requesterWrite = [requireUser, rateLimit('requester-write', 30, 60)];

/** Ticket creation: token + 10 / hour (spam guard; the open-ticket cap is a setting). */
export const ticketCreate = [requireUser, rateLimit('ticket-create', 10, 3600)];

/** Admin reads: staff + permission. */
export const admin = (permission: string) => [requireStaff, requirePermission(permission)];

/** Admin writes: staff + permission + 120 writes / minute per user. */
export const adminWrite = (permission: string) => [
  requireStaff,
  requirePermission(permission),
  rateLimit('admin-write', 120, 60),
];
