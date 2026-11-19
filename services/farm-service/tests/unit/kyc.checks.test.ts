import { describe, expect, it } from 'vitest';

import { LocalCache } from '../../src/adapters/local-cache.js';
import { PiiCrypto } from '../../src/adapters/pii-crypto.js';
import {
  PAN_PATTERN,
  isValidAadhaar,
  isValidGstin,
  maskPan,
  namesMatch,
} from '../../src/features/kyc/kyc.checks.js';

describe('Aadhaar (Verhoeff)', () => {
  it('accepts exactly one check digit for a prefix and rejects bad shapes', () => {
    const valid = '0123456789'.split('').filter((d) => isValidAadhaar(`23456789012${d}`));
    expect(valid).toHaveLength(1);
    expect(isValidAadhaar('12345678901')).toBe(false); // 11 digits
    expect(isValidAadhaar(`03456789012${valid[0] ?? ''}`)).toBe(false); // leading 0
  });
});

describe('GSTIN', () => {
  it('validates the mod-36 checksum', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
  });
});

describe('PAN', () => {
  it('checks the shape and masks for display', () => {
    expect(PAN_PATTERN.test('AKLPK7741Q')).toBe(true);
    expect(PAN_PATTERN.test('AKLXK7741Q')).toBe(false); // 4th char must be a holder type
    expect(maskPan('AKLPK7741Q')).toBe('AKLPK****Q');
  });
});

describe('namesMatch', () => {
  it('matches on any shared word of 3+ letters, case-insensitively', () => {
    expect(namesMatch('K. Venkata Ramana', 'Kothapalli Venkata Ramana')).toBe(true);
    expect(namesMatch('Sri Lakshmi Agro Farms', 'Sri Lakshmi Poultry')).toBe(true);
    expect(namesMatch('Padmavathi Hatcheries', 'Sai Ganesh Feeds')).toBe(false);
  });
});

describe('PiiCrypto', () => {
  const pii = PiiCrypto.ephemeral();

  it('round-trips AES-GCM with a fresh IV each time', () => {
    const a = pii.encrypt('AKLPK7741Q');
    const b = pii.encrypt('AKLPK7741Q');
    expect(a.equals(b)).toBe(false);
    expect(pii.decrypt(a)).toBe('AKLPK7741Q');
  });

  it('detects tampering', () => {
    const blob = pii.encrypt('AKLPK7741Q');
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    expect(() => pii.decrypt(blob)).toThrow();
  });

  it('hashes deterministically per purpose and verifies signatures in constant time', () => {
    expect(pii.hash('pan', 'X')).toBe(pii.hash('pan', 'X'));
    expect(pii.hash('pan', 'X')).not.toBe(pii.hash('pass', 'X'));
    expect(pii.verify('pass', 'FX-WG-L-00418', pii.hash('pass', 'FX-WG-L-00418'))).toBe(true);
    expect(pii.verify('pass', 'FX-WG-L-00418', '00')).toBe(false);
  });
});

describe('LocalCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LocalCache<number>(2, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});
