import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { receiptProblem, verifyReceipt } from '../../src/adapters/media-client.js';
import { isWithin, shiftProblems } from '../../src/features/calendar/calendar.rules.js';
import { unloadingCapacity } from '../../src/features/docks/docks.service.js';
import { nextCodes } from '../../src/features/storage/storage.service.js';
import {
  ruleWarnings,
  type ZoneFacts,
} from '../../src/features/storage-rules/storage-rules.rules.js';

type Doors = Parameters<typeof unloadingCapacity>[0];
type Bookings = Parameters<typeof unloadingCapacity>[1];

describe('bin / rack auto codes', () => {
  it('continues after the highest number and ignores other prefixes', () => {
    expect(nextCodes('A', ['A-01', 'A-07', 'AB-09', 'A-X'], 2)).toEqual(['A-08', 'A-09']);
    expect(nextCodes('B-01', [], 3)).toEqual(['B-01-01', 'B-01-02', 'B-01-03']);
  });
});

describe('shift times', () => {
  it('accepts a day shift with a break inside', () => {
    expect(
      shiftProblems({
        startsAt: '06:00',
        endsAt: '14:00',
        breakStartsAt: '10:00',
        breakEndsAt: '10:30',
      }),
    ).toEqual([]);
  });

  it('accepts an overnight shift with a break after midnight', () => {
    expect(
      shiftProblems({
        startsAt: '22:00',
        endsAt: '06:00',
        overnight: true,
        breakStartsAt: '02:00',
        breakEndsAt: '02:30',
      }),
    ).toEqual([]);
  });

  it.each([
    [{ startsAt: '14:00', endsAt: '06:00' }, 'body.endsAt'],
    [{ startsAt: '06:00', endsAt: '14:00', overnight: true }, 'body.endsAt'],
    [
      { startsAt: '06:00', endsAt: '14:00', breakStartsAt: '15:00', breakEndsAt: '15:30' },
      'body.breakStartsAt',
    ],
    [{ startsAt: '06:00', endsAt: '14:00', breakStartsAt: '10:00' }, 'body.breakEndsAt'],
  ])('refuses %o', (shift, path) => {
    expect(shiftProblems(shift).map((p) => p.path)).toContain(path);
  });

  it('open hours are [opens, closes)', () => {
    expect(isWithin('06:00', '06:00', '22:00')).toBe(true);
    expect(isWithin('22:00', '06:00', '22:00')).toBe(false);
    expect(isWithin('10:00', null, null)).toBe(false);
  });
});

describe('dock unloading capacity', () => {
  const door = (unit: string, cap: number, type = 'UNLOADING', status = 'ACTIVE') => ({
    status,
    type,
    capacityUnit: unit,
    capacityPerDay: String(cap),
  });
  const booking = (unit: string, qty: number, status: string, direction = 'INBOUND') => ({
    direction,
    status,
    loadUnit: unit,
    loadQty: String(qty),
  });

  it('keeps tonnes and pallets apart and skips loading / inactive doors', () => {
    const doors = [
      door('TONNES', 120),
      door('TONNES', 120, 'BOTH'),
      door('TONNES', 500, 'LOADING'),
      door('TONNES', 80, 'UNLOADING', 'INACTIVE'),
      door('PALLETS', 60),
    ] as unknown as Doors;
    const bookings = [
      booking('TONNES', 30, 'DONE'),
      booking('TONNES', 20, 'IN_USE'),
      booking('TONNES', 50, 'PLANNED'),
      booking('TONNES', 99, 'CANCELLED'),
      booking('TONNES', 70, 'DONE', 'OUTBOUND'),
    ] as unknown as Bookings;
    expect(unloadingCapacity(doors, bookings)).toEqual([
      {
        unit: 'PALLETS',
        total: '60.00',
        planned: '0.00',
        used: '0.00',
        available: '60.00',
        usedPct: 0,
      },
      {
        unit: 'TONNES',
        total: '240.00',
        planned: '100.00',
        used: '50.00',
        available: '140.00',
        usedPct: 20.8,
      },
    ]);
  });
});

describe('storage rule warnings', () => {
  const zone = (over: Partial<ZoneFacts>): ZoneFacts => ({
    id: 'z1',
    code: 'A',
    status: 'ACTIVE',
    temperatureClass: 'AMB',
    isFoodGrade: false,
    productCategoryIds: [],
    ...over,
  });
  const rule = {
    type: 'SEGREGATION' as const,
    subjectCategoryIds: ['chem'],
    keepAwayCategoryIds: ['feed'],
    allowedZoneId: null,
    minDistanceM: 3,
  };

  it('flags a zone that holds both sides (0 m apart)', () => {
    const codes = ruleWarnings(rule, [zone({ productCategoryIds: ['chem', 'feed'] })], null).map(
      (w) => w.code,
    );
    expect(codes).toEqual(['SAME_ZONE_CONFLICT']);
  });

  it('checks the allowed zone and the catalog', () => {
    const food = {
      ...rule,
      type: 'FOOD_GRADE_ZONE' as const,
      keepAwayCategoryIds: [],
      allowedZoneId: 'z1',
    };
    expect(
      ruleWarnings(food, [zone({ status: 'INACTIVE' })], new Set(['chem'])).map((w) => w.code),
    ).toEqual(['ZONE_INACTIVE', 'ZONE_NOT_FOOD_GRADE']);
    expect(
      ruleWarnings({ ...food, allowedZoneId: 'gone' }, [], new Set()).map((w) => w.code),
    ).toEqual(['ZONE_MISSING', 'CATEGORY_UNKNOWN']);
  });
});

describe('staff document receipts', () => {
  const SECRET = 'unit-secret-0123456789abcdef0123456789';
  const sign = (payload: object) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
  };
  const good = {
    purpose: 'staff_document',
    key: 'staff/a.pdf',
    uploaderId: 'u1',
    kind: 'document',
    mime: 'application/pdf',
    size: 1000,
    fileName: 'a.pdf',
    scanStatus: 'CLEAN',
    exp: 2000,
  };

  it('accepts a fresh, own, clean staff document', () => {
    expect(receiptProblem(verifyReceipt(sign(good), SECRET), 'u1', 1000, true)).toBeNull();
  });

  it.each([
    ['tampered', `${sign(good)}x`, 'u1', 'not a valid'],
    ['other secret', sign(good).replace(/\.[^.]+$/, '.AAAA'), 'u1', 'not a valid'],
    ['expired', sign({ ...good, exp: 999 }), 'u1', 'expired'],
    ['support purpose', sign({ ...good, purpose: 'support' }), 'u1', 'staff document'],
    ['someone else', sign(good), 'u2', 'staff document'],
    ['too big', sign({ ...good, size: 11 * 1024 * 1024 }), 'u1', '10 MB'],
    ['unscanned', sign({ ...good, scanStatus: 'UNSCANNED' }), 'u1', 'virus'],
  ])('refuses %s', (_name, receipt, uploader, message) => {
    expect(receiptProblem(verifyReceipt(receipt, SECRET), uploader, 1000, true)).toContain(message);
  });
});
