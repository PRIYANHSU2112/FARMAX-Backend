import { UnauthorizedError } from '@farmx/common/errors';
import type { FastifyRequest } from 'fastify';

import type { AuditActor } from './audit.types.js';

/** Who is acting and from where, for the audit log. Requires `requireAuth` to have run. */
export const actorFromRequest = (request: FastifyRequest): AuditActor => {
  if (request.user === null) throw new UnauthorizedError();
  const userAgent = request.headers['user-agent'];
  return {
    userId: request.user.id,
    ip: request.ip,
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 512),
    requestId: request.id,
  };
};
