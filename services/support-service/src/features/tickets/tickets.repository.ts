import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { VerifiedUpload } from '../../adapters/upstreams.js';
import type {
  AttachmentView,
  MessageKind,
  MessageView,
  QueueQuery,
  SenderRole,
  TicketRow,
  TicketStatus,
} from './tickets.types.js';

const MESSAGE = {
  id: true, ticketId: true, seq: true, senderId: true, senderRole: true, senderName: true, kind: true,
  visibility: true, body: true, attachmentIds: true, card: true, clientMessageId: true, createdAt: true,
} as const;
type MessageRow = Prisma.SupportTicketMessageGetPayload<{ select: typeof MESSAGE }>;

const ATTACHMENT = { id: true, kind: true, mime: true, size: true, fileName: true } as const;

export interface NewMessage {
  senderId: string | null;
  senderRole: SenderRole;
  senderName: string | null;
  kind: MessageKind;
  body: string;
  attachmentIds?: string[];
  card?: object | null;
  clientMessageId?: string | null;
  /** Views of attachmentIds (not stored; used for the response / realtime payload). */
  attachmentViews?: AttachmentView[];
}

export interface NewEvent {
  type: string;
  from?: string | null;
  to?: string | null;
  actorId: string | null;
  reason?: string | null;
  meta?: object | null;
}

/** A ticket an SLA / auto-close sweep just changed (exactly once). */
export interface SweptTicket {
  id: string;
  ticketNo: string;
  app: string;
  requesterId: string;
  priority: string;
  team: string;
  assigneeId: string | null;
  dueAt: Date;
}

