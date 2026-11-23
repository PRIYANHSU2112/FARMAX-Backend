import { internalAuth } from '@farmx/common/middleware';
import type { FastifyPluginAsync } from 'fastify';
import Joi from 'joi';

import type { InviteStaffInput, ResendInvitationInput, RevokeStaffInput } from './staff.types.js';

const ID = Joi.string().guid();
const REQUEST_ID = Joi.string().max(64);

/**
 * Mounted at `/internal/staff`, service-to-service only (warehouse-service Team screen, D-56;
 * never routed by the gateway, hidden from docs). Not registered without INTERNAL_SERVICE_TOKEN.
 *   POST /invitations            add an employee (create or reuse the account + grant the role)
 *   POST /invitations/resend     new code for a member who has not accepted yet
 *   POST /assignments/revoke     remove a member's role(s) at one warehouse
 * The acting user's rights are re-checked here (team_manage at the warehouse, no escalation).
 */
export const staffInternalRoutes: FastifyPluginAsync = async (app) => {
  const token = app.diContainer.resolve('config').INTERNAL_SERVICE_TOKEN;
  if (token === undefined) return;
  const guard = internalAuth(token);
  const svc = () => app.diContainer.resolve('staffService');

  app.post<{ Body: InviteStaffInput }>(
    '/invitations',
    {
      schema: {
        hide: true,
        body: Joi.object({
          email: Joi.string().trim().lowercase().email().max(254).required(),
          fullName: Joi.string().trim().min(2).max(120).required(),
          roleId: ID.required(),
          warehouseId: ID.required(),
          invitedByUserId: ID.required(),
          reason: Joi.string().trim().max(500),
          requestId: REQUEST_ID,
        }),
      },
      onRequest: [guard],
    },
    async (request, reply) =>
      reply.code(201).send({ success: true, data: await svc().invite(request.body) }),
  );

  app.post<{ Body: ResendInvitationInput }>(
    '/invitations/resend',
    {
      schema: {
        hide: true,
        body: Joi.object({
          userId: ID.required(),
          warehouseId: ID.required(),
          requestedByUserId: ID.required(),
          requestId: REQUEST_ID,
        }),
      },
      onRequest: [guard],
    },
    async (request) => ({ success: true, data: await svc().resendInvitation(request.body) }),
  );

  app.post<{ Body: RevokeStaffInput }>(
    '/assignments/revoke',
    {
      schema: {
        hide: true,
        body: Joi.object({
          userId: ID.required(),
          warehouseId: ID.required(),
          roleId: ID,
          revokedByUserId: ID.required(),
          reason: Joi.string().trim().min(3).max(500).required(),
          requestId: REQUEST_ID,
        }),
      },
      onRequest: [guard],
    },
    async (request) => ({ success: true, data: await svc().revoke(request.body) }),
  );
};
