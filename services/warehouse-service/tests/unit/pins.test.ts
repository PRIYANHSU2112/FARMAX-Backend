import { describe, expect, it } from 'vitest';

import { compressPins, expandPins } from '../../src/features/service-areas/service-areas.pins.js';

describe('PIN entries', () => {
  it('expands single PINs and ranges into sorted unique PINs', () => {
    const { pins, issues } = expandPins(['411003', '411001-411003', ' 422001 ']);
    expect(issues).toEqual([]);
    expect(pins).toEqual(['411001', '411002', '411003', '422001']);
  });

  it('refuses malformed entries, reversed ranges and ranges across PIN areas', () => {
    const { issues } = expandPins(['41100', '011001', '411010-411001', '411001-412001']);
    expect(issues.map((i) => i.entry)).toEqual([
      '41100',
      '011001',
      '411010-411001',
      '411001-412001',
    ]);
  });

  it('caps one range at 1,000 PINs', () => {
    expect(expandPins(['411000-411999']).issues).toEqual([]);
    expect(expandPins(['410000-411999']).issues).toHaveLength(1);
  });

  it('compresses PINs back into ranges for the edit form', () => {
    expect(compressPins(['411003', '411001', '411002', '411010', '422001', '422002'])).toEqual([
      '411001-411003',
      '411010',
      '422001-422002',
    ]);
    expect(compressPins([])).toEqual([]);
  });
});
