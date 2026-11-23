import { randomInt } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * Self-service account deletion against REAL Postgres + Redis (DB 10):
 *   AUTH_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx_supporttest pnpm --filter @farmx/auth-service test
 * Skipped when the variable is not set. Uses the dev OTP code (console SMS).
 */
const DB_URL = process.env.AUTH_IT_DATABASE_URL;
const CODE = '123456';

describe.skipIf(DB_URL === undefined)('account deletion + recovery (Postgres + Redis)', () => {
  let app: FastifyInstance;
  const phone = `+9198${String(randomInt(10_000_000, 99_999_999))}`;

  const post = (url: string, payload: object, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  /** OTP cooldowns would block the next step of the same flow within 60 s. */
  const clearCooldowns = async () => {
    const redis = app.diContainer.resolve('redis');
    const keys = await redis.keys('farmx:auth:*cooldown*');
    if (keys.length > 0) await redis.del(...keys);
  };

  const login = async () => {
    await clearCooldowns();
    await post('/auth/otp/send', { phone });
    return post('/auth/otp/verify', { phone, code: CODE });
  };

  beforeAll(async () => {
    app = await buildApp({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: DB_URL,
      REDIS_CACHE_URL: 'redis://localhost:6379/10',
      SMS_PROVIDER: 'console',
      OTP_DEV_CODE: CODE,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('request → sessions end + login blocked → recovery → cancel → login again → purge after the grace period', async () => {
    const first = await login();
    expect(first.statusCode).toBe(200);
    const access = first.json<{ data: { accessToken: string } }>().data.accessToken;

    const screen = await app.inject({
      method: 'GET',
      url: '/me/deletion-request',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(screen.json<{ data: { request: unknown; graceDays: number } }>().data).toMatchObject({
      request: null,
      graceDays: 30,
    });

    await clearCooldowns();
    expect((await post('/me/deletion-request/otp', {}, access)).statusCode).toBe(200);
    expect((await post('/me/deletion-request', { otp: '000000' }, access)).statusCode).toBe(401);
    const requested = await post(
      '/me/deletion-request',
      { otp: CODE, reason: 'Not farming any more' },
      access,
    );
    expect(requested.statusCode).toBe(201);

    // Every session ended at once: the old access token is dead everywhere.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${access}` },
        })
      ).statusCode,
    ).toBe(401);
    // Normal login is refused with a reason the app can act on.
    const blocked = await login();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'ACCOUNT_PENDING_DELETION',
    );

    // Recovery: unknown numbers get the same answer (no enumeration).
    expect(
      (await post('/auth/account-recovery/otp', { phone: '+919000000001' })).json<{
        data: unknown;
      }>().data,
    ).toEqual({ sent: true });
    await clearCooldowns();
    expect((await post('/auth/account-recovery/otp', { phone })).statusCode).toBe(200);
    const verified = await post('/auth/account-recovery/verify', { phone, code: CODE });
    const { recoveryToken } = verified.json<{ data: { recoveryToken: string } }>().data;
    // A recovery token is NOT an access token.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${recoveryToken}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/account-recovery/cancel-deletion', { recoveryToken })).json<{
        data: unknown;
      }>().data,
    ).toEqual({ restored: true });
    expect(
      (await post('/auth/account-recovery/cancel-deletion', { recoveryToken })).statusCode,
    ).toBe(401); // single use

    const again = await login();
    expect(again.statusCode).toBe(200);
    const access2 = again.json<{ data: { accessToken: string } }>().data.accessToken;

    // Request again, then let the grace period pass and run the purge.
    await clearCooldowns();
    await post('/me/deletion-request/otp', {}, access2);
    expect((await post('/me/deletion-request', { otp: CODE }, access2)).statusCode).toBe(201);
    const db = app.diContainer.resolve('db');
    const user = await db.user.findFirstOrThrow({ where: { phone } });
    await db.$executeRaw`UPDATE "account_deletion_requests" SET "requestedAt" = now() - interval '31 days', "scheduledFor" = now() - interval '1 day' WHERE "userId" = ${user.id}::uuid AND "status" = 'PENDING'`;
    const service = app.diContainer.resolve('deletionService');
    await Promise.all([service.purgeDue(), service.purgeDue()]); // replicas racing: SKIP LOCKED
    const purged = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(purged).toMatchObject({
      phone: null,
      email: `deleted-${user.id}@deleted.invalid`,
      fullName: 'Deleted user',
      status: 'DEACTIVATED',
    });
    expect(purged.deletedAt).not.toBeNull();
    const events = await db.outboxEvent.findMany({ where: { type: 'user.deleted.v1' } });
    expect(
      events.filter((e) => (e.payload as { data: { userId: string } }).data.userId === user.id),
    ).toHaveLength(1);
  });
});
