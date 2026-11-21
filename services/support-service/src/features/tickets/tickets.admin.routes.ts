import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { admin, adminWrite } from '../../middleware/guards.js';
import { idParams, idempotencyKeyOf, ifMatchOf } from '../../middleware/http.js';
import type { Priority, Team } from '../topics/index.js';
import { TICKET_DOCS } from './tickets.docs.js';
import type { SendInput } from './tickets.service.js';
import type { Channel, CreateTicketInput, QueueQuery, TicketActor, TicketStatus } from './tickets.types.js';
import {
  agentMessageBody,
  assignBody,
  attachmentParams,
  escalateBody,
  intakeBody,
  messagesQuery,
  priorityBody,
  queueQuery,
  readBody,
  statusBody,
} from './tickets.validation.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('ticketsAdminService');
const actor = (req: FastifyRequest): TicketActor => ({
  userId: req.user?.id ?? '',
  role: 'AGENT',
  name: null,
  requestId: req.id,
  ip: req.ip,
});

type Id = { Params: { id: string } };

/** Mounted at `/support/admin/tickets` (gateway: `/v1/support/admin/tickets`). Staff only. */
export const ticketsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: QueueQuery }>(
    '/',
    { schema: { querystring: queueQuery, ...routeDocs(TICKET_DOCS.queue) }, preHandler: admin('support.view') },
    async (req) => paginated(await svc(req).queue(req.query, req.user?.id ?? '')),
  );
  app.get('/stats', { schema: routeDocs(TICKET_DOCS.stats), preHandler: admin('support.view') }, async (req) =>
    ok(await svc(req).stats(req.user?.id ?? '')),
  );
  app.post<{ Body: CreateTicketInput & { requesterId: string; channel: Channel } }>(
    '/',
    { schema: { body: intakeBody, ...routeDocs(TICKET_DOCS.intake) }, preHandler: adminWrite('support.manage') },
    async (req, reply) => {
      const { ticket, replayed } = await svc(req).intake(actor(req), req.body, idempotencyKeyOf(req));
      return reply.status(replayed ? 200 : 201).send(ok(ticket));
    },
  );
  app.get<Id>('/:id', { schema: { ...idParams, ...routeDocs(TICKET_DOCS.adminDetail) }, preHandler: admin('support.view') }, async (req) =>
    ok(await svc(req).detail(req.params.id)),
  );
  app.get<Id & { Querystring: { afterSeq?: number; beforeSeq?: number; limit: number } }>(
    '/:id/messages',
    { schema: { ...idParams, querystring: messagesQuery, ...routeDocs(TICKET_DOCS.adminMessages) }, preHandler: admin('support.view') },
    async (req) => ok(await svc(req).messages(actor(req), req.params.id, req.query)),
  );
  app.post<Id & { Body: SendInput }>(
    '/:id/messages',
    { schema: { ...idParams, body: agentMessageBody, ...routeDocs(TICKET_DOCS.adminSend) }, preHandler: adminWrite('support.manage') },
    async (req, reply) => {
      const result = await svc(req).send(actor(req), req.params.id, req.body);
      return reply.status(result.replayed ? 200 : 201).send(ok(result));
    },
  );
  app.post<Id & { Body: { seq: number } }>(
    '/:id/read',
    { schema: { ...idParams, body: readBody, ...routeDocs(TICKET_DOCS.adminRead) }, preHandler: admin('support.view') },
    async (req) => ok(await svc(req).read(actor(req), req.params.id, req.body.seq)),
  );
  app.post<Id>('/:id/claim', { schema: { ...idParams, ...routeDocs(TICKET_DOCS.claim) }, preHandler: adminWrite('support.manage') }, async (req) =>
    ok(await svc(req).claim(actor(req), req.params.id)),
  );
  app.post<Id & { Body: { assigneeId: string; reason?: string } }>(
    '/:id/assign',
    { schema: { ...idParams, body: assignBody, ...routeDocs(TICKET_DOCS.assign) }, preHandler: adminWrite('support.assign') },
    async (req) => ok(await svc(req).assign(actor(req), req.params.id, req.body.assigneeId, req.body.reason, ifMatchOf(req))),
  );
  app.post<Id & { Body: { team: Team; assigneeId?: string; reason: string; note?: string } }>(
    '/:id/escalate',
    { schema: { ...idParams, body: escalateBody, ...routeDocs(TICKET_DOCS.escalate) }, preHandler: adminWrite('support.escalate') },
    async (req) => ok(await svc(req).escalate(actor(req), req.params.id, req.body, ifMatchOf(req))),
  );
  app.patch<Id & { Body: { priority: Priority; reason: string } }>(
    '/:id/priority',
    { schema: { ...idParams, body: priorityBody, ...routeDocs(TICKET_DOCS.priority) }, preHandler: adminWrite('support.manage') },
    async (req) => ok(await svc(req).setPriority(actor(req), req.params.id, req.body.priority, req.body.reason, ifMatchOf(req))),
  );
  app.post<Id & { Body: { to: TicketStatus; reason?: string } }>(
    '/:id/status',
    { schema: { ...idParams, body: statusBody, ...routeDocs(TICKET_DOCS.status) }, preHandler: adminWrite('support.manage') },
    async (req) => ok(await svc(req).setStatus(actor(req), req.params.id, req.body.to, req.body.reason, ifMatchOf(req))),
  );
  app.get<{ Params: { id: string; attachmentId: string } }>(
    '/:id/attachments/:attachmentId/url',
    { schema: { params: attachmentParams, ...routeDocs(TICKET_DOCS.adminAttachmentUrl) }, preHandler: admin('support.view') },
    async (req) => ok(await svc(req).attachmentUrl(actor(req), req.params.id, req.params.attachmentId)),
  );
};
