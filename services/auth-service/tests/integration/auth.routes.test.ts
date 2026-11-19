import { createPublicKey, verify } from 'node:crypto';

import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { FakeRedis } from '../helpers/fake-redis.js';

// The pg pool connects lazily: no database is needed for these route-level tests.
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build() {
  app = await buildApp(ENV);
  const redis = new FakeRedis();
  const accessService = {
    hasPermission: vi.fn(() => Promise.resolve(true)),
    listPermissions: () => [],
  };
  const authService = {
    sendLoginOtp: vi.fn(() => Promise.resolve({ sent: true, expiresIn: 300, resendAfter: 30 })),
    logout: vi.fn(() => Promise.resolve()),
    startTotpEnrollment: vi.fn(() => Promise.resolve({ secret: 'S', otpauthUrl: 'otpauth://x' })),
  };
  app.diContainer.register({
    redis: asValue(redis as never),
    accessService: asValue(accessService as never),
    authService: asValue(authService as never),
  });
  const tokens = app.diContainer.resolve('tokensService');
  const issue = (scope: 'full' | 'mfa_enroll' = 'full') =>
    tokens.issueAccessToken({
      userId: 'u1',
      sessionId: 's1',
      userType: 'INTERNAL',
      roles: ['super_admin'],
      scope,
    });
  return { app, redis, accessService, authService, issue };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('access tokens end to end (real EdDSA signing + verification)', () => {
  it('publishes a JWKS that verifies issued tokens', async () => {
    const t = await build();
    const res = await t.app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=300');
    const [jwk] = res.json<{ keys: Record<string, string>[] }>().keys;
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });

    const [h, p, s] = t.issue().accessToken.split('.');
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    expect(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s ?? '', 'base64url'))).toBe(
      true,
    );
  });

  it('protected route: 401 without / with a tampered token, 200 with a valid one', async () => {
    const t = await build();
    expect((await t.app.inject({ method: 'GET', url: '/admin/permissions' })).statusCode).toBe(401);

    const token = t.issue().accessToken;
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/permissions', headers: bearer(tampered) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/permissions', headers: bearer(token) }))
        .statusCode,
    ).toBe(200);
    expect(t.accessService.hasPermission).toHaveBeenCalledWith('u1', 'permissions.view');
  });

  it('a logged-out token (jti blacklisted) or revoked session is refused immediately', async () => {
    const t = await build();
    const issued = t.issue();
    await t.redis.set(`farmx:auth:v1:revoked:jti:${issued.jti}`, '1', 'EX', 900);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/admin/permissions',
          headers: bearer(issued.accessToken),
        })
      ).statusCode,
    ).toBe(401);

    const other = t.issue();
    await t.redis.set('farmx:auth:v1:revoked:sid:s1', '1', 'EX', 900);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/admin/permissions',
          headers: bearer(other.accessToken),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('403 without the permission (default deny)', async () => {
    const t = await build();
    t.accessService.hasPermission.mockResolvedValueOnce(false);
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/permissions',
      headers: bearer(t.issue().accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });

  it('enrolment-only tokens work ONLY on the MFA enrolment routes', async () => {
    const t = await build();
    const enrol = t.issue('mfa_enroll').accessToken;
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/permissions', headers: bearer(enrol) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/me', headers: bearer(enrol) })).statusCode,
    ).toBe(403);
    const res = await t.app.inject({
      method: 'POST',
      url: '/me/mfa/totp/enroll',
      headers: bearer(enrol),
    });
    expect(res.statusCode).toBe(200);
  });

  it('logout → 204', async () => {
    const t = await build();
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(t.issue().accessToken),
    });
    expect(res.statusCode).toBe(204);
    expect(t.authService.logout).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', scope: 'full' }),
      expect.anything(),
    );
  });
});

describe('validation and rate limits', () => {
  it('422 on a non-E.164 phone or a malformed refresh token', async () => {
    const t = await build();
    const otp = await t.app.inject({
      method: 'POST',
      url: '/auth/otp/send',
      payload: { phone: '9876543210' },
    });
    expect(otp.statusCode).toBe(422);
    const refresh = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'short' },
    });
    expect(refresh.statusCode).toBe(422);
    const mfa = await t.app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { challengeId: 'x'.repeat(32), code: '123456', recoveryCode: 'abcd-efgh' },
    });
    expect(mfa.statusCode).toBe(422);
  });

  it('OTP send: 5 per number per hour, then 429 with Retry-After', async () => {
    const t = await build();
    const send = () =>
      t.app.inject({ method: 'POST', url: '/auth/otp/send', payload: { phone: '+919876543210' } });
    for (let i = 0; i < 5; i += 1) expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(t.authService.sendLoginOtp).toHaveBeenCalledTimes(5);
  });
});