/** Only place that touches the support ticket tables. */
export class TicketsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  // ── Tickets ──

  async nextTicketNo(tx: Tx, now: Date): Promise<string> {
    const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('support_ticket_no_seq') AS n`;
    return `TK-${String(now.getUTCFullYear())}-${String(row?.n ?? 0).padStart(6, '0')}`;
  }

  async insertTicket(tx: Tx, data: Prisma.SupportTicketUncheckedCreateInput): Promise<TicketRow> {
    return (await withPrismaErrors(() => tx.supportTicket.create({ data }))) as TicketRow;
  }

  async find(id: string): Promise<TicketRow | null> {
    return (await withPrismaErrors(() => this.deps.db.supportTicket.findUnique({ where: { id } }))) as TicketRow | null;
  }

  async findByIdempotency(requesterId: string, key: string): Promise<TicketRow | null> {
    return (await this.deps.db.supportTicket.findUnique({
      where: { requesterId_idempotencyKey: { requesterId, idempotencyKey: key } },
    })) as TicketRow | null;
  }

  /** Row lock for the rest of the transaction (every state change goes through this). */
  async lock(tx: Tx, id: string): Promise<TicketRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "support_tickets" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    return (await tx.supportTicket.findUnique({ where: { id } })) as TicketRow | null;
  }

  async countActive(tx: Tx, requesterId: string): Promise<number> {
    return tx.supportTicket.count({
      where: { requesterId, status: { in: ['NEW', 'OPEN', 'WAITING_ON_REQUESTER'] } },
    });
  }

  /** Patch + version bump. With `expectedVersion`, a stale version updates nothing (→ false). */
  async update(tx: Tx, id: string, patch: Record<string, unknown>, expectedVersion?: number): Promise<boolean> {
    const res = await tx.supportTicket.updateMany({
      where: { id, ...(expectedVersion === undefined ? {} : { version: expectedVersion }) },
      data: { ...(patch as Prisma.SupportTicketUpdateManyMutationInput), version: { increment: 1 } },
    });
    return res.count === 1;
  }

  /** Conditional claim: only an unassigned, active ticket (the losing agent gets false). */
  async claim(tx: Tx, id: string, agentId: string, agentName: string): Promise<boolean> {
    const res = await tx.$executeRaw`
      UPDATE "support_tickets"
         SET "assigneeId" = ${agentId}::uuid, "assigneeName" = ${agentName},
             "status" = CASE WHEN "status" = 'NEW' THEN 'OPEN'::"SupportTicketStatus" ELSE "status" END,
             "version" = "version" + 1, "updatedAt" = now()
       WHERE "id" = ${id}::uuid AND "assigneeId" IS NULL
         AND "status" IN ('NEW', 'OPEN', 'WAITING_ON_REQUESTER')`;
    return res === 1;
  }

  // ── Lists ──

  async listForRequester(
    requesterId: string,
    statuses: readonly TicketStatus[],
    cursor: string | undefined,
    take: number,
  ): Promise<TicketRow[]> {
    return (await withPrismaErrors(() =>
      this.deps.db.supportTicket.findMany({
        where: { requesterId, status: { in: [...statuses] } },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      }),
    )) as TicketRow[];
  }

  async countsForRequester(requesterId: string): Promise<Record<string, number>> {
    const rows = await this.deps.db.supportTicket.groupBy({ by: ['status'], where: { requesterId }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  }

  async queue(query: QueueQuery, me: string, take: number): Promise<TicketRow[]> {
    const where: Prisma.SupportTicketWhereInput = {
      ...(query.status === undefined ? { status: { in: ['NEW', 'OPEN', 'WAITING_ON_REQUESTER'] } } : { status: { in: query.status } }),
      ...(query.priority === undefined ? {} : { priority: { in: query.priority } }),
      ...(query.app === undefined ? {} : { app: query.app }),
      ...(query.team === undefined ? {} : { team: query.team }),
      ...(query.assignee === undefined
        ? {}
        : query.assignee === 'unassigned'
          ? { assigneeId: null }
          : { assigneeId: query.assignee === 'me' ? me : query.assignee }),
      ...(query.breached === true
        ? { OR: [{ firstResponseBreachedAt: { not: null } }, { resolveBreachedAt: { not: null } }] }
        : {}),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { ticketNo: { equals: query.q.toUpperCase() } },
              { requesterName: { contains: query.q, mode: 'insensitive' } },
              { orderContext: { path: ['orderNo'], equals: query.q } },
            ],
          }),
    };
    const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] =
      query.sort === 'recent'
        ? [{ lastMessageAt: 'desc' }, { id: 'desc' }]
        : query.sort === 'oldest'
          ? [{ createdAt: 'asc' }, { id: 'asc' }]
          : [{ priority: 'asc' }, { resolveDueAt: 'asc' }, { id: 'asc' }];
    return (await withPrismaErrors(() =>
      this.deps.db.supportTicket.findMany({
        where,
        orderBy,
        take,
        ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      }),
    )) as TicketRow[];
  }

  async stats(me: string) {
    const active = { status: { in: ['NEW', 'OPEN', 'WAITING_ON_REQUESTER'] as TicketStatus[] } };
    const [byStatus, byPriority, unassigned, mine, breached] = await Promise.all([
      this.deps.db.supportTicket.groupBy({ by: ['status'], where: active, _count: { _all: true } }),
      this.deps.db.supportTicket.groupBy({ by: ['priority'], where: active, _count: { _all: true } }),
      this.deps.db.supportTicket.count({ where: { ...active, assigneeId: null } }),
      this.deps.db.supportTicket.count({ where: { ...active, assigneeId: me } }),
      this.deps.db.supportTicket.count({
        where: { ...active, OR: [{ firstResponseBreachedAt: { not: null } }, { resolveBreachedAt: { not: null } }] },
      }),
    ]);
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r._count._all])),
      unassigned,
      mine,
      breached,
    };
  }

  // ── Messages ──

  /**
   * Appends one message with the next gap-free `seq` of the ticket. The UPDATE takes the ticket
   * row lock (or reuses the caller's), so concurrent senders are serialised per ticket only.
   * Internal notes advance `lastSeq` but never the public preview / unread counter.
   */
  async appendMessage(tx: Tx, ticketId: string, msg: NewMessage): Promise<MessageView> {
    const isPublic = msg.kind !== 'INTERNAL_NOTE';
    const preview = previewOf(msg);
    const [row] = await tx.$queryRaw<{ seq: number }[]>`
      UPDATE "support_tickets" SET
        "lastSeq" = "lastSeq" + 1,
        "lastPublicSeq" = CASE WHEN ${isPublic} THEN "lastSeq" + 1 ELSE "lastPublicSeq" END,
        "lastMessageAt" = CASE WHEN ${isPublic} THEN now() ELSE "lastMessageAt" END,
        "lastMessagePreview" = CASE WHEN ${isPublic} THEN ${preview} ELSE "lastMessagePreview" END,
        "lastSenderRole" = CASE WHEN ${isPublic} THEN ${msg.senderRole}::"SupportSenderRole" ELSE "lastSenderRole" END,
        "updatedAt" = now()
      WHERE "id" = ${ticketId}::uuid
      RETURNING "lastSeq" AS seq`;
    if (row === undefined) throw new Error(`appendMessage: ticket ${ticketId} vanished`);
    const created = await tx.supportTicketMessage.create({
      data: {
        ticketId,
        seq: row.seq,
        senderId: msg.senderId,
        senderRole: msg.senderRole,
        senderName: msg.senderName,
        kind: msg.kind,
        visibility: isPublic ? 'PUBLIC' : 'INTERNAL',
        body: msg.body,
        attachmentIds: msg.attachmentIds ?? [],
        card: (msg.card ?? undefined) as Prisma.InputJsonValue | undefined,
        clientMessageId: msg.clientMessageId ?? null,
      },
      select: MESSAGE,
    });
    return toMessage(created, []);
  }

  async findByClientId(ticketId: string, senderId: string, clientMessageId: string): Promise<MessageView | null> {
    const row = await this.deps.db.supportTicketMessage.findUnique({
      where: { ticketId_senderId_clientMessageId: { ticketId, senderId, clientMessageId } },
      select: MESSAGE,
    });
    return row === null ? null : (await this.withAttachments([row]))[0] ?? null;
  }

  /** A page of messages: after `afterSeq` (ascending, resync) or the latest / before `beforeSeq`. */
  async messages(
    ticketId: string,
    opts: { afterSeq?: number; beforeSeq?: number; limit: number; includeInternal: boolean },
  ): Promise<MessageView[]> {
    const visibility = opts.includeInternal ? {} : { visibility: 'PUBLIC' as const };
    const rows =
      opts.afterSeq !== undefined
        ? await this.deps.db.supportTicketMessage.findMany({
            where: { ticketId, ...visibility, seq: { gt: opts.afterSeq } },
            orderBy: { seq: 'asc' },
            take: opts.limit,
            select: MESSAGE,
          })
        : (
            await this.deps.db.supportTicketMessage.findMany({
              where: { ticketId, ...visibility, ...(opts.beforeSeq === undefined ? {} : { seq: { lt: opts.beforeSeq } }) },
              orderBy: { seq: 'desc' },
              take: opts.limit,
              select: MESSAGE,
            })
          ).reverse();
    return this.withAttachments(rows);
  }

  private async withAttachments(rows: MessageRow[]): Promise<MessageView[]> {
    const ids = [...new Set(rows.flatMap((r) => r.attachmentIds))];
    const attachments =
      ids.length === 0
        ? []
        : await this.deps.db.supportAttachment.findMany({ where: { id: { in: ids } }, select: { ...ATTACHMENT } });
    const byId = new Map(attachments.map((a) => [a.id, a]));
    return rows.map((r) => toMessage(r, r.attachmentIds.flatMap((id) => byId.get(id) ?? [])));
  }

  // ── Attachments ──

  /** Binds verified uploads to the ticket. unique(mediaKey): one file can never serve two tickets. */
  async insertAttachments(tx: Tx, ticketId: string, files: readonly VerifiedUpload[]): Promise<AttachmentView[]> {
    const out: AttachmentView[] = [];
    for (const f of files) {
      out.push(
        await withPrismaErrors(() =>
          tx.supportAttachment.create({
            data: {
              ticketId,
              uploaderId: f.uploaderId,
              mediaKey: f.key,
              kind: f.kind,
              mime: f.mime,
              size: f.size,
              fileName: f.fileName,
              scanStatus: f.scanStatus,
            },
            select: ATTACHMENT,
          }),
        ),
      );
    }
    return out;
  }

  async linkAttachments(tx: Tx, ids: readonly string[], messageId: string): Promise<void> {
    if (ids.length > 0) await tx.supportAttachment.updateMany({ where: { id: { in: [...ids] } }, data: { messageId } });
  }

  async attachmentKey(ticketId: string, attachmentId: string): Promise<{ mediaKey: string; mime: string; fileName: string | null } | null> {
    return this.deps.db.supportAttachment.findFirst({
      where: { id: attachmentId, ticketId },
      select: { mediaKey: true, mime: true, fileName: true },
    });
  }

  // ── Participants ──

  async join(tx: Tx, ticketId: string, userId: string, role: 'REQUESTER' | 'AGENT', lastReadSeq = 0): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "support_ticket_participants" ("ticketId", "userId", "role", "lastReadSeq")
      VALUES (${ticketId}::uuid, ${userId}::uuid, ${role}, ${lastReadSeq})
      ON CONFLICT ("ticketId", "userId") DO UPDATE
        SET "lastReadSeq" = GREATEST("support_ticket_participants"."lastReadSeq", EXCLUDED."lastReadSeq")`;
  }

  /** Read receipt: monotonic (an older seq never moves it back), capped at the ticket's lastSeq. */
  async markRead(ticketId: string, userId: string, role: 'REQUESTER' | 'AGENT', seq: number): Promise<number> {
    const [row] = await this.deps.db.$queryRaw<{ lastReadSeq: number }[]>`
      INSERT INTO "support_ticket_participants" ("ticketId", "userId", "role", "lastReadSeq")
      SELECT t."id", ${userId}::uuid, ${role}, LEAST(${seq}, t."lastSeq") FROM "support_tickets" t WHERE t."id" = ${ticketId}::uuid
      ON CONFLICT ("ticketId", "userId") DO UPDATE
        SET "lastReadSeq" = GREATEST("support_ticket_participants"."lastReadSeq", EXCLUDED."lastReadSeq")
      RETURNING "lastReadSeq"`;
    return row?.lastReadSeq ?? 0;
  }

  async readSeqs(ticketIds: readonly string[], userId: string): Promise<Map<string, number>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.deps.db.supportTicketParticipant.findMany({
      where: { userId, ticketId: { in: [...ticketIds] } },
      select: { ticketId: true, lastReadSeq: true },
    });
    return new Map(rows.map((r) => [r.ticketId, r.lastReadSeq]));
  }

  // ── History ──

  async addEvents(tx: Tx, ticketId: string, events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    await tx.supportTicketEvent.createMany({
      data: events.map((e) => ({
        ticketId,
        type: e.type,
        from: e.from ?? null,
        to: e.to ?? null,
        actorId: e.actorId,
        reason: e.reason ?? null,
        meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });
  }

  events(ticketId: string) {
    return this.deps.db.supportTicketEvent.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  }

  // ── Sweeps (set-based, exactly once, SKIP LOCKED) ──

  async breachFirstResponse(tx: Tx, limit: number): Promise<SweptTicket[]> {
    return tx.$queryRaw<SweptTicket[]>`
      WITH due AS (
        SELECT "id" FROM "support_tickets"
         WHERE "firstRespondedAt" IS NULL AND "firstResponseBreachedAt" IS NULL
           AND "status" IN ('NEW', 'OPEN', 'WAITING_ON_REQUESTER') AND "firstResponseDueAt" <= now()
         ORDER BY "firstResponseDueAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "support_tickets" t SET "firstResponseBreachedAt" = now(), "updatedAt" = now()
        FROM due WHERE t."id" = due."id"
      RETURNING t."id", t."ticketNo", t."app"::text AS "app", t."requesterId", t."priority"::text AS "priority",
                t."team"::text AS "team", t."assigneeId", t."firstResponseDueAt" AS "dueAt"`;
  }

  async breachResolve(tx: Tx, limit: number): Promise<SweptTicket[]> {
    return tx.$queryRaw<SweptTicket[]>`
      WITH due AS (
        SELECT "id" FROM "support_tickets"
         WHERE "resolveBreachedAt" IS NULL AND "slaPausedAt" IS NULL
           AND "status" IN ('NEW', 'OPEN') AND "resolveDueAt" <= now()
         ORDER BY "resolveDueAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "support_tickets" t SET "resolveBreachedAt" = now(), "updatedAt" = now()
        FROM due WHERE t."id" = due."id"
      RETURNING t."id", t."ticketNo", t."app"::text AS "app", t."requesterId", t."priority"::text AS "priority",
                t."team"::text AS "team", t."assigneeId", t."resolveDueAt" AS "dueAt"`;
  }

  async autoClose(tx: Tx, olderThanHours: number, limit: number): Promise<SweptTicket[]> {
    return tx.$queryRaw<SweptTicket[]>`
      WITH due AS (
        SELECT "id" FROM "support_tickets"
         WHERE "status" = 'RESOLVED' AND "resolvedAt" <= now() - make_interval(hours => ${olderThanHours})
         ORDER BY "resolvedAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "support_tickets" t SET "status" = 'CLOSED', "closedAt" = now(), "version" = t."version" + 1, "updatedAt" = now()
        FROM due WHERE t."id" = due."id"
      RETURNING t."id", t."ticketNo", t."app"::text AS "app", t."requesterId", t."priority"::text AS "priority",
                t."team"::text AS "team", t."assigneeId", t."resolvedAt" AS "dueAt"`;
  }

  // ── Account deletion (DPDP) ──

  async attachmentKeysOf(uploaderId: string): Promise<string[]> {
    const rows = await this.deps.db.supportAttachment.findMany({ where: { uploaderId }, select: { mediaKey: true } });
    return rows.map((r) => r.mediaKey);
  }

  async activeTicketsOf(tx: Tx, requesterId: string): Promise<{ id: string; status: TicketStatus; assigneeId: string | null }[]> {
    return tx.supportTicket.findMany({
      where: { requesterId, status: { in: ['NEW', 'OPEN', 'WAITING_ON_REQUESTER'] } },
      select: { id: true, status: true, assigneeId: true },
    });
  }

  /** Scrubs the requester's personal text and files; ids, SLA facts and agent messages stay. */
  async scrubRequester(tx: Tx, requesterId: string): Promise<number> {
    await tx.supportTicketMessage.updateMany({
      where: { senderId: requesterId },
      data: { body: '[removed]', attachmentIds: [], clientMessageId: null },
    });
    await tx.supportAttachment.deleteMany({ where: { uploaderId: requesterId } });
    const res = await tx.supportTicket.updateMany({
      where: { requesterId, requesterScrubbedAt: null },
      data: {
        description: '[removed]',
        requesterName: null,
        callbackPhone: null,
        lastMessagePreview: null,
        requesterScrubbedAt: new Date(),
      },
    });
    await tx.$executeRaw`
      UPDATE "support_tickets" SET "status" = 'CLOSED', "closedAt" = now(), "version" = "version" + 1
       WHERE "requesterId" = ${requesterId}::uuid AND "status" IN ('NEW', 'OPEN', 'WAITING_ON_REQUESTER')`;
    return res.count;
  }
}

function previewOf(msg: NewMessage): string {
  const text = msg.body.replace(/\s+/g, ' ').trim();
  if (text !== '') return text.slice(0, 140);
  return (msg.attachmentIds?.length ?? 0) > 0 ? '[attachment]' : '';
}

const toMessage = (r: MessageRow, attachments: AttachmentView[]): MessageView => ({
  id: r.id,
  ticketId: r.ticketId,
  seq: r.seq,
  senderId: r.senderId,
  senderRole: r.senderRole,
  senderName: r.senderName,
  kind: r.kind,
  visibility: r.visibility,
  body: r.body,
  attachments,
  card: r.card ?? null,
  clientMessageId: r.clientMessageId,
  createdAt: r.createdAt,
});
