import { describe, expect, it } from 'vitest';

import { checkAvailability, rankCandidates, scoreCandidate } from '../../src/features/experts/experts.rules.js';
import { checkProfile } from '../../src/features/experts/experts.service.js';
import { checkSetting, parseSettings } from '../../src/features/options/options.settings.js';

const rule = (weekday: number, startMinute: number, endMinute: number, extra: object = {}) => ({
  weekday,
  startMinute,
  endMinute,
  ...extra,
});

describe('checkAvailability', () => {
  const channels = ['VIDEO', 'PHONE'];

  it('accepts touching intervals and different weekdays', () => {
    expect(
      checkAvailability({ rules: [rule(1, 540, 780), rule(1, 780, 1080), rule(2, 540, 1080)], breaks: [] }, channels),
    ).toEqual([]);
  });

  it('rejects overlapping intervals on the same weekday', () => {
    const issues = checkAvailability({ rules: [rule(1, 540, 780), rule(1, 720, 900)], breaks: [] }, channels);
    expect(issues).toEqual([{ path: 'rules.1', message: 'overlaps rules.0 on the same weekday' }]);
  });

  it('allows the same hours when the date windows do not meet', () => {
    const rules = [
      rule(1, 540, 780, { validTo: '2026-12-31' }),
      rule(1, 540, 780, { validFrom: '2027-01-01' }),
    ];
    expect(checkAvailability({ rules, breaks: [] }, channels)).toEqual([]);
  });

  it('rejects inverted windows and channels the expert does not offer', () => {
    const issues = checkAvailability(
      { rules: [rule(1, 540, 780, { validFrom: '2027-02-01', validTo: '2027-01-01', channels: ['FARM_VISIT'] })], breaks: [] },
      channels,
    );
    expect(issues.map((i) => i.path)).toEqual(['rules.0.validTo', 'rules.0.channels']);
  });
});

describe('checkProfile', () => {
  const base = { type: 'SALES_REP' as const, isBookable: true, channels: ['VIDEO' as const], territoryCodes: [] };

  it('passes a normal bookable rep', () => {
    expect(() => { checkProfile(base); }).not.toThrow();
  });

  it('never lets a VET be bookable', () => {
    expect(() => { checkProfile({ ...base, type: 'VET' }); }).toThrow();
    expect(() => { checkProfile({ ...base, type: 'VET', isBookable: false }); }).not.toThrow();
  });

  it('needs a channel when bookable and a territory for farm visits', () => {
    expect(() => { checkProfile({ ...base, channels: [] }); }).toThrow();
    expect(() => { checkProfile({ ...base, channels: ['FARM_VISIT'] }); }).toThrow();
    expect(() => { checkProfile({ ...base, channels: ['FARM_VISIT'], territoryCodes: ['WG'] }); }).not.toThrow();
  });
});

describe('recommendation scoring', () => {
  const input = { brandId: 'b1', categoryPath: ['root', 'vaccines', 'nd'], productionTypes: ['LAYER'], language: 'hi' };
  const c = (id: string, o: Partial<Parameters<typeof scoreCandidate>[0]> = {}) => ({
    id,
    brandIds: [],
    categoryIds: [],
    productionTypes: [],
    languages: [],
    ratingAvg: null,
    onTimePct: null,
    priority: 0,
    ...o,
  });

  it('brand rep beats category specialist beats production-type match', () => {
    const ranked = rankCandidates(
      [c('pt', { productionTypes: ['LAYER'] }), c('cat', { categoryIds: ['nd'] }), c('brand', { brandIds: ['b1'] })],
      input,
      new Set(),
      3,
    );
    expect(ranked.map((r) => r.id)).toEqual(['brand', 'cat', 'pt']);
  });

  it('exact category beats an ancestor category', () => {
    expect(scoreCandidate(c('x', { categoryIds: ['nd'] }), input, false).score).toBeGreaterThan(
      scoreCandidate(c('y', { categoryIds: ['vaccines'] }), input, false).score,
    );
  });

  it('online adds weight; language alone never qualifies', () => {
    const ranked = rankCandidates(
      [c('lang-only', { languages: ['hi'] }), c('cat-off', { categoryIds: ['nd'] }), c('cat-on', { categoryIds: ['nd'] })],
      input,
      new Set(['cat-on']),
      3,
    );
    expect(ranked.map((r) => r.id)).toEqual(['cat-on', 'cat-off']);
    expect(ranked[0]?.matchedOn).toEqual(['CATEGORY']);
  });

  it('ties break by id and limit applies', () => {
    const ranked = rankCandidates([c('b', { brandIds: ['b1'] }), c('a', { brandIds: ['b1'] })], input, new Set(), 1);
    expect(ranked.map((r) => r.id)).toEqual(['a']);
  });
});

