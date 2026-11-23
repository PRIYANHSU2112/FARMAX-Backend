import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { CalendarInput, CalendarView, SettingKey, WeeklyWindow } from './settings.types.js';

const toDate = (d: Date) => d.toISOString().slice(0, 10);

/** Only place that touches `support_settings`, `support_calendars`, `support_holidays`. */
export class SettingsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  async allSettings(): Promise<
    { key: string; value: unknown; updatedByUserId: string | null; updatedAt: Date }[]
  > {
    return withPrismaErrors(() =>
      this.deps.db.supportSetting.findMany({ orderBy: { key: 'asc' } }),
    );
  }

  async findSettingForUpdate(tx: Tx, key: SettingKey): Promise<unknown> {
    const rows = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT "value" FROM "support_settings" WHERE "key" = ${key} FOR UPDATE`;
    return rows[0]?.value;
  }

  async upsertSetting(
    tx: Tx,
    key: SettingKey,
    value: object,
    userId: string | null,
  ): Promise<void> {
    await tx.supportSetting.upsert({
      where: { key },
      create: { key, value: value, updatedByUserId: userId },
      update: { value: value, updatedByUserId: userId },
    });
  }

  async calendars(): Promise<CalendarView[]> {
    const [cals, holidays] = await withPrismaErrors(() =>
      Promise.all([
        this.deps.db.supportCalendar.findMany({ orderBy: { name: 'asc' } }),
        this.deps.db.supportHoliday.findMany({ orderBy: { date: 'asc' } }),
      ]),
    );
    return cals.map((c) => ({
      id: c.id,
      name: c.name,
      timezone: c.timezone,
      weeklyHours: c.weeklyHours as unknown as WeeklyWindow[],
      isActive: c.isActive,
      updatedAt: c.updatedAt,
      holidays: holidays
        .filter((h) => h.calendarId === c.id)
        .map((h) => ({ id: h.id, date: toDate(h.date), name: h.name })),
    }));
  }

  async calendarExists(id: string): Promise<boolean> {
    return (await this.deps.db.supportCalendar.count({ where: { id } })) > 0;
  }

  async createCalendar(tx: Tx, input: CalendarInput): Promise<string> {
    const row = await withPrismaErrors(() =>
      tx.supportCalendar.create({
        data: {
          name: input.name,
          timezone: input.timezone,
          weeklyHours: input.weeklyHours as unknown as Prisma.InputJsonValue,
          isActive: input.isActive ?? true,
        },
        select: { id: true },
      }),
    );
    return row.id;
  }

  async updateCalendar(tx: Tx, id: string, input: Partial<CalendarInput>): Promise<boolean> {
    const res = await withPrismaErrors(() =>
      tx.supportCalendar.updateMany({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.weeklyHours === undefined
            ? {}
            : { weeklyHours: input.weeklyHours as unknown as Prisma.InputJsonValue }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
      }),
    );
    return res.count === 1;
  }

  async addHoliday(tx: Tx, calendarId: string, date: string, name: string): Promise<string> {
    const row = await withPrismaErrors(() =>
      tx.supportHoliday.create({
        data: { calendarId, date: new Date(`${date}T00:00:00Z`), name },
        select: { id: true },
      }),
    );
    return row.id;
  }

  async deleteHoliday(tx: Tx, calendarId: string, holidayId: string): Promise<boolean> {
    const res = await tx.supportHoliday.deleteMany({ where: { id: holidayId, calendarId } });
    return res.count === 1;
  }
}
