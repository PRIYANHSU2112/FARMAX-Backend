import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { SettingKey } from './settings.types.js';

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

/** Only place that touches `inventory_settings`. */
export class SettingsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  all(): Promise<SettingRow[]> {
    return withPrismaErrors(() =>
      this.db.inventorySetting.findMany({ select: { key: true, value: true, updatedAt: true } }),
    );
  }

  /** Locks the rows so two concurrent PATCHes serialise (audit `before` stays exact). */
  async lockAll(tx: Tx): Promise<SettingRow[]> {
    return tx.$queryRaw<SettingRow[]>`
      SELECT "key", "value", "updatedAt" FROM "inventory_settings" ORDER BY "key" FOR UPDATE`;
  }

  /** D-57a: a non-business row (e.g. `stock.writesMode`), outside the strict settings set. */
  async raw(key: string, tx?: Tx): Promise<unknown> {
    const row = await (tx ?? this.db).inventorySetting.findUnique({
      where: { key },
      select: { value: true },
    });
    return row?.value ?? null;
  }

  async setRaw(tx: Tx, key: string, value: unknown, userId: string | null): Promise<void> {
    const json = value as Prisma.InputJsonValue;
    await tx.inventorySetting.upsert({
      where: { key },
      create: { key, value: json, updatedByUserId: userId },
      update: { value: json, updatedByUserId: userId },
    });
  }

  async upsert(tx: Tx, key: SettingKey, value: unknown, userId: string | null): Promise<void> {
    const json = value as boolean | number;
    await tx.inventorySetting.upsert({
      where: { key },
      create: { key, value: json, updatedByUserId: userId },
      update: { value: json, updatedByUserId: userId },
    });
  }
}
