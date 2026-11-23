import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { CutoffType, DayHours } from './calendar.types.js';

const SHIFT = {
  id: true,
  warehouseId: true,
  name: true,
  startsAt: true,
  endsAt: true,
  overnight: true,
  breakStartsAt: true,
  breakEndsAt: true,
  isoDays: true,
  teamName: true,
  dockDoorIds: true,
  status: true,
  version: true,
} as const satisfies Prisma.WmsShiftSelect;

const HOLIDAY = {
  id: true,
  date: true,
  name: true,
  reason: true,
  mode: true,
  limitedFrom: true,
  limitedTo: true,
} as const satisfies Prisma.WmsHolidaySelect;

export type ShiftRow = Prisma.WmsShiftGetPayload<{ select: typeof SHIFT }>;
export type HolidayRow = Prisma.WmsHolidayGetPayload<{ select: typeof HOLIDAY }>;
export type ShiftWrite = Prisma.WmsShiftUncheckedUpdateInput;
export type HolidayWrite = Prisma.WmsHolidayUncheckedUpdateInput;

/** Only place that touches the calendar tables (hours, shifts, holidays, cut-offs). */
export class CalendarRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  hours(warehouseId: string): Promise<DayHours[]> {
    return withPrismaErrors(() =>
      this.db.wmsOperatingHours.findMany({
        where: { warehouseId },
        select: { isoDay: true, isOpen: true, opensAt: true, closesAt: true },
        orderBy: { isoDay: 'asc' },
      }),
    );
  }

  /** Replaces the weekly grid (all 7 days). */
  async putHours(tx: Tx, warehouseId: string, days: readonly DayHours[]): Promise<void> {
    await withPrismaErrors(async () => {
      await tx.wmsOperatingHours.deleteMany({ where: { warehouseId } });
      await tx.wmsOperatingHours.createMany({ data: days.map((d) => ({ warehouseId, ...d })) });
    });
  }

  async openDayCounts(warehouseIds: readonly string[], tx?: Tx): Promise<Map<string, number>> {
    if (warehouseIds.length === 0) return new Map();
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).wmsOperatingHours.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { in: [...warehouseIds] }, isOpen: true },
        _count: { _all: true },
      }),
    );
    return new Map(rows.map((r) => [r.warehouseId, r._count._all]));
  }

  shifts(warehouseId: string): Promise<ShiftRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsShift.findMany({
        where: { warehouseId },
        select: SHIFT,
        orderBy: { startsAt: 'asc' },
      }),
    );
  }

  async lockShift(tx: Tx, warehouseId: string, id: string): Promise<ShiftRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_shifts" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return withPrismaErrors(() =>
      tx.wmsShift.findFirst({ where: { id, warehouseId }, select: SHIFT }),
    );
  }

  findShift(warehouseId: string, id: string): Promise<ShiftRow | null> {
    return withPrismaErrors(() =>
      this.db.wmsShift.findFirst({ where: { id, warehouseId }, select: SHIFT }),
    );
  }

  shiftNameTaken(tx: Tx, warehouseId: string, name: string, exceptId?: string): Promise<boolean> {
    return withPrismaErrors(
      async () =>
        (await tx.wmsShift.count({
          where: {
            warehouseId,
            name: { equals: name, mode: 'insensitive' },
            ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
          },
        })) > 0,
    );
  }

  createShift(tx: Tx, data: Prisma.WmsShiftUncheckedCreateInput): Promise<ShiftRow> {
    return withPrismaErrors(() => tx.wmsShift.create({ data, select: SHIFT }));
  }

  updateShift(tx: Tx, id: string, data: ShiftWrite): Promise<ShiftRow> {
    return withPrismaErrors(() =>
      tx.wmsShift.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        select: SHIFT,
      }),
    );
  }

  async deleteShift(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsShift.delete({ where: { id } }));
  }

  /** Holidays from `from` (UTC date of the local day) onwards. */
  holidays(warehouseId: string, from: Date): Promise<HolidayRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsHoliday.findMany({
        where: { warehouseId, date: { gte: from } },
        select: HOLIDAY,
        orderBy: { date: 'asc' },
        take: 400,
      }),
    );
  }

  findHoliday(warehouseId: string, id: string, tx?: Tx): Promise<HolidayRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsHoliday.findFirst({ where: { id, warehouseId }, select: HOLIDAY }),
    );
  }

  holidayOn(tx: Tx, warehouseId: string, date: Date): Promise<HolidayRow | null> {
    return withPrismaErrors(() =>
      tx.wmsHoliday.findFirst({ where: { warehouseId, date }, select: HOLIDAY }),
    );
  }

  createHoliday(tx: Tx, data: Prisma.WmsHolidayUncheckedCreateInput): Promise<HolidayRow> {
    return withPrismaErrors(() => tx.wmsHoliday.create({ data, select: HOLIDAY }));
  }

  updateHoliday(tx: Tx, id: string, data: HolidayWrite): Promise<HolidayRow> {
    return withPrismaErrors(() => tx.wmsHoliday.update({ where: { id }, data, select: HOLIDAY }));
  }

  async deleteHoliday(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.wmsHoliday.delete({ where: { id } }));
  }

  cutoffs(warehouseId: string): Promise<{ type: CutoffType; cutoffTime: string }[]> {
    return withPrismaErrors(() =>
      this.db.wmsCutoff.findMany({
        where: { warehouseId },
        select: { type: true, cutoffTime: true },
      }),
    );
  }

  async putCutoffs(
    tx: Tx,
    warehouseId: string,
    cutoffs: readonly { type: CutoffType; cutoffTime: string | null }[],
  ): Promise<void> {
    await withPrismaErrors(async () => {
      for (const c of cutoffs) {
        if (c.cutoffTime === null)
          await tx.wmsCutoff.deleteMany({ where: { warehouseId, type: c.type } });
        else
          await tx.wmsCutoff.upsert({
            where: { warehouseId_type: { warehouseId, type: c.type } },
            create: { warehouseId, type: c.type, cutoffTime: c.cutoffTime },
            update: { cutoffTime: c.cutoffTime },
          });
      }
    });
  }
}
