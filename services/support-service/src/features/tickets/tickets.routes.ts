import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  requesterOf,
  requesterRead,
  requesterWrite,
  ticketCreate,
} from '../../middleware/guards.js';
import { idParams, idempotencyKeyOf } from '../../middleware/http.js';
import { TICKET_DOCS } from './tickets.docs.js';
import type { RequesterCtx } from './tickets.service.js';
import type { CreateTicketInput, MessageInput, TicketListQuery } from './tickets.types.js';
import {
  attachmentParams,
  closeBody,
  createTicketBody,
  feedbackBody,
  listQuery,
  messageBody,
  messagesQuery,
  readBody,
} from './tickets.validation.js';
import { requesterView } from './tickets.views.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('ticketsService');
const ctx = (req: FastifyRequest): RequesterCtx => ({
  ...requesterOf(req),
  requestId: req.id,
  ip: req.ip,
});
const viewer = (req: FastifyRequest) => ({ userId: req.user?.id ?? '', agent: false });

interface Id {
  Params: { id: string };
}
interface Page {
  afterSeq?: number;
  beforeSeq?: number;
  limit: number;
}

/** Mounted at `/support/tickets` (gateway: `/v1/support/tickets`). Requesters, own tickets only. */
export const ticketsRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: CreateTicketInput }>(
    '/',
    {
      schema: { body: createTicketBody, ...routeDocs(TICKET_DOCS.create) },
      preHandler: ticketCreate,
    },
    async (req, reply) => {
      const { ticket, replayed } = await svc(req).create(ctx(req), req.body, idempotencyKeyOf(req));
      return reply.status(replayed ? 200 : 201).send(ok(requesterView(ticket, 0)));
    },
  );
  app.get<{ Querystring: TicketListQuery }>(
    '/',
    {
      schema: { querystring: listQuery, ...routeDocs(TICKET_DOCS.list) },
      preHandler: requesterRead,
    },
    async (req) => {
      const { counts, ...page } = await svc(req).list(ctx(req), req.query);
      return { ...paginated(page), meta: { ...paginated(page).meta, counts } };
    },
  );
  app.get<Id>(
    '/:id',
    { schema: { ...idParams, ...routeDocs(TICKET_DOCS.detail) }, preHandler: requesterRead },
    async (req) => ok(await svc(req).detail(ctx(req), req.params.id)),
  );
  app.get<Id & { Querystring: Page }>(
    '/:id/messages',
    {
      schema: { ...idParams, querystring: messagesQuery, ...routeDocs(TICKET_DOCS.messages) },
      preHandler: requesterRead,
    },
    async (req) => ok(await svc(req).messages(viewer(req), req.params.id, req.query)),
  );
  app.post<Id & { Body: MessageInput }>(
    '/:id/messages',
    {
      schema: { ...idParams, body: messageBody, ...routeDocs(TICKET_DOCS.send) },
      preHandler: requesterWrite,
    },
    async (req, reply) => {
      const r = ctx(req);
      const result = await svc(req).addMessage(
        { userId: r.userId, role: 'REQUESTER', name: null, requestId: r.requestId, ip: r.ip },
        req.params.id,
        req.body,
      );
      return reply.status(result.replayed ? 200 : 201).send(ok(result));
    },
  );
  app.post<Id & { Body: { seq: number } }>(
    '/:id/read',
    {
      schema: { ...idParams, body: readBody, ...routeDocs(TICKET_DOCS.read) },
      preHandler: requesterWrite,
    },
    async (req) => ok(await svc(req).markRead(viewer(req), req.params.id, req.body.seq)),
  );
  app.post<Id & { Body: { resolved: boolean; comment?: string } }>(
    '/:id/feedback',
    {
      schema: { ...idParams, body: feedbackBody, ...routeDocs(TICKET_DOCS.feedback) },
      preHandler: requesterWrite,
    },
    async (req) =>
      ok(await svc(req).feedback(ctx(req), req.params.id, req.body.resolved, req.body.comment)),
  );
  app.post<Id & { Body: { reason?: string } }>(
    '/:id/close',
    {
      schema: { ...idParams, body: closeBody, ...routeDocs(TICKET_DOCS.close) },
      preHandler: requesterWrite,
    },
    async (req) => ok(await svc(req).close(ctx(req), req.params.id, req.body.reason)),
  );
  app.get<{ Params: { id: string; attachmentId: string } }>(
    '/:id/attachments/:attachmentId/url',
    {
      schema: { params: attachmentParams, ...routeDocs(TICKET_DOCS.attachmentUrl) },
      preHandler: requesterRead,
    },
    async (req) =>
      ok(await svc(req).attachmentUrl(viewer(req), req.params.id, req.params.attachmentId)),
  );
};
