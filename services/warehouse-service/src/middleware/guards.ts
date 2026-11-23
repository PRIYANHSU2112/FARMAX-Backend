import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import { hitRateLimit, warehouseKeys } from '@farmx/infra/redis';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { Access } from './access.js';

/**
 * Permission keys this service checks (must exist in auth's permissions.catalog.ts). Scoped:
 * a key may be held GLOBALLY or at one warehouse only (D-56).
 */
export const WAREHOUSE_PERMISSIONS = new Set([
  'warehouse.view',
  'warehouse.configure',
  'warehouse.operate',
  'warehouse.create',
  'warehouse.status_change',
  'warehouse.team_manage',
  // D-57 (stock + fulfilment)
  'inventory.view',
  'inventory.configure',
  'inventory.receive',
  'inventory.pick',
  'inventory.transfer',
  'inventory.exception_raise',
  'inventory.adjust',
  'inventory.quarantine_release',
  'inventory.write_off',
  'inventory.restock_request',
  'inventory.restock_approve',
  'inventory.lifecycle_approve',
  'quality.view',
  'quality.hold_create',
  'quality.hold_release',
  'vendors.manage',
  'fulfilment.view',
  'fulfilment.manage',
  'fulfilment.reallocate',
  'fulfilment.fefo_override',
  'compliance.review',
  'routing.manage',
  'orders.update',
  'orders.cancel',
  'logistics.dispatch_assign',
  'logistics.consignment_view',
  'logistics.delivery_override',
  'logistics.delivery_exception_manage',
  'logistics.fleet_manage',
  'logistics.delivery_confirm',
]);

/**
 * D-57 audiences (same handlers): the warehouse panel (`/wms`, scoped to the caller's
 * warehouses) and the admin panel (`/admin/wms`, GLOBAL grants only, every warehouse).
 */
export type Audience = 'panel' | 'admin';

/** Admin panel: the key must be held GLOBALLY (else 403). */
export const requireGlobal = (key: string): preHandlerAsyncHookHandler => {
  if (!WAREHOUSE_PERMISSIONS.has(key))
    throw new Error(`requireGlobal: unknown permission "${key}"`);
  return async (request) => {
    if (request.access?.isGlobal(key) !== true) throw new ForbiddenError();
  };
};

declare module 'fastify' {
  interface FastifyRequest {
    /** The caller's grants, loaded by the staff guard (one Redis round trip). */
    access?: Access;
  }
}

/** Valid, non-revoked access token of an INTERNAL (staff) user with FULL scope + their grants. */
const requireStaff: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
  const user = request.user;
  if (user?.scope !== 'full') throw new ForbiddenError('Finish MFA enrolment first');
  if (user.userType !== 'INTERNAL') throw new ForbiddenError();
  request.access = new Access(await request.diScope.resolve('accessClient').grants(user.id));
};

/**
 * Coarse check at the route: the key is held GLOBALLY or at ≥ 1 warehouse (else 403). The
 * service then checks the exact warehouse (`Access.require`): out of scope → 404.
 */
export const requireAnywhere = (key: string): preHandlerAsyncHookHandler => {
  if (!WAREHOUSE_PERMISSIONS.has(key))
    throw new Error(`requireAnywhere: unknown permission "${key}"`);
  return async (request) => {
    if (request.access?.holdsAnywhere(key) !== true) throw new ForbiddenError();
  };
};

/** Fixed-window limit per user, 1 atomic Redis round trip. Redis down → allow. */
export const rateLimit =
  (action: string, limit: number, windowSeconds: number): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const userId = request.user?.id;
    const key =
      userId === undefined
        ? warehouseKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : warehouseKeys.rateLimit(action, 'user', userId);
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

/** Reads: staff + the key somewhere. */
export const staffRead = (key: string) => [requireStaff, requireAnywhere(key)];

/** Writes: staff + the key somewhere + 60 writes / minute per user. */
export const staffWrite = (key: string) => [
  requireStaff,
  requireAnywhere(key),
  rateLimit('write', 60, 60),
];

/** Read guard for an audience: panel = key anywhere; admin = key GLOBALLY. */
export const audRead = (aud: Audience, key: string) =>
  aud === 'admin' ? [requireStaff, requireGlobal(key)] : staffRead(key);

/** Write guard for an audience (+ 60 writes / minute per user). */
export const audWrite = (aud: Audience, key: string) =>
  aud === 'admin'
    ? [requireStaff, requireGlobal(key), rateLimit('write', 60, 60)]
    : staffWrite(key);

/** Any signed-in staff user (the portal shell: `me`). */
export const staffOnly = [requireStaff];

/** Who is acting (audit) and what they may do. Routes run a staff guard first. */
export interface Caller {
  userId: string;
  ip: string | null;
  requestId: string;
  access: Access;
}

export const callerOf = (request: FastifyRequest): Caller => {
  if (request.user === null || request.access === undefined) throw new UnauthorizedError();
  return {
    userId: request.user.id,
    ip: request.ip,
    requestId: request.id,
    access: request.access,
  };
};
