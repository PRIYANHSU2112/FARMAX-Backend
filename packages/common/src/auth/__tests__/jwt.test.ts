import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { JwtError, generateJwtKeys, signJwt, verifyJwt } from '../jwt.js';

const keys = generateJwtKeys('k1');
const opts = { issuer: 'farmx-auth', audience: 'farmx' };
const now = () => Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: 'farmx-auth',
  aud: 'farmx',
  sub: 'u1',
  iat: now(),
  exp: now() + 900,
  ...extra,
});
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('EdDSA JWT', () => {
  it('signs and verifies', () => {
    expect(verifyJwt(signJwt(claims(), keys), keys, opts)).toMatchObject({ sub: 'u1' });
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signJwt(claims(), keys).split('.');
    const forged = `${h}.${b64(claims({ sub: 'admin' }))}.${s}`;
    expect(() => verifyJwt(forged, keys, opts)).toThrow(JwtError);
  });

  it('rejects alg=none and other algorithms (no downgrade)', () => {
    const payload = b64(claims());
    expect(() =>
      verifyJwt(`${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${payload}.`, keys, opts),
    ).toThrow(/unsupported algorithm/);
    expect(() =>
      verifyJwt(`${b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.${payload}.x`, keys, opts),
    ).toThrow(/unsupported algorithm/);
  });

  it('rejects a token signed by another key, or with an unknown kid', () => {
    const other = generateJwtKeys('k1');
    expect(() => verifyJwt(signJwt(claims(), other), keys, opts)).toThrow(/bad signature/);
    expect(() => verifyJwt(signJwt(claims(), { ...keys, kid: 'k2' }), keys, opts)).toThrow(
      /unknown key/,
    );
  });

  it('rejects expired tokens and wrong issuer / audience', () => {
    expect(() => verifyJwt(signJwt(claims({ exp: now() - 60 }), keys), keys, opts)).toThrow(
      /expired/,
    );
    expect(() => verifyJwt(signJwt(claims({ iss: 'evil' }), keys), keys, opts)).toThrow(/issuer/);
    expect(() => verifyJwt(signJwt(claims({ aud: 'other' }), keys), keys, opts)).toThrow(
      /audience/,
    );
  });

  it('rejects malformed and oversized tokens', () => {
    expect(() => verifyJwt('a.b', keys, opts)).toThrow(/malformed/);
    expect(() => verifyJwt('x'.repeat(5000), keys, opts)).toThrow(/too long/);
  });

  it('only accepts Ed25519 key material', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(rsa.privateKey.asymmetricKeyType).toBe('rsa');
    expect(keys.privateKey.asymmetricKeyType).toBe('ed25519');
  });
});
