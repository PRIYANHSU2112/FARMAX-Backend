/**
 * Wall-clock helpers in a warehouse's IANA timezone (no library: Intl only). Calendars and dock
 * days are local ("today" in Asia/Kolkata), storage is UTC.
 */

const partsOf = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
  };
};

const ISO_DAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local calendar date "YYYY-MM-DD" of `date` in `timeZone`. */
export const localDate = (date: Date, timeZone: string): string => {
  const p = partsOf(date, timeZone);
  return `${String(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/** ISO weekday (1 = Monday … 7 = Sunday) of `date` in `timeZone`. */
export const localIsoDay = (date: Date, timeZone: string): number =>
  ISO_DAY[partsOf(date, timeZone).weekday] ?? 1;

/** Local wall time "HH:mm" of `date` in `timeZone`. */
export const localTime = (date: Date, timeZone: string): string => {
  const p = partsOf(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** The UTC instant of local midnight starting `ymd` in `timeZone`. */
export const localMidnight = (ymd: string, timeZone: string): Date => {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const p = partsOf(new Date(guess), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(guess - (wall - guess));
};

/** [start, end) of one local day as UTC instants. */
export const dayBounds = (ymd: string, timeZone: string): { from: Date; to: Date } => {
  const from = localMidnight(ymd, timeZone);
  return { from, to: new Date(from.getTime() + 24 * 3600 * 1000) };
};
