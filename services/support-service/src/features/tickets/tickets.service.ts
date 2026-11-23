import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import { type Tx, advisoryXactLock } from '@farmx/database';
import { SUPPORT_EVENTS } from '@farmx/infra/events';
import { userRoom } from '@farmx/infra/realtime';
import type { Cradle } from '@fastify/awilix';

import { emitSupportEvent } from '../../adapters/events.js';
import type { OrderSnapshot, UserContact, VerifiedUpload } from '../../adapters/upstreams.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { App } from '../../middleware/http.js';
import { type BusinessCalendar, startClocks } from '../topics/index.js';
import { isActive, loadDelta, transitionPatch } from './tickets.lifecycle.js';
import type { NewEvent, NewMessage } from './tickets.repository.js';
import {
  ACTIVE_STATUSES,
  type ActionCard,
  type CreateTicketInput,
  DONE_STATUSES,
  type MessageView,
  type TicketActor,
  type TicketListQuery,
  type TicketRow,
  policyOf,
} from './tickets.types.js';
import { messageFor, publicMessage, requesterView, ticketPulse } from './tickets.views.js';

/** Realtime rooms: one per ticket + the agents' queue room. */
export const ticketRoom = (id: string): string => `ticket:${id}`;
export const AGENTS_ROOM = 'agents';

/** Requester context of a request (customer / vendor / driver / warehouse staff). */
export interface RequesterCtx {
  userId: string;
  userType: string;
  app: App;
  requestId: string | null;
  ip: string | null;
}

/** What one change does to a locked ticket (all inside the same transaction). */
export interface ChangePlan {
  patch?: Record<string, unknown>;
  events?: NewEvent[];
  /** Appended in order AFTER the patch (system notes, escalation text, the agent's message …). */
  messages?: NewMessage[];
  loadDeltas?: [string | null, number][];
  joins?: [string, 'REQUESTER' | 'AGENT'][];
  /** Outbox writes, given the updated row and the stored messages. */
  emit?: (tx: Tx, t: TicketRow, messages: readonly MessageView[]) => Promise<void>;
}

export interface SendInput {
  clientMessageId: string;
  body: string;
  attachments?: string[];
  kind?: 'TEXT' | 'INTERNAL_NOTE' | 'ACTION_CARD';
  card?: ActionCard;
}

type Deps = Pick<
  Cradle,
  | 'ticketsRepository'
  | 'topicsService'
  | 'settingsService'
  | 'agentsService'
  | 'orderClient'
  | 'authDirectory'
  | 'mediaClient'
  | 'realtimeHub'
  | 'runInTransaction'
  | 'logger'
>;

export class TicketsService {
  constructor(private readonly deps: Deps) {}

  // ── Create ──

