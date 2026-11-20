import { withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { NotificationApp, NotificationPriority, NotificationStatus } from '../../domain.js';
import type { ChannelContent, ExternalChannel } from '../templates/index.js';

/** A delivery claimed by a worker (SENDING), with what it needs from its notification. */
export interface ClaimedDelivery {
  id: string;
  notificationId: string;
  userId: string;
  channel: ExternalChannel;
  priority: NotificationPriority;
  /** Including this one. */
  attempts: number;
  app: NotificationApp;
  notificationStatus: NotificationStatus;
  expiresAt: Date | null;
  content: ChannelContent;
  data: Record<string, unknown>;
  notificationCreatedAt: Date;
}

/** What the queues need to (re)enqueue a delivery. */
export interface DeliveryRef {
  id: string;
  channel: ExternalChannel;
  priority: NotificationPriority;
  attempts: number;
}

/**
 * Worker-side access to notification_deliveries (same feature as the notifications repository).
 * Every transition is a guarded single-statement UPDATE, so two workers / replicas can never both
 * send one delivery, and a late writer never overwrites a newer state.
 */
export class DeliveriesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** PENDING / RETRYING → SENDING (+1 attempt), atomically. Null = someone else has it / done. */
  async claim(id: string): Promise<ClaimedDelivery | null> {
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<ClaimedDelivery[]>`
        WITH c AS (
          UPDATE "notification_deliveries"
          SET "status" = 'SENDING', "lockedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
          WHERE "id" = ${id}::uuid AND "status" IN ('PENDING', 'RETRYING')
          RETURNING "id", "notificationId", "userId", "channel", "priority", "attempts"
        )
        SELECT c."id", c."notificationId", c."userId", c."channel"::text AS "channel",
               c."priority"::text AS "priority", c."attempts", n."app"::text AS "app",
               n."status"::text AS "notificationStatus", n."expiresAt", n."content", n."data",
               n."createdAt" AS "notificationCreatedAt"
        FROM c JOIN "notifications" n ON n."id" = c."notificationId"`,
    );
    return rows[0] ?? null;
  }

  async markSent(id: string, provider: string, providerMessageId: string | null): Promise<void> {
    await this.finish(id, {
      status: 'SENT',
      provider,
      providerMessageId,
      sentAt: new Date(),
      lastError: null,
    });
  }

  async markRetry(id: string, nextAttemptAt: Date, error: string, provider: string | null) {
    await this.finish(id, { status: 'RETRYING', nextAttemptAt, lastError: error, provider });
  }

  async markFailed(id: string, error: string, provider: string | null): Promise<void> {
    await this.finish(id, { status: 'FAILED', failedAt: new Date(), lastError: error, provider });
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.finish(id, { status: 'SKIPPED', skipReason: reason });
  }

  /** Only from SENDING (the claim): a stale worker can't overwrite a newer outcome. */
  private async finish(
    id: string,
    data: {
      status: 'SENT' | 'RETRYING' | 'FAILED' | 'SKIPPED';
      provider?: string | null;
      providerMessageId?: string | null;
      sentAt?: Date;
      failedAt?: Date;
      nextAttemptAt?: Date;
      lastError?: string | null;
      skipReason?: string;
    },
  ): Promise<void> {
    await withPrismaErrors(() =>
      this.db.notificationDelivery.updateMany({
        where: { id, status: 'SENDING' },
        data: {
          ...data,
          ...(data.lastError == null ? {} : { lastError: data.lastError.slice(0, 300) }),
          lockedAt: null,
        },
      }),
    );
  }

  /** PENDING / RETRYING overdue by `graceMs` (their queue job was lost). */
  async findOverdue(graceMs: number, limit: number): Promise<DeliveryRef[]> {
    return withPrismaErrors(() =>
      this.db.notificationDelivery.findMany({
        where: {
          status: { in: ['PENDING', 'RETRYING'] },
          nextAttemptAt: { lte: new Date(Date.now() - graceMs) },
        },
        select: { id: true, channel: true, priority: true, attempts: true },
        orderBy: { nextAttemptAt: 'asc' },
        take: limit,
      }),
    ) as Promise<DeliveryRef[]>;
  }

  /** SENDING longer than the lease (worker crashed mid-send) → RETRYING now. At-least-once. */
  async recoverStale(leaseMs: number, limit: number): Promise<DeliveryRef[]> {
    return withPrismaErrors(
      () => this.db.$queryRaw<DeliveryRef[]>`
        UPDATE "notification_deliveries"
        SET "status" = 'RETRYING', "nextAttemptAt" = now(), "lockedAt" = NULL, "updatedAt" = now(),
            "lastError" = 'worker lease expired'
        WHERE "id" IN (
          SELECT "id" FROM "notification_deliveries"
          WHERE "status" = 'SENDING' AND "lockedAt" < ${new Date(Date.now() - leaseMs)}
          ORDER BY "lockedAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "channel"::text AS "channel", "priority"::text AS "priority", "attempts"`,
    );
  }

  /** FAILED deliveries per channel (metrics gauge). */
  async countFailedByChannel(): Promise<Record<string, number>> {
    const rows = await withPrismaErrors(() =>
      this.db.notificationDelivery.groupBy({
        by: ['channel'],
        where: { status: 'FAILED' },
        _count: { _all: true },
      }),
    );
    return Object.fromEntries(rows.map((r) => [r.channel, r._count._all]));
  }
}
