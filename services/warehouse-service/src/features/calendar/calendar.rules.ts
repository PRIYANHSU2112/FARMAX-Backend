/** Pure calendar rules (no I/O; unit-tested). Times are "HH:mm" (24 h, warehouse timezone). */

export const minutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export interface ShiftTimes {
  startsAt: string;
  endsAt: string;
  overnight?: boolean;
  breakStartsAt?: string | null;
  breakEndsAt?: string | null;
}

/** Problems with a shift's times (empty = valid). */
export function shiftProblems(s: ShiftTimes): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const start = minutes(s.startsAt);
  let end = minutes(s.endsAt);
  if (s.overnight === true) {
    if (end >= start)
      out.push({
        path: 'body.endsAt',
        message: 'an overnight shift ends the next day (before it starts)',
      });
    end += 24 * 60;
  } else if (end <= start) {
    out.push({
      path: 'body.endsAt',
      message: 'must be after startsAt (or mark the shift overnight)',
    });
  }
  const hasStart = s.breakStartsAt != null;
  const hasEnd = s.breakEndsAt != null;
  if (hasStart !== hasEnd)
    out.push({ path: 'body.breakEndsAt', message: 'give both break start and end' });
  if (hasStart && hasEnd && out.length === 0) {
    let bs = minutes(s.breakStartsAt ?? '00:00');
    let be = minutes(s.breakEndsAt ?? '00:00');
    if (bs < start) bs += 24 * 60;
    if (be <= bs) be += 24 * 60;
    if (bs < start || be > end || be <= bs)
      out.push({ path: 'body.breakStartsAt', message: 'the break must fall inside the shift' });
  }
  return out;
}

/** Is the local time `now` ("HH:mm") inside [opensAt, closesAt)? */
export const isWithin = (now: string, opensAt: string | null, closesAt: string | null): boolean =>
  opensAt !== null &&
  closesAt !== null &&
  minutes(now) >= minutes(opensAt) &&
  minutes(now) < minutes(closesAt);