  /**
   * Raise a ticket. Everything remote (topic snapshot, order snapshot, contact, receipts, rule,
   * SLA, online agents) is resolved BEFORE the transaction; inside it: per-requester advisory lock
   * (open-ticket cap), sequence number, row inserts, least-loaded agent (SKIP LOCKED), outbox.
   * A retried `Idempotency-Key` returns the same ticket.
   */
  async create(
    r: RequesterCtx,
    input: CreateTicketInput,
    idempotencyKey?: string,
    intake?: { agentId: string; agentName: string },
  ): Promise<{ ticket: TicketRow; replayed: boolean }> {
    if (idempotencyKey !== undefined) {
      const existing = await this.deps.ticketsRepository.findByIdempotency(
        r.userId,
        idempotencyKey,
      );
      if (existing !== null) return { ticket: existing, replayed: true };
    }
    const topic = await this.deps.topicsService.activeTopic(r.app, input.topicCode);
    if (topic.requiresOrder && input.orderId === undefined)
      throw new ValidationError([
        { path: 'body.orderId', message: `is required for "${topic.label}"` },
      ]);
    const settings = await this.deps.settingsService.current();
    if ((input.attachments?.length ?? 0) > settings.limits.maxAttachmentsPerMessage)
      throw new ValidationError([
        {
          path: 'body.attachments',
          message: `at most ${String(settings.limits.maxAttachmentsPerMessage)} files`,
        },
      ]);
    const files = this.verifyFiles(
      input.attachments ?? [],
      intake?.agentId ?? r.userId,
      topic.allowsEvidence,
    );

    const [order, contact] = await Promise.all([
      input.orderId === undefined
        ? null
        : this.deps.orderClient.snapshotFor(input.orderId, r.userId),
      this.contactOf(r.userId, input.callbackRequested === true),
    ]);
    if (input.orderId !== undefined && order === null)
      throw new ValidationError([{ path: 'body.orderId', message: 'is not one of your orders' }]);
    if (input.callbackRequested === true && (contact?.phone ?? null) === null)
      throw new ValidationError([
        { path: 'body.callbackRequested', message: 'your account has no phone number' },
      ]);

    const decision = await this.deps.topicsService.decide(
      {
        app: r.app,
        topicCode: topic.code,
        requesterType: r.userType,
        text: input.description,
        orderAmount: order === null ? null : Number(order.grandTotal),
        temperatureClasses: order?.temperatureClasses ?? [],
      },
      topic,
    );
    const { policy, calendar } = await this.deps.topicsService.policy(r.app, decision.priority);
    const candidates =
      intake === undefined
        ? await this.deps.agentsService.onlineCandidates(decision.team, r.app)
        : [];
    const now = new Date();
    const id = uuidv7(now.getTime());
    const channel = input.channel ?? 'APP';

    let created: { ticket: TicketRow; messages: MessageView[] };
    try {
      created = await this.deps.runInTransaction(async (tx) => {
        await advisoryXactLock(tx, `support-open:${r.userId}`);
        if (
          (await this.deps.ticketsRepository.countActive(tx, r.userId)) >=
          settings.limits.maxOpenTicketsPerUser
        )
          throw new ConflictError('You have too many open tickets; reply on an existing one', {
            details: { reason: 'OPEN_TICKET_LIMIT', limit: settings.limits.maxOpenTicketsPerUser },
          });
        const ticketNo = await this.deps.ticketsRepository.nextTicketNo(tx, now);
        let assignee: { userId: string; displayName: string } | null;
        if (intake !== undefined) {
          assignee = { userId: intake.agentId, displayName: intake.agentName };
          await this.deps.agentsService.adjustLoad(tx, intake.agentId, 1);
        } else {
          assignee = await this.deps.agentsService.claimLeastLoaded(tx, candidates);
        }
        await this.deps.ticketsRepository.insertTicket(tx, {
          id,
          ticketNo,
          app: r.app,
          requesterId: r.userId,
          requesterType: r.userType,
          requesterName: contact?.fullName ?? null,
          topicId: topic.id,
          topicCode: topic.code,
          topicLabel: topic.label,
          description: input.description,
          priority: decision.priority,
          priorityReason: decision.reason,
          status: assignee === null ? 'NEW' : 'OPEN',
          team: decision.team,
          assigneeId: assignee?.userId ?? null,
          assigneeName: assignee?.displayName ?? null,
          channel,
          orderId: order?.orderId ?? null,
          ...(order === null ? {} : { orderContext: snapshotJson(order) }),
          callbackRequested: input.callbackRequested === true,
          callbackPhone: input.callbackRequested === true ? (contact?.phone ?? null) : null,
          slaPolicy: { ...policy },
          ...startClocks(now, policy, calendar),
          idempotencyKey: idempotencyKey ?? null,
          createdAt: now,
          lastMessageAt: now,
        });
        const attachments = await this.deps.ticketsRepository.insertAttachments(tx, id, files);
        const first = await this.deps.ticketsRepository.appendMessage(tx, id, {
          senderId: intake === undefined ? r.userId : intake.agentId,
          senderRole: intake === undefined ? 'REQUESTER' : 'AGENT',
          senderName: intake === undefined ? (contact?.fullName ?? null) : intake.agentName,
          kind: 'TEXT',
          body: input.description,
          attachmentIds: attachments.map((a) => a.id),
          attachmentViews: attachments,
          clientMessageId: `create:${id}`,
        });
        await this.deps.ticketsRepository.linkAttachments(
          tx,
          attachments.map((a) => a.id),
          first.id,
        );
        await this.deps.ticketsRepository.join(
          tx,
          id,
          r.userId,
          'REQUESTER',
          intake === undefined ? first.seq : 0,
        );
        const messages = [first];
        const events: NewEvent[] = [
          {
            type: 'CREATED',
            to: decision.priority,
            actorId: intake?.agentId ?? r.userId,
            meta: {
              ruleId: decision.ruleId,
              reason: decision.reason,
              team: decision.team,
              channel,
            },
          },
        ];
        if (assignee !== null) {
          messages.push(
            await this.deps.ticketsRepository.appendMessage(
              tx,
              id,
              joinedMessage(assignee.displayName),
            ),
          );
          await this.deps.ticketsRepository.join(tx, id, assignee.userId, 'AGENT');
          events.push({
            type: 'ASSIGNEE',
            to: assignee.userId,
            actorId: intake?.agentId ?? null,
            reason: intake === undefined ? 'auto-assign' : 'intake',
          });
        }
        await this.deps.ticketsRepository.addEvents(tx, id, events);
        const ticket = await this.mustLock(tx, id);
        await emitSupportEvent(
          tx,
          SUPPORT_EVENTS.ticketCreated,
          {
            ...refOf(ticket),
            topicCode: topic.code,
            priority: decision.priority,
            team: decision.team,
            channel,
            resolveDueAt: ticket.resolveDueAt.toISOString(),
          },
          r.requestId ?? id,
        );
        return { ticket, messages };
      });
    } catch (err) {
      if (idempotencyKey !== undefined) {
        const existing = await this.deps.ticketsRepository.findByIdempotency(
          r.userId,
          idempotencyKey,
        );
        if (existing !== null) return { ticket: existing, replayed: true };
      }
      throw err;
    }
    this.publish(created.ticket, created.messages);
    return { ticket: created.ticket, replayed: false };
  }

