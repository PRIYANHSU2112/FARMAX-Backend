import { withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { DeliveryStatus, NotificationChannel } from '../../domain.js';
import type {
  AdminDeliveryView,
  AdminListQuery,
  AdminNotificationView,
  Analytics,
  DeliveryListQuery,
} from './notifications.admin.types.js';
import type { DeliveryRef } from './notifications.deliveries.repository.js';

const viewSelect = {
  id: true,
  status: true,
  source: true,
  app: true,
  category: true,
  priority: true,
  audienceType: true,
  audience: true,
  channels: true,
  templateKey: true,
  templateVersion: true,
  title: true,
  body: true,
  data: true,
  entityType: true,
  entityId: true,
  sourceEventId: true,
  createdBy: true,
  reason: true,
  scheduledFor: true,
  expiresAt: true,
  recipientCount: true,
  cancelledAt: true,
  cancelledBy: true,
  createdAt: true,
} as const;

const deliverySelect = {
  id: true,
  notificationId: true,
  userId: true,
  channel: true,
  priority: true,
  status: true,
  attempts: true,
  skipReason: true,
  lastError: true,
  provider: true,
  providerMessageId: true,
  nextAttemptAt: true,
  sentAt: true,
  failedAt: true,
  createdAt: true,
  notification: { select: { title: true } },
} as const;

/** Staff reads / corrections over notifications + deliveries (same feature, own models). */
export class NotificationsAdminRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async findIdByDedupeKey(dedupeKey: string): Promise<string | null> {
    const row = await withPrismaErrors(() =>
      this.db.notification.findUnique({ where: { dedupeKey }, select: { id: true } }),
    );
    return row?.id ?? null;
  }

  /** Newest first, keyset on (createdAt, id). */
  async list(
    q: AdminListQuery,
  ): Promise<{ items: AdminNotificationView[]; nextCursor: string | null }> {
    const rows = await withPrismaErrors(() =>
      this.db.notification.findMany({
        where: {
          ...(q.status === undefined ? {} : { status: q.status }),
          ...(q.source === undefined ? {} : { source: q.source }),
          ...(q.app === undefined ? {} : { app: q.app }),
          ...(q.category === undefined ? {} : { category: q.category }),
          ...(q.templateKey === undefined ? {} : { templateKey: q.templateKey }),
          ...(q.entityType === undefined ? {} : { entityType: q.entityType }),
          ...(q.entityId === undefined ? {} : { entityId: q.entityId }),
          ...(q.from === undefined && q.to === undefined
            ? {}
            : {
                createdAt: {
                  ...(q.from === undefined ? {} : { gte: q.from }),
                  ...(q.to === undefined ? {} : { lt: q.to }),
                },
              }),
        },
        select: viewSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor === undefined ? {} : { skip: 1, cursor: { id: q.cursor } }),
      }),
    );
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async get(id: string): Promise<(AdminNotificationView & { content: unknown }) | null> {
    return withPrismaErrors(() =>
      this.db.notification.findUnique({
        where: { id },
        select: { ...viewSelect, content: true },
      }),
    );
  }

  async deliveryStats(notificationId: string) {
    const rows = await withPrismaErrors(() =>
      this.db.notificationDelivery.groupBy({
        by: ['channel', 'status'],
        where: { notificationId },
        _count: { _all: true },
      }),
    );
    const stats: Record<string, Partial<Record<DeliveryStatus, number>>> = {};
    for (const row of rows) (stats[row.channel] ??= {})[row.status] = row._count._all;
    return stats;
  }

  /** SCHEDULED / PROCESSING → CANCELLED. False when it already went out (or does not exist). */
  async cancel(id: string, by: string | null): Promise<boolean> {
    const { count } = await withPrismaErrors(() =>
      this.db.notification.updateMany({
        where: { id, status: { in: ['SCHEDULED', 'PROCESSING'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: by },
      }),
    );
    return count === 1;
  }

  async listDeliveries(
    q: DeliveryListQuery,
  ): Promise<{ items: AdminDeliveryView[]; nextCursor: string | null }> {
    const rows = await withPrismaErrors(() =>
      this.db.notificationDelivery.findMany({
        where: {
          ...(q.status === undefined ? {} : { status: q.status }),
          ...(q.channel === undefined ? {} : { channel: q.channel }),
          ...(q.notificationId === undefined ? {} : { notificationId: q.notificationId }),
          ...(q.userId === undefined ? {} : { userId: q.userId }),
        },
        select: deliverySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor === undefined ? {} : { skip: 1, cursor: { id: q.cursor } }),
      }),
    );
    const items = rows.slice(0, q.limit).map(({ notification, ...d }) => ({
      ...d,
      title: notification.title,
    }));
    return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async findDelivery(id: string): Promise<{ id: string; status: DeliveryStatus } | null> {
    return withPrismaErrors(() =>
      this.db.notificationDelivery.findUnique({
        where: { id },
        select: { id: true, status: true },
      }),
    );
  }

  /**
   * FAILED → PENDING with a fresh attempt budget (the error history stays in `lastError` and the
   * audit log). Only deliveries of notifications that are not cancelled / expired.
   */
  async requeueFailed(filter: {
    id?: string;
    notificationId?: string;
    channel?: NotificationChannel;
    limit: number;
  }): Promise<DeliveryRef[]> {
    return withPrismaErrors(
      () => this.db.$queryRaw<DeliveryRef[]>`
        UPDATE "notification_deliveries" d
        SET "status" = 'PENDING', "attempts" = 0, "nextAttemptAt" = now(), "failedAt" = NULL,
            "updatedAt" = now()
        WHERE d."id" IN (
          SELECT x."id" FROM "notification_deliveries" x
          JOIN "notifications" n ON n."id" = x."notificationId"
          WHERE x."status" = 'FAILED'
            AND n."status" NOT IN ('CANCELLED', 'EXPIRED')
            AND (n."expiresAt" IS NULL OR n."expiresAt" > now())
            AND (${filter.id ?? null}::uuid IS NULL OR x."id" = ${filter.id ?? null}::uuid)
            AND (${filter.notificationId ?? null}::uuid IS NULL
                 OR x."notificationId" = ${filter.notificationId ?? null}::uuid)
            AND (${filter.channel ?? null}::text IS NULL OR x."channel"::text = ${filter.channel ?? null})
          ORDER BY x."createdAt" LIMIT ${filter.limit} FOR UPDATE OF x SKIP LOCKED
        )
        RETURNING d."id", d."channel"::text AS "channel", d."priority"::text AS "priority", d."attempts"`,
    );
  }

  /** Created per category / source and delivery outcomes per channel in [from, to). */
  async analytics(from: Date, to: Date): Promise<Analytics> {
    const created = await withPrismaErrors(() =>
      this.db.notification.groupBy({
        by: ['category', 'source'],
        where: { createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
    );
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<
        {
          channel: NotificationChannel;
          status: DeliveryStatus;
          n: number;
          latency: number | null;
        }[]
      >`
        SELECT d."channel"::text AS "channel", d."status"::text AS "status", count(*)::int AS "n",
               avg(extract(epoch FROM d."sentAt" - n."createdAt"))
                 FILTER (WHERE d."status" = 'SENT')::float8 AS "latency"
        FROM "notification_deliveries" d JOIN "notifications" n ON n."id" = d."notificationId"
        WHERE d."createdAt" >= ${from} AND d."createdAt" < ${to}
        GROUP BY 1, 2`,
    );
    const byChannel = new Map<NotificationChannel, Analytics['deliveries'][number]>();
    for (const r of rows) {
      const c = byChannel.get(r.channel) ?? {
        channel: r.channel,
        sent: 0,
        failed: 0,
        skipped: 0,
        inFlight: 0,
        successRate: null,
        avgLatencySeconds: null,
      };
      if (r.status === 'SENT') {
        c.sent = r.n;
        c.avgLatencySeconds = r.latency === null ? null : Math.round(r.latency * 100) / 100;
      } else if (r.status === 'FAILED') c.failed = r.n;
      else if (r.status === 'SKIPPED') c.skipped = r.n;
      else c.inFlight += r.n;
      byChannel.set(r.channel, c);
    }
    for (const c of byChannel.values())
      c.successRate =
        c.sent + c.failed === 0
          ? null
          : Math.round((c.sent / (c.sent + c.failed)) * 10_000) / 10_000;
    return {
      from,
      to,
      notifications: created.map((r) => ({
        category: r.category,
        source: r.source,
        count: r._count._all,
      })),
      deliveries: [...byChannel.values()],
    };
  }
}
