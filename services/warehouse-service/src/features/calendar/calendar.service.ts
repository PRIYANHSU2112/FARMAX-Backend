import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { localDate, localIsoDay } from '../../middleware/time.js';
import type { Actor, AuditEntry } from '../audit/index.js';
import type { HolidayRow, ShiftRow } from './calendar.repository.js';
import { minutes, shiftProblems } from './calendar.rules.js';
import {
  CUTOFF_TYPES,
  type CalendarView,
  type CutoffType,
  type DayHours,
  type HolidayInput,
  type HolidayView,
  type ShiftInput,
  type ShiftUpdate,
  type ShiftView,
} from './calendar.types.js';

const actorOf = (c: Caller): Actor => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
/** A local date "YYYY-MM-DD" as the UTC midnight Prisma stores in a DATE column. */
const asDbDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const fromDbDate = (d: Date) => d.toISOString().slice(0, 10);

const shiftView = (s: ShiftRow): ShiftView => ({
  id: s.id,
  name: s.name,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  overnight: s.overnight,
  breakStartsAt: s.breakStartsAt,
  breakEndsAt: s.breakEndsAt,
  isoDays: [...s.isoDays].sort(),
  teamName: s.teamName,
  dockDoorIds: s.dockDoorIds,
  status: s.status,
  version: s.version,
});

const holidayView = (h: HolidayRow): HolidayView => ({
  id: h.id,
  date: fromDbDate(h.date),
  name: h.name,
  reason: h.reason,
  mode: h.mode,
  limitedFrom: h.limitedFrom,
  limitedTo: h.limitedTo,
});

const assertHoliday = (h: Pick<HolidayInput, 'mode' | 'limitedFrom' | 'limitedTo'>) => {
  if (h.mode === 'LIMITED') {
    if (
      h.limitedFrom == null ||
      h.limitedTo == null ||
      minutes(h.limitedFrom) >= minutes(h.limitedTo)
    )
      throw new ValidationError([
        { path: 'body.limitedTo', message: 'limited hours need a start before the end' },
      ]);
  }
};

/**
 * Operating calendar (W2.09, D-56): weekly hours, shifts, holidays and order cut-off times, all
 * in the warehouse timezone. Order routing (W3) will read the cut-offs; the activation checklist
 * needs at least one open weekday.
 */
