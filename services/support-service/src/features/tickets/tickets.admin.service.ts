import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import { SUPPORT_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitSupportEvent } from '../../adapters/events.js';
import type { App } from '../../middleware/http.js';
import { omit } from '../../middleware/http.js';
import { type Priority, type Team, recomputeForPolicy } from '../topics/index.js';
import { loadDelta, transitionPatch } from './tickets.lifecycle.js';
import {
  type ChangePlan,
  type SendInput,
  joinedMessage,
  refOf,
  systemMessage,
} from './tickets.service.js';
import {
  type Channel,
  type CreateTicketInput,
  type QueueQuery,
  type TicketActor,
  type TicketRow,
  type TicketStatus,
  policyOf,
} from './tickets.types.js';
import { agentView } from './tickets.views.js';

type Deps = Pick<
  Cradle,
  'ticketsService' | 'ticketsRepository' | 'agentsService' | 'topicsService' | 'authDirectory'
>;

const APP_OF_TYPE: Record<string, App> = {
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
  LOGISTICS_PARTNER: 'LOGISTICS',
  INTERNAL: 'WAREHOUSE',
};

const STATUS_TEXT: Partial<Record<TicketStatus, string>> = {
  WAITING_ON_REQUESTER: 'Waiting for your reply',
  RESOLVED: 'Marked as resolved. Did this solve your problem?',
  CLOSED: 'Ticket closed',
  OPEN: 'Ticket reopened',
};

/** Agent console: one priority queue for every app and channel. */
export class TicketsAdminService {
  constructor(private readonly deps: Deps) {}

