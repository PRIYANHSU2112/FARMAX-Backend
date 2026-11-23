import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { CategoryRow, CurrentRow, DailyRow } from './stats.types.js';

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Only place that touches `warehouse_stock_current`, `_by_category` and `warehouse_daily_stats`. */
export class StatsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Replace the snapshot of the given warehouses (current + categories) in one transaction. */
  async replace(
    tx: Tx,
    ids: readonly string[],
    current: readonly CurrentRow[],
    categories: readonly CategoryRow[],
  ): Promise<void> {
    await withPrismaErrors(async () => {
      await tx.wmsStockCurrent.deleteMany({ where: { warehouseId: { in: [...ids] } } });
      await tx.wmsStockByCategory.deleteMany({ where: { warehouseId: { in: [...ids] } } });
      if (current.length > 0) await tx.wmsStockCurrent.createMany({ data: [...current] });
      if (categories.length > 0) await tx.wmsStockByCategory.createMany({ data: [...categories] });
    });
  }

  /** Today's row per warehouse; the last refresh of the day wins. */
  async upsertDaily(tx: Tx, rows: readonly DailyRow[]): Promise<void> {
    for (const r of rows) {
      const day = new Date(`${r.day}T00:00:00Z`);
      const data = {
        onHand: r.onHand,
        available: r.available,
        reserved: r.reserved,
        openOrders: r.openOrders,
      };
      await withPrismaErrors(() =>
        tx.wmsDailyStats.upsert({
          where: { warehouseId_day: { warehouseId: r.warehouseId, day } },
          create: { warehouseId: r.warehouseId, day, ...data },
          update: data,
        }),
      );
    }
  }

  async current(ids: readonly string[]): Promise<Map<string, CurrentRow>> {
    if (ids.length === 0) return new Map();
    const rows = await withPrismaErrors(() =>
      this.db.wmsStockCurrent.findMany({ where: { warehouseId: { in: [...ids] } } }),
    );
    return new Map(
      rows.map((r) => [
        r.warehouseId,
        { ...r, usedKg: r.usedKg.toFixed(2), weightKnownPct: r.weightKnownPct.toFixed(1) },
      ]),
    );
  }

  categories(warehouseId: string): Promise<CategoryRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsStockByCategory.findMany({ where: { warehouseId }, orderBy: { onHand: 'desc' } }),
    );
  }

  /** Rows of one warehouse on the given local days (YYYY-MM-DD). */
  async daily(warehouseId: string, days: readonly string[]): Promise<Map<string, DailyRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.wmsDailyStats.findMany({
        where: { warehouseId, day: { in: days.map((d) => new Date(`${d}T00:00:00Z`)) } },
      }),
    );
    return new Map(rows.map((r) => [ymd(r.day), { ...r, day: ymd(r.day) }]));
  }
}