  // ── Requester reads ──

  async list(r: RequesterCtx, query: TicketListQuery) {
    const statuses = query.tab === 'open' ? ACTIVE_STATUSES : DONE_STATUSES;
    const [rows, counts] = await Promise.all([
      this.deps.ticketsRepository.listForRequester(
        r.userId,
        statuses,
        query.cursor,
        query.limit + 1,
      ),
      this.deps.ticketsRepository.countsForRequester(r.userId),
    ]);
    const page = rows.slice(0, query.limit);
    const unread = await this.deps.ticketsRepository.unreadCounts(
      page.map((t) => t.id),
      r.userId,
    );
    const sum = (list: readonly string[]) => list.reduce((n, s) => n + (counts[s] ?? 0), 0);
    return {
      items: page.map((t) => requesterView(t, unread.get(t.id) ?? 0)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      limit: query.limit,
      counts: { open: sum(ACTIVE_STATUSES), resolved: sum(DONE_STATUSES) },
    };
  }

  async detail(r: RequesterCtx, id: string) {
    const t = await this.accessible({ userId: r.userId, agent: false }, id);
    const unread = await this.deps.ticketsRepository.unreadCounts([id], r.userId);
    return requesterView(t, unread.get(id) ?? 0);
  }

  async messages(
    viewer: { userId: string; agent: boolean },
    id: string,
    opts: { afterSeq?: number; beforeSeq?: number; limit: number },
  ) {
    await this.accessible(viewer, id);
    const rows = await this.deps.ticketsRepository.messages(id, {
      ...opts,
      includeInternal: viewer.agent,
    });
    return rows.map((m) => messageFor(m, viewer.userId, viewer.agent));
  }

  /** Signed, 5-minute URL of one attachment (participants / agents only). */
  async attachmentUrl(
    viewer: { userId: string; agent: boolean },
    id: string,
    attachmentId: string,
  ) {
    await this.accessible(viewer, id);
    const file = await this.deps.ticketsRepository.attachmentKey(id, attachmentId);
    if (file === null) throw new NotFoundError('Attachment');
    const urls = await this.deps.mediaClient.signRead([file.mediaKey]);
    const url = urls[file.mediaKey];
    if (url === undefined || url === '') throw new NotFoundError('Attachment');
    return { url, expiresInSeconds: 300, mime: file.mime, fileName: file.fileName };
  }

  /** The ticket when the viewer may see it; anyone else's ticket is a 404 (no existence leak). */
  async accessible(viewer: { userId: string; agent: boolean }, id: string): Promise<TicketRow> {
    const t = await this.deps.ticketsRepository.find(id);
    if (t === null || (!viewer.agent && t.requesterId !== viewer.userId))
      throw new NotFoundError('Ticket');
    return t;
  }

  // ── Messages (REST and WebSocket share this path) ──

  /**
   * One message. Replays of the same `clientMessageId` return the stored message. A requester
   * reply wakes a waiting ticket / reopens a resolved one; an agent's first public reply claims an
   * unassigned ticket and stops the first-response clock. Internal notes reach agents only.
   */
  async addMessage(
    actor: TicketActor,
    ticketId: string,
    input: SendInput,
  ): Promise<{ message: ReturnType<typeof messageFor>; replayed: boolean }> {
    const isAgent = actor.role === 'AGENT';
    const replay = async () => {
      const existing = await this.deps.ticketsRepository.findByClientId(
        ticketId,
        actor.userId,
        input.clientMessageId,
      );
      return existing === null
        ? null
        : { message: messageFor(existing, actor.userId, isAgent), replayed: true };
    };
    const pre = await this.accessible({ userId: actor.userId, agent: isAgent }, ticketId);
    const early = await replay();
    if (early !== null) return early;
    if (pre.status === 'CLOSED') throw closedError(pre);

    const kind = isAgent ? (input.kind ?? 'TEXT') : 'TEXT';
    const isPublic = kind !== 'INTERNAL_NOTE';
    const settings = await this.deps.settingsService.current();
    if ((input.attachments?.length ?? 0) > settings.limits.maxAttachmentsPerMessage)
      throw new ValidationError([
        {
          path: 'body.attachments',
          message: `at most ${String(settings.limits.maxAttachmentsPerMessage)} files`,
        },
      ]);
    const topic = await this.deps.topicsService.topicById(pre.topicId);
    const files = this.verifyFiles(
      input.attachments ?? [],
      actor.userId,
      topic?.allowsEvidence ?? true,
    );
    const cal = await this.deps.topicsService.calendarOf(policyOf(pre));
    const agentName = isAgent
      ? (actor.name ?? (await this.deps.agentsService.displayName(actor.userId)) ?? 'Support')
      : null;

    try {
      const changed = await this.change(
        actor,
        ticketId,
        { requesterOnly: !isAgent, cal },
        async (t, tx, now) => {
          if (t.status === 'CLOSED') throw closedError(t);
          const patch: Record<string, unknown> = {};
          const events: NewEvent[] = [];
          const messages: NewMessage[] = [];
          const loadDeltas: [string | null, number][] = [];
          const joins: [string, 'REQUESTER' | 'AGENT'][] = [];
          if (!isAgent && (t.status === 'WAITING_ON_REQUESTER' || t.status === 'RESOLVED')) {
            Object.assign(
              patch,
              transitionPatch(t, 'OPEN', 'REQUESTER_MESSAGE', policyOf(t), cal, now),
            );
            loadDeltas.push([t.assigneeId, loadDelta(t.status, 'OPEN')]);
            events.push({
              type: 'STATUS',
              from: t.status,
              to: 'OPEN',
              actorId: actor.userId,
              reason: 'requester replied',
            });
          }
          if (isAgent && isPublic) {
            if (t.assigneeId === null) {
              Object.assign(patch, {
                assigneeId: actor.userId,
                assigneeName: agentName,
                ...(t.status === 'NEW' ? { status: 'OPEN' } : {}),
              });
              loadDeltas.push([actor.userId, 1]);
              messages.push(joinedMessage(agentName ?? 'Support'));
              events.push({
                type: 'ASSIGNEE',
                from: null,
                to: actor.userId,
                actorId: actor.userId,
                reason: 'first reply',
              });
            }
            if (t.firstRespondedAt === null) patch.firstRespondedAt = now;
          }
          if (isAgent) joins.push([actor.userId, 'AGENT']);
          const attachments = await this.deps.ticketsRepository.insertAttachments(
            tx,
            ticketId,
            files,
          );
          messages.push({
            senderId: actor.userId,
            senderRole: isAgent ? 'AGENT' : 'REQUESTER',
            senderName: isAgent ? agentName : t.requesterName,
            kind,
            body: input.body,
            attachmentIds: attachments.map((a) => a.id),
            attachmentViews: attachments,
            card: input.card ?? null,
            clientMessageId: input.clientMessageId,
          });
          return {
            patch,
            events,
            messages,
            loadDeltas,
            joins,
            emit: async (etx, updated, stored) => {
              const own = stored.at(-1);
              if (isAgent && isPublic && own !== undefined)
                await emitSupportEvent(
                  etx,
                  SUPPORT_EVENTS.ticketReplied,
                  { ...refOf(updated), messageId: own.id, seq: own.seq, agentId: actor.userId },
                  actor.requestId ?? ticketId,
                );
              if (updated.status !== t.status)
                await emitSupportEvent(
                  etx,
                  SUPPORT_EVENTS.ticketStatusChanged,
                  { ...refOf(updated), from: t.status, to: updated.status, actorId: actor.userId },
                  actor.requestId ?? ticketId,
                );
            },
          };
        },
      );
      const own = changed.messages.at(-1);
      if (own === undefined) throw new Error('addMessage: message not stored');
      return { message: messageFor(own, actor.userId, isAgent), replayed: false };
    } catch (err) {
      // A concurrent retry with the same clientMessageId won the unique index: return its message.
      const again = await replay();
      if (again !== null) return again;
      throw err;
    }
  }

  async markRead(viewer: { userId: string; agent: boolean }, ticketId: string, seq: number) {
    await this.accessible(viewer, ticketId);
    const role = viewer.agent ? 'AGENT' : 'REQUESTER';
    const lastReadSeq = await this.deps.ticketsRepository.markRead(
      ticketId,
      viewer.userId,
      role,
      seq,
    );
    this.deps.realtimeHub.publish(ticketRoom(ticketId), 'read', {
      ticketId,
      role,
      seq: lastReadSeq,
    });
    return { ticketId, lastReadSeq };
  }

  // ── Requester actions ──

  /** "Did this solve your problem?" Yes → CLOSED · Not yet → reopened (new resolve cycle). */
  async feedback(r: RequesterCtx, id: string, resolved: boolean, comment?: string) {
    const pre = await this.accessible({ userId: r.userId, agent: false }, id);
    const cal = await this.deps.topicsService.calendarOf(policyOf(pre));
    const { ticket } = await this.change(
      requesterActor(r),
      id,
      { requesterOnly: true, cal },
      (t, _tx, now) => {
        if (t.status !== 'RESOLVED')
          throw new ConflictError('Feedback is only possible on a resolved ticket', {
            details: { reason: 'NOT_RESOLVED' },
          });
        const to = resolved ? 'CLOSED' : 'OPEN';
        return Promise.resolve<ChangePlan>({
          patch: {
            ...transitionPatch(t, to, 'REQUESTER', policyOf(t), cal, now),
            csat: resolved ? 'YES' : 'NOT_YET',
            csatComment: comment ?? null,
          },
          loadDeltas: [[t.assigneeId, loadDelta(t.status, to)]],
          events: [
            {
              type: 'CSAT',
              to: resolved ? 'YES' : 'NOT_YET',
              actorId: r.userId,
              reason: comment ?? null,
            },
            { type: 'STATUS', from: t.status, to, actorId: r.userId },
          ],
          messages: [
            systemMessage(
              resolved
                ? 'Marked as solved by the customer'
                : 'Reopened: the problem is not solved yet',
            ),
          ],
          emit: (tx, u) =>
            emitSupportEvent(
              tx,
              SUPPORT_EVENTS.ticketStatusChanged,
              { ...refOf(u), from: t.status, to, actorId: r.userId },
              r.requestId ?? id,
            ),
        });
      },
    );
    return requesterView(ticket, 0);
  }

  /** Withdraw an open ticket. */
  async close(r: RequesterCtx, id: string, reason?: string) {
    const pre = await this.accessible({ userId: r.userId, agent: false }, id);
    const cal = await this.deps.topicsService.calendarOf(policyOf(pre));
    const { ticket } = await this.change(
      requesterActor(r),
      id,
      { requesterOnly: true, cal },
      (t, _tx, now) => {
        if (!isActive(t.status))
          throw new ConflictError(`Ticket is already ${t.status}`, {
            details: { reason: 'INVALID_TRANSITION' },
          });
        return Promise.resolve<ChangePlan>({
          patch: transitionPatch(t, 'CLOSED', 'REQUESTER', policyOf(t), cal, now),
          loadDeltas: [[t.assigneeId, loadDelta(t.status, 'CLOSED')]],
          events: [
            {
              type: 'STATUS',
              from: t.status,
              to: 'CLOSED',
              actorId: r.userId,
              reason: reason ?? 'withdrawn',
            },
          ],
          messages: [systemMessage('Closed by the customer')],
          emit: (tx, u) =>
            emitSupportEvent(
              tx,
              SUPPORT_EVENTS.ticketStatusChanged,
              { ...refOf(u), from: t.status, to: 'CLOSED', actorId: r.userId },
              r.requestId ?? id,
            ),
        });
      },
    );
    return requesterView(ticket, 0);
  }

  // ── The shared change pipeline ──

  /**
   * lock → (owner / version check) → plan → patch + version bump → agent load → messages (gap-free
   * seq) → participants → history → outbox: ONE transaction; realtime fan-out after commit.
   */
  async change(
    actor: TicketActor,
    ticketId: string,
    opts: { requesterOnly?: boolean; ifMatch?: number; cal: BusinessCalendar | null },
    plan: (t: TicketRow, tx: Tx, now: Date) => Promise<ChangePlan>,
  ): Promise<{ ticket: TicketRow; messages: MessageView[] }> {
    const result = await this.deps.runInTransaction(async (tx) => {
      const t = await this.deps.ticketsRepository.lock(tx, ticketId);
      if (t === null || (opts.requesterOnly === true && t.requesterId !== actor.userId))
        throw new NotFoundError('Ticket');
      if (opts.ifMatch !== undefined && opts.ifMatch !== t.version)
        throw new ConflictError('The ticket changed meanwhile; reload and retry', {
          details: { reason: 'STALE_VERSION', version: t.version },
        });
      const now = new Date();
      const p = await plan(t, tx, now);
      if (p.patch !== undefined && Object.keys(p.patch).length > 0)
        await this.deps.ticketsRepository.update(tx, ticketId, { ...p.patch, updatedAt: now });
      for (const [userId, delta] of p.loadDeltas ?? [])
        await this.deps.agentsService.adjustLoad(tx, userId, delta);
      const messages: MessageView[] = [];
      for (const m of p.messages ?? []) {
        const stored = await this.deps.ticketsRepository.appendMessage(tx, ticketId, m);
        if ((m.attachmentIds?.length ?? 0) > 0)
          await this.deps.ticketsRepository.linkAttachments(tx, m.attachmentIds ?? [], stored.id);
        messages.push(stored);
      }
      for (const [userId, role] of p.joins ?? [])
        await this.deps.ticketsRepository.join(tx, ticketId, userId, role);
      const last = messages.at(-1);
      if (last?.senderId === actor.userId)
        await this.deps.ticketsRepository.join(tx, ticketId, actor.userId, actor.role, last.seq);
      await this.deps.ticketsRepository.addEvents(tx, ticketId, p.events ?? []);
      const updated = await this.mustLock(tx, ticketId);
      await p.emit?.(tx, updated, messages);
      return { ticket: updated, messages };
    });
    this.publish(result.ticket, result.messages);
    return result;
  }

  /** Realtime fan-out (after commit; best effort — clients resync with afterSeq). */
  publish(t: TicketRow, messages: readonly MessageView[] = []): void {
    const hub = this.deps.realtimeHub;
    const room = ticketRoom(t.id);
    for (const m of messages) {
      if (m.visibility === 'INTERNAL') hub.publish(room, 'message.new', m, { audience: ['agent'] });
      else hub.publish(room, 'message.new', { ...publicMessage(m), visibility: 'PUBLIC' });
    }
    const pulse = ticketPulse(t);
    hub.publish(room, 'ticket.updated', pulse);
    hub.publish(userRoom(t.requesterId), 'ticket.updated', pulse);
    hub.publish(
      AGENTS_ROOM,
      'queue.updated',
      {
        ...pulse,
        app: t.app,
        assigneeId: t.assigneeId,
        requesterName: t.requesterName,
        topicLabel: t.topicLabel,
        firstRespondedAt: t.firstRespondedAt,
      },
      { audience: ['agent'] },
    );
  }

  // ── Helpers ──

  /** Re-reads a row this transaction already locked (or inserted). */
  private async mustLock(tx: Tx, id: string): Promise<TicketRow> {
    const t = await this.deps.ticketsRepository.lock(tx, id);
    if (t === null) throw new NotFoundError('Ticket');
    return t;
  }

  private verifyFiles(
    receipts: readonly string[],
    uploaderId: string,
    allowed: boolean,
  ): VerifiedUpload[] {
    if (receipts.length === 0) return [];
    if (!allowed)
      throw new ValidationError([
        { path: 'body.attachments', message: 'this topic does not accept files' },
      ]);
    return this.deps.mediaClient.verifyReceipts(receipts, uploaderId);
  }

  /** Contact is needed for a call-back (fail loudly); otherwise it is best effort. */
  private async contactOf(userId: string, required: boolean): Promise<UserContact | null> {
    try {
      return await this.deps.authDirectory.contact(userId);
    } catch (err) {
      if (required) throw err;
      this.deps.logger.warn(
        { err, userId },
        'auth directory unavailable; ticket without requester name',
      );
      return null;
    }
  }
}

// ── Message factories ──

export const systemMessage = (body: string): NewMessage => ({
  senderId: null,
  senderRole: 'SYSTEM',
  senderName: null,
  kind: 'SYSTEM',
  body,
});

export const joinedMessage = (name: string): NewMessage =>
  systemMessage(`${name} · Support joined`);

export const refOf = (t: TicketRow) => ({
  ticketId: t.id,
  ticketNo: t.ticketNo,
  app: t.app,
  requesterId: t.requesterId,
});

const closedError = (t: TicketRow) =>
  new ConflictError(`Ticket ${t.ticketNo} is closed; raise a new ticket`, {
    details: { reason: 'TICKET_CLOSED' },
  });

const requesterActor = (r: RequesterCtx): TicketActor => ({
  userId: r.userId,
  role: 'REQUESTER',
  name: null,
  requestId: r.requestId,
  ip: r.ip,
});

const snapshotJson = (o: OrderSnapshot) => ({
  orderNo: o.orderNo,
  status: o.status,
  placedAt: o.placedAt,
  grandTotal: o.grandTotal,
  paymentMethod: o.paymentMethod,
  itemCount: o.itemCount,
  firstItemName: o.firstItemName,
  temperatureClasses: o.temperatureClasses,
});