  async queue(query: QueueQuery, me: string) {
    const rows = await this.deps.ticketsRepository.queue(query, me, query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(agentView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      limit: query.limit,
    };
  }

  stats(me: string) {
    return this.deps.ticketsRepository.stats(me);
  }

  async detail(id: string) {
    const t = await this.mustFind(id);
    return { ...agentView(t), events: await this.deps.ticketsRepository.events(id) };
  }

  /** Reply (TEXT), INTERNAL_NOTE or ACTION_CARD — same path as the WebSocket. */
  send(actor: TicketActor, id: string, input: SendInput) {
    return this.deps.ticketsService.addMessage(actor, id, input);
  }

  /** Take an unassigned ticket. Two agents racing → exactly one wins, the other gets 409. */
  async claim(actor: TicketActor, id: string) {
    const name = await this.agentName(actor.userId);
    const ticket = await this.run(actor, id, undefined, async (t, tx) => {
      if (!(await this.deps.ticketsRepository.claim(tx, id, actor.userId, name)))
        throw new ConflictError(
          t.assigneeId === null
            ? `Ticket ${t.ticketNo} is ${t.status}`
            : `Ticket ${t.ticketNo} is already assigned to ${t.assigneeName ?? 'another agent'}`,
          { details: { reason: 'ALREADY_ASSIGNED', assigneeId: t.assigneeId } },
        );
      return {
        loadDeltas: [[actor.userId, 1]],
        joins: [[actor.userId, 'AGENT']],
        messages: [joinedMessage(name)],
        events: [
          {
            type: 'ASSIGNEE',
            from: null,
            to: actor.userId,
            actorId: actor.userId,
            reason: 'claimed',
          },
        ],
        emit: (etx, u) =>
          t.status === u.status
            ? Promise.resolve()
            : emitSupportEvent(
                etx,
                SUPPORT_EVENTS.ticketStatusChanged,
                { ...refOf(u), from: t.status, to: u.status, actorId: actor.userId },
                actor.requestId ?? id,
              ),
      };
    });
    return agentView(ticket);
  }

  async assign(
    actor: TicketActor,
    id: string,
    assigneeId: string,
    reason: string | undefined,
    ifMatch?: number,
  ) {
    const name = await this.agentName(assigneeId);
    const ticket = await this.run(actor, id, ifMatch, (t) => {
      if (t.status === 'CLOSED') throw new ConflictError('Ticket is closed');
      if (t.assigneeId === assigneeId) throw new ConflictError(`Already assigned to ${name}`);
      const active = t.status !== 'RESOLVED';
      return Promise.resolve<ChangePlan>({
        patch: {
          assigneeId,
          assigneeName: name,
          ...(t.status === 'NEW' ? { status: 'OPEN' } : {}),
        },
        loadDeltas: active
          ? [
              [t.assigneeId, -1],
              [assigneeId, 1],
            ]
          : [],
        joins: [[assigneeId, 'AGENT']],
        messages: [joinedMessage(name)],
        events: [
          {
            type: 'ASSIGNEE',
            from: t.assigneeId,
            to: assigneeId,
            actorId: actor.userId,
            reason: reason ?? null,
          },
        ],
      });
    });
    return agentView(ticket);
  }

  /**
   * Escalate to another team (e.g. SUPPORT → VET), optionally to a named agent. Level + 1; the
   * requester sees the public note ("Escalated to Dr. K. Srinivas — he has your order …").
   */
  async escalate(
    actor: TicketActor,
    id: string,
    input: { team: Team; assigneeId?: string; reason: string; note?: string },
    ifMatch?: number,
  ) {
    const name = input.assigneeId === undefined ? null : await this.agentName(input.assigneeId);
    const me = await this.agentName(actor.userId);
    const ticket = await this.run(actor, id, ifMatch, (t, _tx, now) => {
      if (t.status === 'CLOSED' || t.status === 'RESOLVED')
        throw new ConflictError(`Ticket is ${t.status}`);
      const assigneeId = input.assigneeId ?? null;
      const changesAssignee = assigneeId !== null && assigneeId !== t.assigneeId;
      const level = t.escalationLevel + 1;
      return Promise.resolve<ChangePlan>({
        patch: {
          team: input.team,
          escalationLevel: level,
          ...(changesAssignee ? { assigneeId, assigneeName: name } : {}),
          ...(t.status === 'NEW' && assigneeId !== null ? { status: 'OPEN' } : {}),
          ...(t.firstRespondedAt === null ? { firstRespondedAt: now } : {}),
        },
        loadDeltas: changesAssignee
          ? [
              [t.assigneeId, -1],
              [assigneeId, 1],
            ]
          : [],
        joins: assigneeId === null ? [] : [[assigneeId, 'AGENT']],
        messages: [
          {
            senderId: actor.userId,
            senderRole: 'AGENT',
            senderName: me,
            kind: 'ESCALATION',
            body: input.note ?? `Escalated to ${name ?? `the ${input.team.toLowerCase()} team`}`,
            card: { team: input.team, level, to: name },
          },
        ],
        events: [
          {
            type: 'ESCALATION',
            from: t.team,
            to: input.team,
            actorId: actor.userId,
            reason: input.reason,
            meta: { assigneeId, level },
          },
        ],
        emit: (etx, u) =>
          emitSupportEvent(
            etx,
            SUPPORT_EVENTS.ticketEscalated,
            {
              ...refOf(u),
              team: input.team,
              level: u.escalationLevel,
              assigneeId: u.assigneeId,
              actorId: actor.userId,
            },
            actor.requestId ?? id,
          ),
      });
    });
    return agentView(ticket);
  }

  /** Manual priority: locks it against rules and recomputes the SLA deadlines from the original start. */
  async setPriority(
    actor: TicketActor,
    id: string,
    priority: Priority,
    reason: string,
    ifMatch?: number,
  ) {
    const pre = await this.mustFind(id);
    const { policy, calendar } = await this.deps.topicsService.policy(pre.app, priority);
    const { ticket } = await this.deps.ticketsService.change(
      actor,
      id,
      { ifMatch, cal: calendar },
      (t) => {
        if (t.status === 'CLOSED') throw new ConflictError('Ticket is closed');
        if (t.priority === priority) throw new ConflictError(`Priority is already ${priority}`);
        const deadlines = recomputeForPolicy(t, policy, calendar);
        return Promise.resolve<ChangePlan>({
          patch: {
            priority,
            priorityReason: 'set by agent',
            priorityLocked: true,
            slaPolicy: { ...policy },
            ...deadlines,
          },
          events: [
            { type: 'PRIORITY', from: t.priority, to: priority, actorId: actor.userId, reason },
            {
              type: 'SLA_RECOMPUTE',
              actorId: actor.userId,
              meta: {
                firstResponseDueAt: deadlines.firstResponseDueAt ?? t.firstResponseDueAt,
                resolveDueAt: deadlines.resolveDueAt,
              },
            },
          ],
        });
      },
    );
    return agentView(ticket);
  }

  /** Waiting on requester / resolve / close / reopen (state machine; SLA pause and resume). */
  async setStatus(
    actor: TicketActor,
    id: string,
    to: TicketStatus,
    reason: string | undefined,
    ifMatch?: number,
  ) {
    if (to === 'CLOSED' && reason === undefined)
      throw new ValidationError([
        { path: 'body.reason', message: 'is required to close a ticket' },
      ]);
    const pre = await this.mustFind(id);
    const cal = await this.deps.topicsService.calendarOf(policyOf(pre));
    const { ticket } = await this.deps.ticketsService.change(
      actor,
      id,
      { ifMatch, cal },
      (t, _tx, now) =>
        Promise.resolve<ChangePlan>({
          patch: transitionPatch(t, to, 'AGENT', policyOf(t), cal, now),
          loadDeltas: [[t.assigneeId, loadDelta(t.status, to)]],
          events: [
            { type: 'STATUS', from: t.status, to, actorId: actor.userId, reason: reason ?? null },
          ],
          messages: [systemMessage(STATUS_TEXT[to] ?? to)],
          emit: (etx, u) =>
            emitSupportEvent(
              etx,
              SUPPORT_EVENTS.ticketStatusChanged,
              { ...refOf(u), from: t.status, to, actorId: actor.userId },
              actor.requestId ?? id,
            ),
        }),
    );
    return agentView(ticket);
  }

  /** Phone / email / WhatsApp intake: the agent raises the ticket for a requester and owns it. */
  async intake(
    actor: TicketActor,
    input: CreateTicketInput & { requesterId: string; channel: Channel },
    idempotencyKey?: string,
  ) {
    const contact = await this.deps.authDirectory.contact(input.requesterId);
    const app = contact === null ? undefined : APP_OF_TYPE[contact.userType];
    if (contact === null || app === undefined)
      throw new ValidationError([
        { path: 'body.requesterId', message: 'is not a customer, vendor, driver or staff user' },
      ]);
    const name = await this.agentName(actor.userId);
    const ticketInput = omit(input, ['requesterId']); // resolved above into the requester context
    const { ticket, replayed } = await this.deps.ticketsService.create(
      {
        userId: contact.id,
        userType: contact.userType,
        app,
        requestId: actor.requestId,
        ip: actor.ip,
      },
      ticketInput,
      idempotencyKey === undefined ? undefined : `intake:${idempotencyKey}`.slice(0, 64),
      { agentId: actor.userId, agentName: name },
    );
    return { ticket: agentView(ticket), replayed };
  }

  attachmentUrl(actor: TicketActor, id: string, attachmentId: string) {
    return this.deps.ticketsService.attachmentUrl(
      { userId: actor.userId, agent: true },
      id,
      attachmentId,
    );
  }

  messages(
    actor: TicketActor,
    id: string,
    opts: { afterSeq?: number; beforeSeq?: number; limit: number },
  ) {
    return this.deps.ticketsService.messages({ userId: actor.userId, agent: true }, id, opts);
  }

  read(actor: TicketActor, id: string, seq: number) {
    return this.deps.ticketsService.markRead({ userId: actor.userId, agent: true }, id, seq);
  }

  /** Change pipeline with the ticket's own calendar (status / assignment changes). */
  private async run(
    actor: TicketActor,
    id: string,
    ifMatch: number | undefined,
    plan: Parameters<Cradle['ticketsService']['change']>[3],
  ): Promise<TicketRow> {
    const pre = await this.mustFind(id);
    const cal = await this.deps.topicsService.calendarOf(policyOf(pre));
    return (await this.deps.ticketsService.change(actor, id, { ifMatch, cal }, plan)).ticket;
  }

  private async agentName(userId: string): Promise<string> {
    const name = await this.deps.agentsService.displayName(userId);
    if (name === null) throw new ForbiddenError('Not an active support agent');
    return name;
  }

  private async mustFind(id: string): Promise<TicketRow> {
    const t = await this.deps.ticketsRepository.find(id);
    if (t === null) throw new NotFoundError('Ticket');
    return t;
  }
}
