import { type Tx, withPrismaErrors } from '@farmx/database';
import type { NotificationCategory } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { ExternalChannel } from '../templates/index.js';

export interface PreferenceRow {
  userId: string;
  channel: ExternalChannel;
  enabled: boolean;
}

/** Only place that touches `notification_preferences`. */
export class PreferencesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Explicit choices of these users for one category (PK prefix scan). */
  async findForUsers(
    userIds: readonly string[],
    category: NotificationCategory,
    tx?: Tx,
  ): Promise<PreferenceRow[]> {
    if (userIds.length === 0) return [];
    const db = tx ?? this.db;
    const rows = await withPrismaErrors(() =>
      db.notificationPreference.findMany({
        where: { userId: { in: [...userIds] }, category, channel: { not: 'IN_APP' } },
        select: { userId: true, channel: true, enabled: true },
      }),
    );
    return rows as PreferenceRow[];
  }

  /** All explicit choices of one user. */
  async findForUser(
    userId: string,
  ): Promise<(PreferenceRow & { category: NotificationCategory })[]> {
    const rows = await withPrismaErrors(() =>
      this.db.notificationPreference.findMany({
        where: { userId, channel: { not: 'IN_APP' } },
        select: { userId: true, category: true, channel: true, enabled: true },
      }),
    );
    return rows as (PreferenceRow & { category: NotificationCategory })[];
  }

  /** Upserts every change in ONE statement. */
  async upsert(
    userId: string,
    changes: readonly {
      category: NotificationCategory;
      channel: ExternalChannel;
      enabled: boolean;
    }[],
  ): Promise<void> {
    const categories = changes.map((c) => c.category);
    const channels = changes.map((c) => c.channel);
    const enabled = changes.map((c) => c.enabled);
    await withPrismaErrors(
      () => this.db.$executeRaw`
        INSERT INTO "notification_preferences" ("userId", "category", "channel", "enabled", "updatedAt")
        SELECT ${userId}::uuid, t.c::"NotificationCategory", t.ch::"NotificationChannel", t.e, now()
        FROM unnest(${categories}::text[], ${channels}::text[], ${enabled}::boolean[]) AS t(c, ch, e)
        ON CONFLICT ("userId", "category", "channel")
        DO UPDATE SET "enabled" = EXCLUDED."enabled", "updatedAt" = now()`,
    );
  }
}
