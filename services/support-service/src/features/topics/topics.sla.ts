import { DateTime } from 'luxon';

/**
 * SLA business-time maths (pure; fully unit-tested). Every calculation runs in the calendar's
 * IANA zone (DST-safe: windows are built from local wall-clock times, not by adding minutes to
 * midnight) and returns UTC instants.
 *  - Non-working weekdays and holidays contribute no minutes.
 *  - A clock that starts outside working hours begins at the next opening.
 *  - `null` calendar = 24×7 wall-clock minutes.
 */
export interface BusinessCalendar {
  timezone: string;
  /** weekday 0–6 (Sunday = 0); several windows per day allowed. */
  weekly: readonly { weekday: number; startMinute: number; endMinute: number }[];
  /** Local dates `YYYY-MM-DD` with no working time. */
  holidays: ReadonlySet<string>;
}

type Instant = DateTime;

/** Safety bound: a calendar with (almost) no working time never loops forever. */
const MAX_DAYS = 800;
const MINUTE_MS = 60_000;

interface Window {
  start: Instant;
  end: Instant;
}

/** The working windows of one local day (empty on holidays / closed weekdays). */
function windowsOf(day: Instant, cal: BusinessCalendar): Window[] {
  if (cal.holidays.has(day.toISODate() ?? '')) return [];
  const weekday = day.weekday % 7; // luxon: Mon=1 … Sun=7 → Sun=0
  return cal.weekly
    .filter((w) => w.weekday === weekday && w.endMinute > w.startMinute)
    .map((w) => ({ start: atMinute(day, w.startMinute), end: atMinute(day, w.endMinute) }))
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

const atMinute = (day: Instant, minute: number): Instant =>
  minute >= 1440
    ? day.plus({ days: 1 }).startOf('day')
    : day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 });

const hasWorkingTime = (cal: BusinessCalendar): boolean =>
  cal.weekly.some((w) => w.endMinute > w.startMinute);

/** `start` + `minutes` of working time. */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  cal: BusinessCalendar | null,
): Date {
  if (minutes <= 0) return new Date(start);
  if (cal === null || !hasWorkingTime(cal)) return new Date(start.getTime() + minutes * MINUTE_MS);
  let cursor: Instant = DateTime.fromJSDate(start, { zone: cal.timezone });
  let remainingMs = minutes * MINUTE_MS;
  for (let i = 0; i < MAX_DAYS; i += 1) {
    for (const w of windowsOf(cursor.startOf('day'), cal)) {
      if (cursor >= w.end) continue;
      const from = cursor > w.start ? cursor : w.start;
      const available = w.end.toMillis() - from.toMillis();
      if (available >= remainingMs) return new Date(from.toMillis() + remainingMs);
      remainingMs -= available;
      cursor = w.end;
    }
    cursor = cursor.startOf('day').plus({ days: 1 });
  }
  return new Date(start.getTime() + minutes * MINUTE_MS); // degenerate calendar: wall clock
}

/** Working minutes between `from` and `to` (0 when to ≤ from). */
export function businessMinutesBetween(from: Date, to: Date, cal: BusinessCalendar | null): number {
  if (to <= from) return 0;
  if (cal === null || !hasWorkingTime(cal))
    return Math.floor((to.getTime() - from.getTime()) / MINUTE_MS);
  const end: Instant = DateTime.fromJSDate(to, { zone: cal.timezone });
  let cursor: Instant = DateTime.fromJSDate(from, { zone: cal.timezone });
  let totalMs = 0;
  for (let i = 0; i < MAX_DAYS && cursor < end; i += 1) {
    for (const w of windowsOf(cursor.startOf('day'), cal)) {
      const s = cursor > w.start ? cursor : w.start;
      const e = end < w.end ? end : w.end;
      if (e > s) totalMs += e.toMillis() - s.toMillis();
    }
    cursor = cursor.startOf('day').plus({ days: 1 });
  }
  return Math.floor(totalMs / MINUTE_MS);
}

/** The SLA policy a ticket runs under (snapshotted on the ticket). */
export interface SlaPolicySnapshot {
  calendarId: string | null;
  firstResponseMins: number;
  resolveMins: number;
  businessHoursOnly: boolean;
}

/** The SLA columns of a ticket that the clock functions read and write. */
export interface SlaState {
  slaStartedAt: Date;
  firstResponseDueAt: Date;
  firstRespondedAt: Date | null;
  resolveDueAt: Date;
  slaPausedAt: Date | null;
  pausedBizMins: number;
}

const calOf = (policy: SlaPolicySnapshot, cal: BusinessCalendar | null) =>
  policy.businessHoursOnly ? cal : null;

/** Clocks of a new ticket. */
export function startClocks(
  createdAt: Date,
  policy: SlaPolicySnapshot,
  cal: BusinessCalendar | null,
) {
  const c = calOf(policy, cal);
  return {
    slaStartedAt: createdAt,
    firstResponseDueAt: addBusinessMinutes(createdAt, policy.firstResponseMins, c),
    resolveDueAt: addBusinessMinutes(createdAt, policy.resolveMins, c),
    slaPausedAt: null,
    pausedBizMins: 0,
  };
}

/** WAITING_ON_REQUESTER: the resolve clock stops (first response never pauses). */
export const pauseClock = (state: SlaState, now: Date) =>
  state.slaPausedAt === null ? { slaPausedAt: now } : {};

/** Back from waiting: the paused working minutes push the resolve deadline out. */
export function resumeClock(
  state: SlaState,
  policy: SlaPolicySnapshot,
  cal: BusinessCalendar | null,
  now: Date,
) {
  if (state.slaPausedAt === null) return {};
  const c = calOf(policy, cal);
  const pausedBizMins = state.pausedBizMins + businessMinutesBetween(state.slaPausedAt, now, c);
  return {
    slaPausedAt: null,
    pausedBizMins,
    resolveDueAt: addBusinessMinutes(state.slaStartedAt, policy.resolveMins + pausedBizMins, c),
  };
}

/**
 * New policy (priority change): deadlines are recomputed from the ORIGINAL start with the new
 * targets. A deadline already in the past is breached by the next sweep (never un-breached).
 */
export function recomputeForPolicy(
  state: SlaState & { createdAt: Date },
  policy: SlaPolicySnapshot,
  cal: BusinessCalendar | null,
): { firstResponseDueAt?: Date; resolveDueAt: Date } {
  const c = calOf(policy, cal);
  return {
    ...(state.firstRespondedAt === null
      ? { firstResponseDueAt: addBusinessMinutes(state.createdAt, policy.firstResponseMins, c) }
      : {}),
    resolveDueAt: addBusinessMinutes(
      state.slaStartedAt,
      policy.resolveMins + state.pausedBizMins,
      c,
    ),
  };
}

/** Reopen ("Not yet" or a reply after resolution): a fresh resolve cycle from now. */
export function restartResolveClock(
  policy: SlaPolicySnapshot,
  cal: BusinessCalendar | null,
  now: Date,
) {
  return {
    slaStartedAt: now,
    slaPausedAt: null,
    pausedBizMins: 0,
    resolveDueAt: addBusinessMinutes(now, policy.resolveMins, calOf(policy, cal)),
    resolveBreachedAt: null,
  };
}
