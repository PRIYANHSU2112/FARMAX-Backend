import type { FastifyRequest } from 'fastify';

export interface AuditEntry {
  actorUserId: string;
  action: string;
  targetType: 'farm' | 'owner' | 'case' | 'document' | 'territory' | 'pincode';
  targetId: string;
  before?: object | null;
  after?: object | null;
  reason?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

export interface AuditRecord {
  id: string;
  actorUserId: string;
  action: string;
  reason: string | null;
  createdAt: Date;
}

/** Who did it, from where: built once per admin request by the controller. */
export interface Actor {
  userId: string;
  ip: string;
  requestId: string;
}

export const actorOf = (request: FastifyRequest): Actor => {
  if (request.user === null) throw new Error('actorOf: route is missing requireAuth');
  return { userId: request.user.id, ip: request.ip, requestId: request.id };
};