export class CalendarService {
  private readonly repo: Cradle['calendarRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly lazy: Pick<Cradle, 'warehousesService' | 'docksService'>;

  constructor(
    deps: Pick<
      Cradle,
      | 'calendarRepository'
      | 'runInTransaction'
      | 'auditService'
      | 'warehousesService'
      | 'docksService'
    >,
  ) {
    this.repo = deps.calendarRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.lazy = deps;
  }

  async get(caller: Caller, warehouseId: string): Promise<CalendarView> {
    const w = await this.visible(caller, warehouseId, 'warehouse.view');
    const now = new Date();
    const today = localDate(now, w.timezone);
    const isoDay = localIsoDay(now, w.timezone);
    const [hoursRows, shiftRows, holidayRows, cutoffRows] = await Promise.all([
      this.repo.hours(warehouseId),
      this.repo.shifts(warehouseId),
      this.repo.holidays(warehouseId, asDbDate(today)),
      this.repo.cutoffs(warehouseId),
    ]);
    const byDay = new Map(hoursRows.map((h) => [h.isoDay, h] as const));
    const operatingHours: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map(
      (d) => byDay.get(d) ?? { isoDay: d, isOpen: false, opensAt: null, closesAt: null },
    );
    const holidays = holidayRows.map(holidayView);
    const holiday = holidays.find((h) => h.date === today) ?? null;
    const base = operatingHours[isoDay - 1] ?? { isOpen: false, opensAt: null, closesAt: null };
    const todayHours =
      holiday === null
        ? base
        : holiday.mode === 'CLOSED'
          ? { isOpen: false, opensAt: null, closesAt: null }
          : { isOpen: true, opensAt: holiday.limitedFrom, closesAt: holiday.limitedTo };
    const shifts = shiftRows.map(shiftView);
    const todaysShifts = todayHours.isOpen
      ? shifts.filter((s) => s.status === 'ACTIVE' && s.isoDays.includes(isoDay))
      : [];
    const upcoming = holidays.filter((h) => h.date > today);
    const cutoffs = new Map(cutoffRows.map((c) => [c.type, c.cutoffTime] as const));
    return {
      warehouseId,
      timezone: w.timezone,
      today: {
        date: today,
        isoDay,
        isOpen: todayHours.isOpen,
        opensAt: todayHours.opensAt,
        closesAt: todayHours.closesAt,
        holiday,
        activeShifts: todaysShifts.length,
        shiftNames: todaysShifts.map((s) => s.name),
      },
      operatingHours,
      cutoffs: CUTOFF_TYPES.map((type) => ({ type, cutoffTime: cutoffs.get(type) ?? null })),
      shifts,
      holidays,
      upcomingHolidays: { count: upcoming.length, next: upcoming[0] ?? null },
    };
  }

  /**
   * System view for SLA / dispatch planning (D-57b): weekly hours, the same-day standard cut-off
   * and fully closed days of the next 30 days. No caller (event handlers and jobs use it).
   */
  async slaCalendar(warehouseId: string) {
    const [hours, cutoffs, holidays] = await Promise.all([
      this.repo.hours(warehouseId),
      this.repo.cutoffs(warehouseId),
      this.repo.holidays(warehouseId, new Date(Date.now() - 86_400_000)),
    ]);
    const until = Date.now() + 30 * 86_400_000;
    return {
      hours: hours.map((h) => ({
        isoDay: h.isoDay,
        isOpen: h.isOpen,
        opensAt: h.opensAt,
        closesAt: h.closesAt,
      })),
      cutoff: cutoffs.find((c) => c.type === 'SAME_DAY_STANDARD')?.cutoffTime ?? null,
      cutoffs,
      closed: new Set(
        holidays
          .filter((h) => h.mode === 'CLOSED' && h.date.getTime() <= until)
          .map((h) => h.date.toISOString().slice(0, 10)),
      ),
    };
  }

  /** Weekdays marked open, per warehouse (setup checklist). */
  openDayCounts(warehouseIds: readonly string[], tx?: Tx): Promise<Map<string, number>> {
    return this.repo.openDayCounts(warehouseIds, tx);
  }

  /** The shift if it belongs to the warehouse (team profiles). */
  async requireShift(warehouseId: string, shiftId: string): Promise<ShiftView> {
    const s = await this.repo.findShift(warehouseId, shiftId);
    if (s === null) throw new ValidationError([{ path: 'body.shiftId', message: 'unknown shift' }]);
    return shiftView(s);
  }

  async putHours(caller: Caller, warehouseId: string, days: DayHours[]): Promise<CalendarView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const seen = new Set(days.map((d) => d.isoDay));
    if (seen.size !== 7)
      throw new ValidationError([{ path: 'body.days', message: 'give all 7 weekdays once each' }]);
    for (const d of days)
      if (
        d.isOpen &&
        (d.opensAt === null || d.closesAt === null || minutes(d.opensAt) >= minutes(d.closesAt))
      )
        throw new ValidationError([
          {
            path: `body.days[${String(d.isoDay)}]`,
            message: 'an open day needs opening before closing',
          },
        ]);
    const normalized = days.map((d) =>
      d.isOpen ? d : { isoDay: d.isoDay, isOpen: false, opensAt: null, closesAt: null },
    );
    await this.runInTransaction(async (tx) => {
      await this.repo.putHours(tx, warehouseId, normalized);
      await this.audit(tx, caller, {
        action: 'calendar.hours',
        targetType: 'calendar',
        targetId: warehouseId,
        after: { days: normalized },
      });
    });
    return this.get(caller, warehouseId);
  }

