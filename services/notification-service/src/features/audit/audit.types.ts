import type { FastifyRequest } from 'fastify';

export type AuditTarget = 'notification' | 'template' | 'delivery';

export interface AuditEntry {
  action: string;
  targetType: AuditTarget;
  targetId: string;
  before?: object | null;
  after?: object | null;
  reason?: string | null;
}

/**
 * Who did it, from where. `userId` null = a system actor (a job or the event consumer);
 * `requestId` ties the row to the request log.
 */
export interface Actor {
  userId: string | null;
  ip: string | null;
  requestId: string | null;
}

/** Staff actor of an admin request (the route must run requireStaff first). */
export const actorOf = (request: FastifyRequest): Actor => {
  if (request.user === null) throw new Error('actorOf: route is missing the staff guard');
  return { userId: request.user.id, ip: request.ip, requestId: request.id };
};

export const SYSTEM_ACTOR: Actor = { userId: null, ip: null, requestId: null };
