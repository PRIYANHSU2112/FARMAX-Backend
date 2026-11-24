import { describe, expect, it } from 'vitest';

import { toGstStateCode } from '../index.js';

describe('toGstStateCode', () => {
  it('maps 2-letter state codes to GST codes', () => {
    expect(toGstStateCode('AP')).toBe('37');
    expect(toGstStateCode('ap')).toBe('37');
    expect(toGstStateCode('TS')).toBe('36');
    expect(toGstStateCode('TG')).toBe('36');
    expect(toGstStateCode('KA')).toBe('29');
    expect(toGstStateCode('OD')).toBe('21');
  });

  it('passes valid GST codes through', () => {
    expect(toGstStateCode('37')).toBe('37');
    expect(toGstStateCode('07')).toBe('07');
  });

  it('returns null for unknown or empty input', () => {
    expect(toGstStateCode(null)).toBeNull();
    expect(toGstStateCode(undefined)).toBeNull();
    expect(toGstStateCode('')).toBeNull();
    expect(toGstStateCode('ZZ')).toBeNull();
    expect(toGstStateCode('28')).toBeNull(); // old Andhra Pradesh, no longer issued
    expect(toGstStateCode('99')).toBeNull();
  });
});
