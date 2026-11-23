import { describe, expect, it } from 'vitest';

import {
  type BusinessCalendar,
  type SlaPolicySnapshot,
  addBusinessMinutes,
  businessMinutesBetween,
  recomputeForPolicy,
  restartResolveClock,
  resumeClock,
  startClocks,
} from '../../src/features/topics/topics.sla.js';

/** Mon–Sat 09:00–21:00 IST, closed Sunday, 2026-12-25 holiday. IST = UTC+05:30 (no DST). */
const IST: BusinessCalendar = {
  timezone: 'Asia/Kolkata',
  weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1260 })),
  holidays: new Set(['2026-12-25']),
};
/** IST wall time → Date. */
const ist = (s: string) => new Date(`${s}+05:30`);

describe('addBusinessMinutes', () => {
  it('adds inside working hours', () => {
    expect(addBusinessMinutes(ist('2026-12-21T10:00:00'), 90, IST)).toEqual(
      ist('2026-12-21T11:30:00'),
    );
  });

  it('starts at the next opening when created before hours', () => {
    expect(addBusinessMinutes(ist('2026-12-21T06:00:00'), 60, IST)).toEqual(
      ist('2026-12-21T10:00:00'),
    );
  });

  it('rolls the remainder to the next working day', () => {
    // 20:30 + 60 min = 30 min today + 30 min tomorrow from 09:00.
    expect(addBusinessMinutes(ist('2026-12-21T20:30:00'), 60, IST)).toEqual(
      ist('2026-12-22T09:30:00'),
    );
  });

  it('skips the closed weekday (Sunday)', () => {
    // Saturday 2026-12-19 20:00 + 120 min → 60 Sat + Sunday closed + 60 Monday.
    expect(addBusinessMinutes(ist('2026-12-19T20:00:00'), 120, IST)).toEqual(
      ist('2026-12-21T10:00:00'),
    );
  });

  it('skips holidays', () => {
    // Thursday 24th 20:00 + 120 → 60 on 24th, 25th holiday, 60 on Saturday 26th.
    expect(addBusinessMinutes(ist('2026-12-24T20:00:00'), 120, IST)).toEqual(
      ist('2026-12-26T10:00:00'),
    );
  });

  it('supports split windows (lunch break)', () => {
    const split: BusinessCalendar = {
      timezone: 'Asia/Kolkata',
      weekly: [
        { weekday: 1, startMinute: 540, endMinute: 780 },
        { weekday: 1, startMinute: 840, endMinute: 1080 },
      ],
      holidays: new Set(),
    };
    // Monday 12:30 + 60 → 30 until 13:00, lunch, 30 from 14:00.
    expect(addBusinessMinutes(ist('2026-12-21T12:30:00'), 60, split)).toEqual(
      ist('2026-12-21T14:30:00'),
    );
  });

  it('is DST-safe (America/New_York, spring forward 2027-03-14)', () => {
    const ny: BusinessCalendar = {
      timezone: 'America/New_York',
      weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMinute: 540,
        endMinute: 1020,
      })),
      holidays: new Set(),
    };
    // Saturday 16:00 EST + 120 → 60 Saturday + 60 Sunday from 09:00 EDT (UTC-4).
    expect(addBusinessMinutes(new Date('2027-03-13T16:00:00-05:00'), 120, ny)).toEqual(
      new Date('2027-03-14T10:00:00-04:00'),
    );
  });

  it('uses wall-clock minutes without a calendar', () => {
    expect(addBusinessMinutes(ist('2026-12-20T23:00:00'), 120, null)).toEqual(
      ist('2026-12-21T01:00:00'),
    );
  });
});

describe('businessMinutesBetween', () => {
  it('counts only working time', () => {
    expect(
      businessMinutesBetween(ist('2026-12-21T20:00:00'), ist('2026-12-22T10:00:00'), IST),
    ).toBe(120);
    expect(
      businessMinutesBetween(ist('2026-12-19T20:00:00'), ist('2026-12-21T10:00:00'), IST),
    ).toBe(120);
    expect(
      businessMinutesBetween(ist('2026-12-21T22:00:00'), ist('2026-12-22T08:00:00'), IST),
    ).toBe(0);
  });

  it('is the inverse of addBusinessMinutes', () => {
    const from = ist('2026-12-18T15:17:00');
    const to = addBusinessMinutes(from, 1234, IST);
    expect(businessMinutesBetween(from, to, IST)).toBe(1234);
  });
});

describe('ticket clocks', () => {
  const policy: SlaPolicySnapshot = {
    calendarId: 'c',
    firstResponseMins: 60,
    resolveMins: 480,
    businessHoursOnly: true,
  };
  const created = ist('2026-12-21T10:00:00');

  it('starts both clocks from creation', () => {
    const c = startClocks(created, policy, IST);
    expect(c.firstResponseDueAt).toEqual(ist('2026-12-21T11:00:00'));
    expect(c.resolveDueAt).toEqual(ist('2026-12-21T18:00:00'));
  });

  it('a pause pushes the resolve deadline by the paused WORKING minutes', () => {
    const c = startClocks(created, policy, IST);
    // Paused Mon 12:00 → Tue 10:00 = 9 h Mon + 1 h Tue = 600 working minutes.
    const resumed = resumeClock(
      { ...c, firstRespondedAt: null, slaPausedAt: ist('2026-12-21T12:00:00') },
      policy,
      IST,
      ist('2026-12-22T10:00:00'),
    );
    expect(resumed.pausedBizMins).toBe(600);
    expect(resumed.resolveDueAt).toEqual(addBusinessMinutes(created, 480 + 600, IST));
    expect(resumed.slaPausedAt).toBeNull();
  });

  it('a priority change recomputes from the original start; a responded ticket keeps its first-response due', () => {
    const c = startClocks(created, policy, IST);
    const urgent: SlaPolicySnapshot = {
      calendarId: null,
      firstResponseMins: 15,
      resolveMins: 120,
      businessHoursOnly: false,
    };
    const open = recomputeForPolicy(
      { ...c, createdAt: created, firstRespondedAt: null },
      urgent,
      IST,
    );
    expect(open.firstResponseDueAt).toEqual(new Date(created.getTime() + 15 * 60_000));
    expect(open.resolveDueAt).toEqual(new Date(created.getTime() + 120 * 60_000));
    const answered = recomputeForPolicy(
      { ...c, createdAt: created, firstRespondedAt: created },
      urgent,
      IST,
    );
    expect(answered.firstResponseDueAt).toBeUndefined();
  });

  it('reopen starts a fresh resolve cycle and clears the breach', () => {
    const now = ist('2026-12-23T09:00:00');
    const r = restartResolveClock(policy, IST, now);
    expect(r.slaStartedAt).toEqual(now);
    expect(r.pausedBizMins).toBe(0);
    expect(r.resolveBreachedAt).toBeNull();
    expect(r.resolveDueAt).toEqual(ist('2026-12-23T17:00:00'));
  });
});
