import { describe, expect, it } from 'vitest';

import { PUBLIC_KEYS, toPublic } from '../../src/features/certificates/index.js';
import type { Card } from '../../src/features/certificates/index.js';
import { bucketOf, labStepAllowed, labSteps } from '../../src/features/samples/index.js';
import {
  type SpecParam,
  judge,
  mismatch,
  overallVerdict,
  specLabel,
  specProblems,
} from '../../src/features/specs/index.js';

const p = (over: Partial<SpecParam>): SpecParam => ({
  code: 'X',
  name: 'X',
  unit: null,
  rule: 'MIN',
  min: null,
  max: null,
  expectedText: null,
  critical: false,
  sortOrder: 0,
  ...over,
});

describe('judge', () => {
  it('MIN / MAX / RANGE with the limit itself conforming', () => {
    expect(judge(p({ rule: 'MIN', min: 85 }), { valueNum: 85 })).toBe('CONFORMS');
    expect(judge(p({ rule: 'MIN', min: 85 }), { valueNum: 68.4 })).toBe('FAILS');
    expect(judge(p({ rule: 'MAX', max: 12 }), { valueNum: 12 })).toBe('CONFORMS');
    expect(judge(p({ rule: 'MAX', max: 10 }), { valueNum: 14.8 })).toBe('FAILS');
    expect(judge(p({ rule: 'RANGE', min: 7, max: 9 }), { valueNum: 8.4 })).toBe('CONFORMS');
    expect(judge(p({ rule: 'RANGE', min: 7, max: 9 }), { valueNum: 9.01 })).toBe('FAILS');
  });

  it('log values: virus titre 10^5.8 against ≥ 10^6.0 fails', () => {
    expect(judge(p({ rule: 'MIN', min: 6 }), { valueNum: 5.8 })).toBe('FAILS');
  });

  it('TEXT is case-insensitive; a missing value is REVIEW', () => {
    expect(judge(p({ rule: 'TEXT', expectedText: 'Pass' }), { valueText: 'pass' })).toBe(
      'CONFORMS',
    );
    expect(judge(p({ rule: 'TEXT', expectedText: 'Pass' }), { valueText: 'Fail' })).toBe('FAILS');
    expect(judge(p({ rule: 'TEXT', expectedText: 'Pass' }), {})).toBe('REVIEW');
    expect(judge(p({ rule: 'MIN', min: 1 }), { valueNum: null })).toBe('REVIEW');
  });
});

describe('overallVerdict', () => {
  it('any FAILS → FAIL; all spec codes CONFORMS → PASS; else PENDING', () => {
    expect(
      overallVerdict(
        ['A', 'B'],
        [
          { paramCode: 'A', verdict: 'CONFORMS' },
          { paramCode: 'B', verdict: 'FAILS' },
        ],
      ),
    ).toBe('FAIL');
    expect(
      overallVerdict(
        ['A', 'B'],
        [
          { paramCode: 'A', verdict: 'CONFORMS' },
          { paramCode: 'B', verdict: 'CONFORMS' },
        ],
      ),
    ).toBe('PASS');
    expect(
      overallVerdict(
        ['A', 'B'],
        [
          { paramCode: 'A', verdict: 'CONFORMS' },
          { paramCode: 'B', verdict: 'REVIEW' },
        ],
      ),
    ).toBe('PENDING');
    expect(overallVerdict(['A', 'B'], [{ paramCode: 'A', verdict: 'CONFORMS' }])).toBe('PENDING');
  });
});

describe('mismatch (Certificate Audit Alert)', () => {
  const mfr = [
    { paramCode: 'AFB1', verdict: 'CONFORMS' as const },
    { paramCode: 'PB', verdict: 'CONFORMS' as const },
    { paramCode: 'MOIST', verdict: 'CONFORMS' as const },
  ];
  it('HIGH with a critical parameter or two failures', () => {
    expect(
      mismatch(mfr, [
        { paramCode: 'AFB1', paramName: 'AFB1 binding', verdict: 'FAILS', critical: false },
        { paramCode: 'PB', paramName: 'Lead (Pb)', verdict: 'FAILS', critical: false },
        { paramCode: 'MOIST', paramName: 'Moisture', verdict: 'CONFORMS', critical: false },
      ]),
    ).toEqual({
      severity: 'HIGH',
      params: [
        { code: 'AFB1', name: 'AFB1 binding', critical: false },
        { code: 'PB', name: 'Lead (Pb)', critical: false },
      ],
    });
  });
  it('MEDIUM for one non-critical failure; null when both agree', () => {
    expect(
      mismatch(mfr, [
        { paramCode: 'MOIST', paramName: 'Moisture', verdict: 'FAILS', critical: false },
      ])?.severity,
    ).toBe('MEDIUM');
    expect(
      mismatch(mfr, [{ paramCode: 'PB', paramName: 'Lead', verdict: 'CONFORMS', critical: true }]),
    ).toBeNull();
  });
});

describe('spec form', () => {
  it('labels and problems', () => {
    expect(specLabel(p({ rule: 'MAX', max: 10, unit: 'ppm' }))).toBe('≤ 10 ppm');
    expect(specLabel(p({ rule: 'RANGE', min: 7, max: 9 }))).toBe('7–9');
    expect(specProblems([], true)).toHaveLength(1);
    expect(
      specProblems(
        [p({ code: 'A', rule: 'RANGE', min: 9, max: 7 }), p({ code: 'A', rule: 'TEXT' })],
        true,
      ).map((x) => x.message),
    ).toEqual(['max must be ≥ min', 'duplicate parameter "A"', 'TEXT needs expectedText']);
  });
});

describe('sample status machine', () => {
  it('lab steps go forward only', () => {
    expect(labStepAllowed('SENT', 'ACKNOWLEDGED')).toBe(true);
    expect(labStepAllowed('SENT', 'RESULTS_RECEIVED')).toBe(true);
    expect(labStepAllowed('TESTING', 'ACKNOWLEDGED')).toBe(false);
    expect(labStepAllowed('COLLECTED', 'TESTING')).toBe(false);
  });
  it('dashboard buckets and W16.04 steps', () => {
    expect(bucketOf('COLLECTED')).toBe('pending');
    expect(bucketOf('ACKNOWLEDGED')).toBe('testing');
    expect(labSteps('ACKNOWLEDGED').map((s) => s.state)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'CURRENT',
      'PENDING',
    ]);
  });
});

describe('public verify allow-list', () => {
  it('drops everything outside the allow-list', () => {
    const card = {
      batchId: 'b',
      batchNo: 'B1',
      mfgDate: null,
      expiryDate: null,
      vendorName: 'v',
      cnNos: ['CN-1'],
      product: null,
      status: 'PASS',
      statusText: 'ok',
      releasedOn: null,
      quarantine: null,
      certificates: [],
      parameters: [],
      whatFailed: [],
      mismatch: null,
      pending: null,
      timeline: [],
      policy: 'p',
      // A field that must never leak even if someone adds it to a card later.
      orderNo: 'ORD-1',
    } as unknown as Card;
    expect(Object.keys(toPublic(card)).sort()).toEqual([...PUBLIC_KEYS].sort());
  });
});
