import { ForbiddenError, RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import { hitRateLimit, qualityKeys } from '@farmx/infra/redis';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { Access } from './access.js';

/**
 * Permission keys this service checks (all exist in auth's permissions.catalog.ts). Scoped like
 * warehouse-service (D-56): a key may be held GLOBALLY or at one warehouse only.
 *   quality.view              read samples, COAs, decisions, audit
 *   quality.hold_create       create / move samples, quarantine a batch
 *   traceability.coa_publish  upload COAs, enter results
 *   traceability.coa_verify   approve / reject a COA (four-eyes, GLOBAL)
 *   quality.hold_release      release a batch (GLOBAL)
 *   quality.recall_initiate   recall a batch (GLOBAL)
 *   quality.spec_manage       SKU specification limits (GLOBAL)
 *   quality.lab_manage        laboratory list (GLOBAL)
 */
export const QUALITY_PERMISSIONS = new Set([
  'warehouse.view',
  'quality.view',
  'quality.hold_create',
  'quality.hold_release',
  'quality.recall_initiate',
  'quality.spec_manage',
  'quality.lab_manage',
  'traceability.coa_view',
  'traceability.coa_publish',
  'traceability.coa_verify',
]);

/** Warehouse panel (`/quality`, scoped) or admin panel (`/admin/quality`, GLOBAL keys only). */
export type Audience = 'panel' | 'admin';

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

/** Customer app (`/certificates`): a signed-in CUSTOMER (own orders only, checked in the service). */
const requireCustomer: preHandlerAsyncHookHandler = async function (request, reply) {
  const verify = request.diScope.resolve('tokenVerifier');
  await authenticate(verify).call(this, request, reply);
  if (request.user?.scope !== 'full') throw new ForbiddenError('Finish sign-in first');
  if (request.user.userType !== 'CUSTOMER') throw new ForbiddenError();
};

const known = (key: string): string => {
  if (!QUALITY_PERMISSIONS.has(key)) throw new Error(`unknown permission "${key}"`);
  return key;
};

/** Panel: the key held GLOBALLY or at ≥ 1 warehouse (the service checks the exact warehouse). */
const requireAnywhere = (key: string): preHandlerAsyncHookHandler => {
  known(key);
  return async (request) => {
    if (request.access?.holdsAnywhere(key) !== true) throw new ForbiddenError();
  };
};

/** Admin panel / GLOBAL-only actions: the key must be held GLOBALLY. */
const requireGlobal = (key: string): preHandlerAsyncHookHandler => {
  known(key);
  return async (request) => {
    if (request.access?.isGlobal(key) !== true) throw new ForbiddenError();
  };
};

/** Fixed-window limit per user (or IP), 1 atomic Redis round trip. Redis down → allow. */
export const rateLimit =
  (action: string, limit: number, windowSeconds: number): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const userId = request.user?.id;
    const key =
      userId === undefined
        ? qualityKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : qualityKeys.rateLimit(action, 'user', userId);
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

/** Read guard: panel = key anywhere; admin = key GLOBALLY. */
export const audRead = (aud: Audience, key: string) =>
  aud === 'admin' ? [requireStaff, requireGlobal(key)] : [requireStaff, requireAnywhere(key)];

/** Write guard (+ 60 writes / minute per user). */
export const audWrite = (aud: Audience, key: string) => [
  ...audRead(aud, key),
  rateLimit('write', 60, 60),
];

/** GLOBAL-only write on both panels (approve, release, recall, specs, labs). */
export const globalWrite = (key: string) => [
  requireStaff,
  requireGlobal(key),
  rateLimit('write', 60, 60),
];

/** Customer reads: token + 120 / min. Writes (watch toggle): 30 / min. */
export const customerRead = [requireCustomer, rateLimit('customer-read', 120, 60)];
export const customerWrite = [requireCustomer, rateLimit('customer-write', 30, 60)];

/** Public verification: no login, 60 / min per IP. */
export const publicRead = [rateLimit('public-verify', 60, 60)];

/** Who is acting (audit) and what they may do. Routes run a staff guard first. */
export interface Caller {
  userId: string;
  ip: string | null;
  requestId: string;
  access: Access;
}

export const callerOf = (request: FastifyRequest): Caller => {
  if (request.user === null || request.access === undefined) throw new UnauthorizedError();
  return { userId: request.user.id, ip: request.ip, requestId: request.id, access: request.access };
};

/** A signed-in customer. */
export interface Customer {
  userId: string;
  requestId: string;
}

export const customerOf = (request: FastifyRequest): Customer => {
  if (request.user === null) throw new UnauthorizedError();
  return { userId: request.user.id, requestId: request.id };
};

/** Audit actor of a staff caller. */
export const actorOf = (caller: Caller) => ({
  userId: caller.userId,
  type: 'STAFF' as const,
  requestId: caller.requestId,
  ip: caller.ip,
});
