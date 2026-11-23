import { ForbiddenError, ValidationError } from '@farmx/common/errors';
import type { FrameHandler, FrameHandlers, RealtimeConnection } from '@farmx/infra/realtime';
import type { Cradle } from '@fastify/awilix';
import Joi from 'joi';

import { ID } from '../../middleware/http.js';
import {
  AGENTS_ROOM,
  CLIENT_MESSAGE_ID,
  RECEIPTS,
  type TicketActor,
  ticketRoom,
} from '../tickets/index.js';

/** Joi → frame parser: 422-style issues come back as an `error` frame. */
const parser =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T = the handler's payload type (from context)
  <T>(schema: Joi.Schema) =>
    (data: unknown): T => {
      const { error, value } = schema.validate(data ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      }) as {
        error?: Joi.ValidationError;
        value: unknown;
      };
      if (error !== undefined)
        throw new ValidationError(
          error.details.map((d) => ({ path: `data.${d.path.join('.')}`, message: d.message })),
        );
      return value as T;
    };

const isAgent = (conn: RealtimeConnection) => conn.hasTag('agent');
const viewerOf = (conn: RealtimeConnection) => ({
  userId: conn.principal.userId,
  agent: isAgent(conn),
});

type Deps = Pick<Cradle, 'ticketsService' | 'realtimeHub'>;

/**
 * Support chat frames. Every frame re-checks access (owner, or agent tag) — joining a room is never
 * trusted later. Agent actions (assign, escalate, status, notes) are REST-only (permission-checked);
 * over the socket agents can only reply publicly, and only with the `agent:manage` tag.
 *   subscribe {ticketId, afterSeq?}  → ack { ticket, messages[] after afterSeq } + joins the room
 *   unsubscribe {ticketId}
 *   queue.subscribe                  → agents: live queue.updated / sla.breached
 *   message.send {ticketId, clientMessageId, body, attachments?} → ack { message, replayed }
 *   typing {ticketId}                → others in the room get `typing`
 *   read {ticketId, seq}             → ack { lastReadSeq }; others get `read`
 */
export function createChatHandlers(deps: Deps): FrameHandlers {
  const subscribe: FrameHandler<{ ticketId: string; afterSeq?: number }> = {
    parse: parser(Joi.object({ ticketId: ID.required(), afterSeq: Joi.number().integer().min(0) })),
    handle: async (conn, { ticketId, afterSeq }) => {
      const viewer = viewerOf(conn);
      const ticket = await deps.ticketsService.accessible(viewer, ticketId);
      if (!conn.join(ticketRoom(ticketId)))
        throw new ValidationError([
          { path: 'data.ticketId', message: 'too many open tickets on this socket' },
        ]);
      const messages =
        afterSeq === undefined
          ? []
          : await deps.ticketsService.messages(viewer, ticketId, { afterSeq, limit: 100 });
      return { ticketId, status: ticket.status, version: ticket.version, messages };
    },
  };

  const unsubscribe: FrameHandler<{ ticketId: string }> = {
    parse: parser(Joi.object({ ticketId: ID.required() })),
    handle: (conn, { ticketId }) => {
      conn.leave(ticketRoom(ticketId));
      return { ticketId };
    },
  };

  const queueSubscribe: FrameHandler = {
    handle: (conn) => {
      if (!isAgent(conn)) throw new ForbiddenError();
      conn.join(AGENTS_ROOM);
      return { room: AGENTS_ROOM };
    },
  };

  const send: FrameHandler<{
    ticketId: string;
    clientMessageId: string;
    body: string;
    attachments?: string[];
  }> = {
    parse: parser(
      Joi.object({
        ticketId: ID.required(),
        clientMessageId: CLIENT_MESSAGE_ID.required(),
        body: Joi.string().trim().max(4000).allow('').default(''),
        attachments: RECEIPTS,
      })
        .custom((v: { body: string; attachments?: string[] }, h) =>
          v.body === '' && (v.attachments?.length ?? 0) === 0 ? h.error('any.invalid') : v,
        )
        .messages({ 'any.invalid': 'a message needs text or at least one file' }),
    ),
    handle: async (conn, input) => {
      if (isAgent(conn) && !conn.hasTag('agent:manage')) throw new ForbiddenError();
      const actor: TicketActor = {
        userId: conn.principal.userId,
        role: isAgent(conn) ? 'AGENT' : 'REQUESTER',
        name: null,
        requestId: `ws:${conn.id}`,
        ip: null,
      };
      return deps.ticketsService.addMessage(actor, input.ticketId, {
        clientMessageId: input.clientMessageId,
        body: input.body,
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        kind: 'TEXT',
      });
    },
  };

  const typing: FrameHandler<{ ticketId: string }> = {
    parse: parser(Joi.object({ ticketId: ID.required() })),
    handle: (conn, { ticketId }) => {
      const room = ticketRoom(ticketId);
      if (!conn.rooms.has(room)) throw new ForbiddenError('Subscribe to the ticket first');
      deps.realtimeHub.publish(
        room,
        'typing',
        { ticketId, role: isAgent(conn) ? 'AGENT' : 'REQUESTER' },
        { except: conn.id },
      );
      return null;
    },
  };

  const read: FrameHandler<{ ticketId: string; seq: number }> = {
    parse: parser(
      Joi.object({ ticketId: ID.required(), seq: Joi.number().integer().min(0).required() }),
    ),
    handle: (conn, { ticketId, seq }) =>
      deps.ticketsService.markRead(viewerOf(conn), ticketId, seq),
  };

  return {
    subscribe,
    unsubscribe,
    'queue.subscribe': queueSubscribe,
    'message.send': send,
    typing,
    read,
  };
}
