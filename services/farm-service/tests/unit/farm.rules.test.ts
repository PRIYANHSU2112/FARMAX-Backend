import { describe, expect, it } from 'vitest';

import { scoreCandidates } from '../../src/features/farms/farm.dedupe.js';
import {
  FARM_CODE_PATTERN,
  assertTransition,
  buildFarmCode,
  canTransition,
  farmCodePreview,
  normalizeName,
  validateDetails,
} from '../../src/features/farms/farm.rules.js';
import type { DuplicateCandidate } from '../../src/features/farms/farms.types.js';

describe('Farm ID', () => {
  it('builds FX-<territory>-<type>-<serial> from the primary type', () => {
    expect(buildFarmCode('WG', 'LAYER', 418)).toBe('FX-WG-L-00418');
    expect(buildFarmCode('WG', 'FEED_MILL', 7)).toBe('FX-WG-FM-00007');
    expect(buildFarmCode('KR', 'BROILER_BREEDER', 123456)).toBe('FX-KR-BB-123456');
    expect(FARM_CODE_PATTERN.test(buildFarmCode('EG', 'HATCHERY', 1))).toBe(true);
  });

  it('previews without a serial and only once territory + type are known', () => {
    expect(farmCodePreview('WG', 'HATCHERY')).toBe('FX-WG-H-•••••');
    expect(farmCodePreview(null, 'LAYER')).toBeNull();
    expect(farmCodePreview('WG', undefined)).toBeNull();
  });

  it('normalises names for dedupe and search', () => {
    expect(normalizeName('  Sri   Lakshmi  POULTRY ')).toBe('sri lakshmi poultry');
  });
});

describe('validateDetails', () => {
  const birds = (productionType: 'LAYER' | 'BROILER', value: number) =>
    ({
      productionType,
      metric: 'BIRDS',
      value,
      period: productionType === 'BROILER' ? 'PER_CYCLE' : 'STANDING',
    }) as const;

  it('keeps the ranked order of production types', () => {
    expect(
      validateDetails(
        'POULTRY_FARM',
        ['LAYER', 'BROILER'],
        [birds('LAYER', 60_000), birds('BROILER', 12_000)],
      ),
    ).toEqual(['LAYER', 'BROILER']);
  });

  it('applies the fixed type for single-type categories', () => {
    expect(
      validateDetails('HATCHERY', undefined, [
        { productionType: 'HATCHERY', metric: 'EGGS', value: 60_000, period: 'PER_SETTING' },
      ]),
    ).toEqual(['HATCHERY']);
  });

  it('rejects a type outside the category, a missing capacity and a wrong period', () => {
    expect(() => validateDetails('POULTRY_FARM', ['HATCHERY'], [])).toThrow('Validation failed');
    expect(() =>
      validateDetails('POULTRY_FARM', ['LAYER', 'BROILER'], [birds('LAYER', 1)]),
    ).toThrow('Validation failed');
    expect(() =>
      validateDetails('FEED_MILL', undefined, [
        { productionType: 'FEED_MILL', metric: 'FEED_TONNES', value: 8, period: 'PER_MONTH' },
      ]),
    ).toThrow('Validation failed');
  });
});

describe('state machine', () => {
  it('allows the journey and admin transitions', () => {
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(true);
    expect(canTransition('DRAFT', 'UNDER_REVIEW')).toBe(true);
    expect(canTransition('UNDER_REVIEW', 'MERGED')).toBe(true);
    expect(canTransition('NEEDS_ATTENTION', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
  });

  it('refuses everything else with 409 FARM_STATE_INVALID', () => {
    expect(canTransition('ACTIVE', 'DRAFT')).toBe(false);
    expect(canTransition('CLOSED', 'ACTIVE')).toBe(false);
    expect(canTransition('MERGED', 'ACTIVE')).toBe(false);
    let error: unknown;
    try {
      assertTransition('REJECTED', 'ACTIVE');
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ statusCode: 409, details: { reason: 'FARM_STATE_INVALID' } });
  });
});

describe('scoreCandidates', () => {
  const base: DuplicateCandidate = {
    farmId: 'f2',
    ownerId: 'o2',
    farmCode: 'FX-WG-L-00391',
    name: 'x',
    sameOwner: false,
    distanceM: null,
    nameSimilarity: 0,
    panMatch: false,
    gstinMatch: false,
  };

  it('returns null when nothing matches', () => {
    expect(scoreCandidates([], 150)).toBeNull();
    expect(scoreCandidates([{ ...base, distanceM: 140, nameSimilarity: 0.2 }], 150)).toBeNull();
  });

  it('flags another owner using the same PAN or GSTIN', () => {
    expect(scoreCandidates([{ ...base, panMatch: true, gstinMatch: true }], 150)).toMatchObject({
      signals: ['PAN_OTHER_OWNER', 'GSTIN_OTHER_OWNER'],
      score: 100,
    });
  });

  it('asks the same owner about a nearby farm, but not a far one', () => {
    expect(
      scoreCandidates([{ ...base, sameOwner: true, panMatch: true, distanceM: 140 }], 150)?.signals,
    ).toEqual(['GEO_SAME_OWNER']);
    expect(
      scoreCandidates([{ ...base, sameOwner: true, panMatch: true, distanceM: 900 }], 150),
    ).toBeNull();
  });

  it('flags a nearby, similarly named farm of another owner and picks the strongest match', () => {
    const near = { ...base, farmId: 'near', distanceM: 60, nameSimilarity: 0.8 };
    const pan = { ...base, farmId: 'pan', panMatch: true, distanceM: 50, nameSimilarity: 0.9 };
    expect(scoreCandidates([near, pan], 150)?.candidate.farmId).toBe('pan');
  });
});
