import { type Tx, withPrismaErrors } from '@farmx/database';
import type { NotificationStatus, Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { NotificationApp } from '../../domain.js';
import type {
  FanoutHeader,
  InboxItem,
  InboxQuery,
  NewNotification,
} from './notifications.types.js';

const headerSelect = {
  id: true,
  status: true,
  app: true,
  category: true,
  priority: true,
  channels: true,
  audienceType: true,
  audience: true,
  fanoutCursor: true,
  title: true,
  body: true,
  data: true,
  expiresAt: true,
  createdAt: true,
} as const;

/** Only place that touches notifications, notification_recipients and notification_deliveries. */
export class NotificationsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** INSERT … ON CONFLICT (dedupeKey) DO NOTHING: false = duplicate (the tx stays usable). */
  async insertNotification(tx: Tx, row: NewNotification): Promise<boolean> {
    const data: Prisma.NotificationCreateManyInput = {
      ...row,
      audience: row.audience as Prisma.InputJsonValue,
      content: row.content as Prisma.InputJsonValue,
    };
    const { count } = await withPrismaErrors(() =>
      tx.notification.createMany({ data: [data], skipDuplicates: true }),
    );
    return count === 1;
  }

  async findHeader(id: string): Promise<FanoutHeader | null> {
    return withPrismaErrors(() =>
      this.db.notification.findUnique({ where: { id }, select: headerSelect }),
    );
  }

  /** Row lock: one fan-out page at a time per notification (replicas, retries). */
  async lockHeader(tx: Tx, id: string): Promise<FanoutHeader | null> {
    await tx.$executeRaw`SELECT 1 FROM "notifications" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.notification.findUnique({ where: { id }, select: headerSelect });
  }

  async existingRecipientIds(
    tx: Tx,
    notificationId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await tx.notificationRecipient.findMany({
      where: { notificationId, userId: { in: [...userIds] } },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * Users (of `userIds`) who already received at least `cap` CONTENT notifications since `since`
   * (inbox rows; one grouped query per fan-out page).
   */
  async contentCapReached(
    tx: Tx,
    userIds: readonly string[],
    since: Date,
    cap: number,
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await tx.notificationRecipient.groupBy({
      by: ['userId'],
      where: { userId: { in: [...userIds] }, category: 'CONTENT', createdAt: { gte: since } },
      _count: { _all: true },
    });
    return new Set(rows.filter((r) => r._count._all >= cap).map((r) => r.userId));
  }

  async insertRecipients(
    tx: Tx,
    rows: Prisma.NotificationRecipientCreateManyInput[],
  ): Promise<void> {
    if (rows.length > 0) await tx.notificationRecipient.createMany({ data: rows });
  }

  async insertDeliveries(
    tx: Tx,
    rows: Prisma.NotificationDeliveryCreateManyInput[],
  ): Promise<void> {
    if (rows.length > 0) await tx.notificationDelivery.createMany({ data: rows });
  }

  async advance(
    tx: Tx,
    id: string,
    patch: { added: number; status?: NotificationStatus; fanoutCursor?: string | null },
  ): Promise<void> {
    await tx.notification.update({
      where: { id },
      data: {
        recipientCount: { increment: patch.added },
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.fanoutCursor === undefined ? {} : { fanoutCursor: patch.fanoutCursor }),
      },
      select: { id: true },
    });
  }

  async setStatus(id: string, from: NotificationStatus, to: NotificationStatus): Promise<void> {
    await withPrismaErrors(() =>
      this.db.notification.updateMany({ where: { id, status: from }, data: { status: to } }),
    );
  }

  /** PROCESSING notifications not advanced for `idleMs` (lost / exhausted fan-out jobs). */
  async findStalledFanouts(idleMs: number, limit: number): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.notification.findMany({
        where: { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - idleMs) } },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),
    );
    return rows.map((row) => row.id);
  }

  // ── Housekeeping jobs ───────────────────────────────────────────────────────────────────

  /** SCHEDULED and due → PROCESSING (the fan-out job takes over). SKIP LOCKED: replica-safe. */
  async releaseDue(limit: number): Promise<string[]> {
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<{ id: string }[]>`
        UPDATE "notifications" SET "status" = 'PROCESSING', "updatedAt" = now()
        WHERE "id" IN (
          SELECT "id" FROM "notifications"
          WHERE "status" = 'SCHEDULED' AND "scheduledFor" <= now()
          ORDER BY "scheduledFor" LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING "id"`,
    );
    return rows.map((row) => row.id);
  }

  /**
   * SCHEDULED / PROCESSING past `expiresAt`, or PROCESSING with no progress for `stuckMs`
   * (audience never resolvable) → EXPIRED. Returns the number of rows.
   */
  async expireDue(stuckMs: number): Promise<number> {
    const { count } = await withPrismaErrors(() =>
      this.db.notification.updateMany({
        where: {
          OR: [
            { status: { in: ['SCHEDULED', 'PROCESSING'] }, expiresAt: { lte: new Date() } },
            { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - stuckMs) } },
          ],
        },
        data: { status: 'EXPIRED' },
      }),
    );
    return count;
  }

  /** Deletes one batch of notifications created before `cutoff` (recipients + deliveries cascade). */
  async deleteBatchBefore(cutoff: Date, batch: number): Promise<number> {
    return withPrismaErrors(
      () => this.db.$executeRaw`
        DELETE FROM "notifications" WHERE "id" IN (
          SELECT "id" FROM "notifications" WHERE "createdAt" < ${cutoff}
          ORDER BY "createdAt" LIMIT ${batch}
        )`,
    );
  }

  // ── Inbox (the caller's own recipient rows) ─────────────────────────────────────────────

  /**
   * Newest first, keyset on (createdAt, id) with the notification id as cursor. One indexed range
   * scan on (userId, app, createdAt DESC, id DESC); expired entries are hidden.
   */
  async listInbox(
    userId: string,
    app: NotificationApp,
    query: InboxQuery,
  ): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
    const rows = await withPrismaErrors(() =>
      this.db.notificationRecipient.findMany({
        where: {
          ...visible(userId, app),
          ...(query.unread === true ? { readAt: null } : {}),
          ...(query.category === undefined ? {} : { category: query.category }),
        },
        select: inboxSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor === undefined
          ? {}
          : {
              skip: 1,
              cursor: { notificationId_userId: { notificationId: query.cursor, userId } },
            }),
      }),
    );
    const page = rows.slice(0, query.limit).map(toItem);
    return {
      items: page,
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async findInboxItem(
    userId: string,
    app: NotificationApp,
    notificationId: string,
  ): Promise<InboxItem | null> {
    const row = await withPrismaErrors(() =>
      this.db.notificationRecipient.findFirst({
        where: { ...visible(userId, app), notificationId },
        select: inboxSelect,
      }),
    );
    return row === null ? null : toItem(row);
  }

  /** Partial index (userId, app) WHERE readAt IS NULL. */
  countUnread(userId: string, app: NotificationApp): Promise<number> {
    return withPrismaErrors(() =>
      this.db.notificationRecipient.count({ where: { ...visible(userId, app), readAt: null } }),
    );
  }

  /** Idempotent: 0 when already read. Null when the user has no such entry. */
  async markRead(userId: string, app: NotificationApp, notificationId: string, at: Date) {
    const { count } = await withPrismaErrors(() =>
      this.db.notificationRecipient.updateMany({
        where: { ...visible(userId, app), notificationId, readAt: null },
        data: { readAt: at },
      }),
    );
    if (count > 0) return count;
    const exists = await this.db.notificationRecipient.count({
      where: { ...visible(userId, app), notificationId },
    });
    return exists === 0 ? null : 0;
  }

  /** Marks everything unread up to `before` (default now) as read. */
  async markAllRead(userId: string, app: NotificationApp, before: Date, at: Date): Promise<number> {
    const { count } = await withPrismaErrors(() =>
      this.db.notificationRecipient.updateMany({
        where: { ...visible(userId, app), readAt: null, createdAt: { lte: before } },
        data: { readAt: at },
      }),
    );
    return count;
  }
}

const inboxSelect = {
  readAt: true,
  createdAt: true,
  notification: {
    select: { id: true, category: true, priority: true, title: true, body: true, data: true },
  },
} as const;

/** Own rows of one app that have not expired. */
const visible = (userId: string, app: NotificationApp) =>
  ({
    userId,
    app,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  }) satisfies Prisma.NotificationRecipientWhereInput;

const toItem = (row: {
  readAt: Date | null;
  createdAt: Date;
  notification: Omit<InboxItem, 'read' | 'readAt' | 'createdAt'>;
}): InboxItem => ({
  ...row.notification,
  read: row.readAt !== null,
  readAt: row.readAt,
  createdAt: row.createdAt,
});