describe('settings', () => {
  const seeded = [
    { key: 'slotMinutes', value: { VIDEO: 30, PHONE: 30, FARM_VISIT: 60 } },
    { key: 'bufferMinutes', value: { VIDEO: { before: 0, after: 10 }, PHONE: { before: 0, after: 10 }, FARM_VISIT: { before: 30, after: 60 } } },
    { key: 'minNoticeMinutes', value: 120 },
    { key: 'horizonDays', value: 30 },
    { key: 'dateStripDays', value: 5 },
    { key: 'holdTtlSeconds', value: 600 },
    { key: 'ackSlaWorkingMinutes', value: 120 },
    { key: 'businessHours', value: { days: [1, 2, 3, 4, 5, 6], startMinute: 540, endMinute: 1080 } },
    { key: 'reminderOffsetMinutes', value: 60 },
    { key: 'reschedule', value: { cutoffMinutes: 60, maxCount: 2, afterFinalDays: 7 } },
    { key: 'attempts', value: { maxAttempts: 3, retryGapMinutes: 5, graceMinutes: 15 } },
    { key: 'noShowLimit', value: { maxNoShows: 2, windowDays: 30, blockDays: 7 } },
    {
      key: 'leadScoring',
      value: { sqlMin: 70, mqlMin: 40, valueBands: [[50000, 40], [10000, 25], [0, 10]], routingConsentPoints: 10, intentPoints: 5, maxIntentPoints: 15 },
    },
    { key: 'consentPolicyVersion', value: '2026-11' },
    { key: 'retention', value: { heldDays: 30, piiMonths: 12, bookingYears: 3, consentYears: 7, auditYears: 8, attemptYears: 1, recordingDays: 90 } },
    { key: 'whatHappensNext', value: ['{{expert}} confirms within {{slaHours}} working hours.'] },
  ];

  it('parses the migration seed', () => {
    const s = parseSettings(seeded);
    expect(s.slotMinutes.FARM_VISIT).toBe(60);
    expect(s.bufferMinutes.VIDEO.after).toBe(10);
  });

  it('a missing row is a deploy bug', () => {
    expect(() => parseSettings(seeded.slice(1))).toThrow(/slotMinutes/);
  });

  it('cross-field rules', () => {
    expect(checkSetting('businessHours', { days: [1], startMinute: 600, endMinute: 540 }).issues).toHaveLength(1);
    const bad = { sqlMin: 40, mqlMin: 40, valueBands: [[0, 10], [100, 20]], routingConsentPoints: 0, intentPoints: 0, maxIntentPoints: 0 };
    expect(checkSetting('leadScoring', bad).issues.map((i) => i.path)).toEqual(['value.sqlMin', 'value.valueBands']);
  });

  it('shape errors carry paths', () => {
    expect(checkSetting('slotMinutes', { VIDEO: 5, PHONE: 30 }).issues.map((i) => i.path)).toEqual([
      'value.VIDEO',
      'value.FARM_VISIT',
    ]);
  });
});
