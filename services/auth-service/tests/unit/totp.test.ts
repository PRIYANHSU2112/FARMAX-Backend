import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCodes,
  totpAt,
  verifyTotp,
} from '../../src/features/auth/totp.js';

// RFC 6238 Appendix B, SHA-1 secret "12345678901234567890", 8 digits, 30 s steps.
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('T=%i → %s', (time, expected) => {
    expect(totpAt(RFC_SECRET, Math.floor(time / 30), 8)).toBe(expected);
  });

  it('verifies within ±1 step and returns the matched step; rejects outside', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, 30, 1)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 3), now, 30, 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, 30, 1)).toBeNull();
  });

  it('base32 round-trips', () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });
});

describe('secret encryption (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('round-trips and never stores the plaintext', () => {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(sealed, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('fails on tampering or the wrong key', () => {
    const sealed = encryptSecret('secret', key);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
  });
});

describe('recovery codes', () => {
  it('generates unique xxxx-xxxx codes and hashes them case/format-insensitively', () => {
    const codes = newRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    const [first = ''] = codes;
    expect(hashRecoveryCode(first.toUpperCase().replace('-', ' '))).toBe(hashRecoveryCode(first));
  });
});
