import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { Channel, TemplateRecord, TemplateRow, VariableDef } from './templates.types.js';

const rowSelect = {
  key: true,
  channel: true,
  locale: true,
  version: true,
  title: true,
  body: true,
  htmlBody: true,
  variables: true,
} as const;

const recordSelect = {
  ...rowSelect,
  id: true,
  description: true,
  isActive: true,
  createdBy: true,
  createdAt: true,
} as const;

const withDefs = <T extends { variables: unknown }>(row: T) => ({
  ...row,
  variables: row.variables as VariableDef[],
});

/** Only place that touches `notification_templates`. */
export class TemplatesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** ACTIVE versions of one key in one locale (≤ 1 per channel: partial unique index). */
  async findActive(key: string, locale: string): Promise<TemplateRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.notificationTemplate.findMany({
        where: { key, locale, isActive: true },
        select: rowSelect,
      }),
    );
    return rows.map(withDefs);
  }

  /** Every version (admin), newest first per family. Small table: no paging. */
  async list(filter: {
    key?: string;
    channel?: Channel;
    activeOnly?: boolean;
  }): Promise<TemplateRecord[]> {
    const rows = await withPrismaErrors(() =>
      this.db.notificationTemplate.findMany({
        where: {
          ...(filter.key === undefined ? {} : { key: filter.key }),
          ...(filter.channel === undefined ? {} : { channel: filter.channel }),
          ...(filter.activeOnly === true ? { isActive: true } : {}),
        },
        select: recordSelect,
        orderBy: [{ key: 'asc' }, { channel: 'asc' }, { locale: 'asc' }, { version: 'desc' }],
        take: 500,
      }),
    );
    return rows.map(withDefs);
  }

  async findById(id: string, tx?: Tx): Promise<TemplateRecord | null> {
    const db = tx ?? this.db;
    const row = await withPrismaErrors(() =>
      db.notificationTemplate.findUnique({ where: { id }, select: recordSelect }),
    );
    return row === null ? null : withDefs(row);
  }

  /**
   * Row-locks one (key, channel, locale) family for the rest of the transaction (concurrent new
   * versions get distinct numbers). Returns its highest version, 0 when the family is new.
   */
  async lockFamily(tx: Tx, key: string, channel: Channel, locale: string): Promise<number> {
    const rows = await tx.$queryRaw<{ version: number }[]>`
      SELECT "version" FROM "notification_templates"
      WHERE "key" = ${key} AND "channel" = ${channel}::"NotificationChannel" AND "locale" = ${locale}
      ORDER BY "version" DESC FOR UPDATE`;
    return rows[0]?.version ?? 0;
  }

  async insert(tx: Tx, row: Omit<TemplateRecord, 'createdAt'>): Promise<TemplateRecord> {
    const created = await tx.notificationTemplate.create({
      data: { ...row, variables: row.variables as unknown as Prisma.InputJsonValue },
      select: recordSelect,
    });
    return withDefs(created);
  }

  /** Makes `t` the only active version of its family (deactivate first: partial unique index). */
  async activate(
    tx: Tx,
    t: Pick<TemplateRecord, 'id' | 'key' | 'channel' | 'locale'>,
  ): Promise<void> {
    await tx.notificationTemplate.updateMany({
      where: {
        key: t.key,
        channel: t.channel,
        locale: t.locale,
        isActive: true,
        id: { not: t.id },
      },
      data: { isActive: false },
    });
    await tx.notificationTemplate.update({
      where: { id: t.id },
      data: { isActive: true },
      select: { id: true },
    });
  }
}
