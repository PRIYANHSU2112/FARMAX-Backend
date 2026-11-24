import type { FastifyRequest } from 'fastify';

export type AuditTarget =
  | 'setting'
  | 'calendar'
  | 'holiday'
  | 'topic'
  | 'rule'
  | 'sla'
  | 'faq'
  | 'faq_category'
  | 'legal'
  | 'company_document'
  | 'company_application'
  | 'agent'
  | 'canned_reply';

export interface AuditEntry {
  action: string;
  targetType: AuditTarget;
  targetId: string;
  before?: object | null;
  after?: object | null;
  reason?: string | null;
}

/**
 * Who did it, from where. `userId` null = a system actor (an internal service call, the expiry
 * job); `requestId` ties the row to the request log.
 */
export interface Actor {
  userId: string | null;
  ip: string | null;
  requestId: string | null;
}

/** Actor of an authenticated request (staff, expert or customer; the route ran a guard). */
export const actorOf = (request: FastifyRequest): Actor => {
  if (request.user === null) throw new Error('actorOf: route is missing its auth guard');
  return { userId: request.user.id, ip: request.ip, requestId: request.id };
};

/** A service-to-service call (`/internal/*`): no user, but keep the request id. */
export const systemActorOf = (request: FastifyRequest): Actor => ({
  userId: null,
  ip: request.ip,
  requestId: request.id,
});

export const SYSTEM_ACTOR: Actor = { userId: null, ip: null, requestId: null };