  async putCutoffs(
    caller: Caller,
    warehouseId: string,
    cutoffs: { type: CutoffType; cutoffTime: string | null }[],
  ): Promise<CalendarView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      await this.repo.putCutoffs(tx, warehouseId, cutoffs);
      await this.audit(tx, caller, {
        action: 'calendar.cutoffs',
        targetType: 'calendar',
        targetId: warehouseId,
        after: { cutoffs },
      });
    });
    return this.get(caller, warehouseId);
  }

  // ── Shifts ──

  async createShift(caller: Caller, warehouseId: string, input: ShiftInput): Promise<ShiftView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    this.assertShift(input);
    return this.runInTransaction(async (tx) => {
      await this.assertDocks(tx, warehouseId, input.dockDoorIds ?? []);
      if (await this.repo.shiftNameTaken(tx, warehouseId, input.name))
        throw new ConflictError(`A shift named ${input.name} exists`, {
          details: { reason: 'DUPLICATE_NAME' },
        });
      const s = await this.repo.createShift(tx, {
        warehouseId,
        name: input.name,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        overnight: input.overnight ?? false,
        breakStartsAt: input.breakStartsAt ?? null,
        breakEndsAt: input.breakEndsAt ?? null,
        isoDays: [...new Set(input.isoDays)],
        teamName: input.teamName ?? null,
        dockDoorIds: [...new Set(input.dockDoorIds ?? [])],
        status: input.status ?? 'ACTIVE',
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'shift.create',
        targetType: 'shift',
        targetId: s.id,
        after: s,
      });
      return shiftView(s);
    });
  }

  async updateShift(
    caller: Caller,
    warehouseId: string,
    shiftId: string,
    input: ShiftUpdate,
  ): Promise<ShiftView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    const { expectedVersion, ...changes } = input;
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.lockShift(tx, warehouseId, shiftId);
      if (before === null) throw new NotFoundError('Shift');
      if (before.version !== expectedVersion)
        throw new ConflictError('Changed by someone else; reload and retry', {
          details: { reason: 'VERSION_CONFLICT', currentVersion: before.version },
        });
      this.assertShift({ ...shiftView(before), ...changes });
      if (changes.dockDoorIds !== undefined)
        await this.assertDocks(tx, warehouseId, changes.dockDoorIds);
      if (
        changes.name !== undefined &&
        (await this.repo.shiftNameTaken(tx, warehouseId, changes.name, shiftId))
      )
        throw new ConflictError(`A shift named ${changes.name} exists`, {
          details: { reason: 'DUPLICATE_NAME' },
        });
      const after = await this.repo.updateShift(tx, shiftId, {
        ...changes,
        ...(changes.isoDays === undefined ? {} : { isoDays: [...new Set(changes.isoDays)] }),
        ...(changes.dockDoorIds === undefined
          ? {}
          : { dockDoorIds: [...new Set(changes.dockDoorIds)] }),
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'shift.update',
        targetType: 'shift',
        targetId: shiftId,
        before,
        after: changes,
      });
      return shiftView(after);
    });
  }

  async deleteShift(caller: Caller, warehouseId: string, shiftId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const before = await this.repo.lockShift(tx, warehouseId, shiftId);
      if (before === null) throw new NotFoundError('Shift');
      await this.repo.deleteShift(tx, shiftId);
      await this.audit(tx, caller, {
        action: 'shift.delete',
        targetType: 'shift',
        targetId: shiftId,
        before,
      });
    });
  }

  // ── Holidays ──

  async createHoliday(
    caller: Caller,
    warehouseId: string,
    input: HolidayInput,
  ): Promise<HolidayView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    assertHoliday(input);
    return this.runInTransaction(async (tx) => {
      if ((await this.repo.holidayOn(tx, warehouseId, asDbDate(input.date))) !== null)
        throw new ConflictError(`${input.date} already has a holiday`, {
          details: { reason: 'DUPLICATE_DATE' },
        });
      const h = await this.repo.createHoliday(tx, {
        warehouseId,
        date: asDbDate(input.date),
        name: input.name,
        reason: input.reason ?? null,
        mode: input.mode,
        limitedFrom: input.mode === 'LIMITED' ? (input.limitedFrom ?? null) : null,
        limitedTo: input.mode === 'LIMITED' ? (input.limitedTo ?? null) : null,
        createdByUserId: caller.userId,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'holiday.create',
        targetType: 'holiday',
        targetId: h.id,
        after: holidayView(h),
      });
      return holidayView(h);
    });
  }

  async updateHoliday(
    caller: Caller,
    warehouseId: string,
    holidayId: string,
    input: Partial<HolidayInput>,
  ): Promise<HolidayView> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    return this.runInTransaction(async (tx) => {
      const before = await this.repo.findHoliday(warehouseId, holidayId, tx);
      if (before === null) throw new NotFoundError('Holiday');
      const merged = { ...holidayView(before), ...input };
      assertHoliday(merged);
      if (input.date !== undefined && input.date !== fromDbDate(before.date)) {
        const clash = await this.repo.holidayOn(tx, warehouseId, asDbDate(input.date));
        if (clash !== null)
          throw new ConflictError(`${input.date} already has a holiday`, {
            details: { reason: 'DUPLICATE_DATE' },
          });
      }
      const after = await this.repo.updateHoliday(tx, holidayId, {
        date: asDbDate(merged.date),
        name: merged.name,
        reason: merged.reason,
        mode: merged.mode,
        limitedFrom: merged.mode === 'LIMITED' ? merged.limitedFrom : null,
        limitedTo: merged.mode === 'LIMITED' ? merged.limitedTo : null,
        updatedByUserId: caller.userId,
      });
      await this.audit(tx, caller, {
        action: 'holiday.update',
        targetType: 'holiday',
        targetId: holidayId,
        before: holidayView(before),
        after: holidayView(after),
      });
      return holidayView(after);
    });
  }

  async deleteHoliday(caller: Caller, warehouseId: string, holidayId: string): Promise<void> {
    await this.visible(caller, warehouseId, 'warehouse.configure');
    await this.runInTransaction(async (tx) => {
      const before = await this.repo.findHoliday(warehouseId, holidayId, tx);
      if (before === null) throw new NotFoundError('Holiday');
      await this.repo.deleteHoliday(tx, holidayId);
      await this.audit(tx, caller, {
        action: 'holiday.delete',
        targetType: 'holiday',
        targetId: holidayId,
        before: holidayView(before),
      });
    });
  }

  // ── Helpers ──

  private assertShift(s: Parameters<typeof shiftProblems>[0]): void {
    const problems = shiftProblems(s);
    if (problems.length > 0) throw new ValidationError(problems);
  }

  private async assertDocks(tx: Tx, warehouseId: string, ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const found = await this.lazy.docksService.existingDoorIds(warehouseId, unique, tx);
    if (found.length !== unique.length)
      throw new ValidationError([{ path: 'body.dockDoorIds', message: 'unknown dock door' }]);
  }

  private visible(caller: Caller, warehouseId: string, key: string) {
    return this.lazy.warehousesService.requireVisible(caller, warehouseId, key);
  }

  private audit(tx: Tx, caller: Caller, entry: AuditEntry): Promise<void> {
    return this.auditService.record(tx, actorOf(caller), entry);
  }
}
