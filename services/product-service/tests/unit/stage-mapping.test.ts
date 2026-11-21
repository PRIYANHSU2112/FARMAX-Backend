import { describe, expect, it } from 'vitest';

import {
  buildStageIndex,
  mapStages,
  normalizeStage,
} from '../../src/features/products/products.stage-mapping.js';

const stages = [
  { code: 'GROWER', label: 'Grower', aliases: ['growing'] },
  { code: 'PRE_LAYER', label: 'Pre-layer', aliases: ['prelay', 'pullet'] },
  { code: 'LAYER', label: 'Layer (in lay)', aliases: ['layer', 'laying'] },
];
const index = buildStageIndex(stages);
const codes = new Set(stages.map((s) => s.code));

describe('stage mapping', () => {
  it('normalises case, separators and spaces', () => {
    expect(normalizeStage('  Pre_Layer ')).toBe('pre layer');
    expect(normalizeStage('pre--layer')).toBe('pre layer');
    expect(normalizeStage('Broiler / Grower')).toBe('broiler grower');
  });

  it('matches code, then label, then alias', () => {
    expect(index.get('grower')).toBe('GROWER');
    expect(index.get('pre layer')).toBe('PRE_LAYER');
    expect(index.get('layer (in lay)')).toBe('LAYER');
    expect(index.get('laying')).toBe('LAYER');
    expect(index.get('pullet')).toBe('PRE_LAYER');
  });

  it('maps, de-duplicates, keeps unmapped values and reports them', () => {
    const r = mapStages(['grower', 'Growing', 'pre-layer', 'moulting'], index, codes);
    expect(r).toEqual({
      next: ['GROWER', 'PRE_LAYER', 'moulting'],
      unmapped: ['moulting'],
      changed: true,
    });
  });

  it('is idempotent: valid codes are left alone', () => {
    expect(mapStages(['GROWER', 'LAYER'], index, codes)).toEqual({
      next: ['GROWER', 'LAYER'],
      unmapped: [],
      changed: false,
    });
  });
});
