import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeGstProvider } from '../../src/adapters/kyc-providers.js';
import { buildApp } from '../../src/app.js';
import { isValidGstin } from '../../src/features/kyc/kyc.checks.js';

/**
 * B2B GST registration against a REAL Postgres with the farm migrations applied (local dev DB,
 * never Neon):
 *   FARM_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx \
 *   FARM_IT_REDIS_URL=redis://localhost:6379/5 pnpm --filter @farmx/farm-service test
 * Skipped when FARM_IT_DATABASE_URL is not set. Token verification and permissions are stubbed.
 */
const DB_URL = process.env.FARM_IT_DATABASE_URL;
const REDIS_URL = process.env.FARM_IT_REDIS_URL ?? 'redis://localhost:6379/5';

const CS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Appends the GSTIN mod-36 check character. */
const gstin = (first14: string): string => {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CS.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return first14 + CS.charAt((36 - (sum % 36)) % 36);
};

const owner = {
  id: randomUUID(),
  sessionId: 's',
  jti: 'j',
  userType: 'CUSTOMER',
  roles: [],
  scope: 'full',
  expiresAt: 0,
} as unknown as AuthUser;
const auth = { authorization: 'Bearer t' };
const territoryCode = `Q${randomUUID().slice(0, 2).toUpperCase()}`;
const farmId = randomUUID();
const ownerId = randomUUID();
const AP_GSTIN = gstin('37AKLPK7741Q1Z');
const TS_GSTIN = gstin('36AKLPK7741Q1Z');

interface Billing {
  gstin: string | null;
  invoiceName: string | null;
  gstVerified: boolean;
  businessName: string | null;
  tradeName: string | null;
  gstVerifiedAt: string | null;
}

let app: FastifyInstance;

describe.skipIf(DB_URL === undefined)('B2B GST registration (real DB)', () => {
  beforeAll(async () => {
    app = await buildApp({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: DB_URL,
      REDIS_CACHE_URL: REDIS_URL,
    });
    app.diContainer.register({
      tokenVerifier: asValue(() => Promise.resolve(owner)),
      gstProvider: asValue(new FakeGstProvider()),
    });
    await app.ready();
    const db = app.diContainer.resolve('db');
    await db.territory.create({
      data: { code: territoryCode, name: 'IT West', districtName: 'Eluru', stateCode: '37' },
    });
    await db.farmOwner.create({ data: { id: ownerId, userId: owner.id, fullName: 'IT Owner' } });
    await db.farm.create({
      data: {
        id: farmId,
        ownerId,
        category: 'POULTRY_FARM',
        name: 'Sri Lakshmi Poultry',
        nameNormalized: 'sri lakshmi poultry',
        pinCode: '534211',
        territoryCode,
        createdByUserId: owner.id,
      },
    });
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.outboxEvent.deleteMany({
      where: { payload: { path: ['data', 'farmId'], equals: farmId } },
    });
    await db.farm.deleteMany({ where: { id: farmId } });
    await db.farmOwner.deleteMany({ where: { id: ownerId } });
    await db.gstVerification.deleteMany({ where: { requestedBy: owner.id } });
    await db.territory.deleteMany({ where: { code: territoryCode } });
    await app.close();
  });

  const verify = (value: string) =>
    app.inject({
      method: 'POST',
      url: `/farms/${farmId}/kyc/gstin/verify`,
      headers: auth,
      payload: { gstin: value },
    });
  const bind = (verificationId: string) =>
    app.inject({
      method: 'PUT',
      url: `/farms/${farmId}/billing`,
      headers: auth,
      payload: { verificationId, invoiceNameSource: 'GST_TRADE_NAME' },
    });

  it('test GSTINs carry a valid checksum', () => {
    expect(isValidGstin(AP_GSTIN)).toBe(true);
    expect(isValidGstin(TS_GSTIN)).toBe(true);
  });

  it('a farm without GST is not verified', async () => {
    const res = await app.inject({ method: 'GET', url: `/farms/${farmId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { billing: Billing } }>().data.billing).toMatchObject({
      gstin: null,
      gstVerified: false,
      businessName: null,
      tradeName: null,
      gstVerifiedAt: null,
    });
  });

  it('verify returns portal names and the state check', async () => {
    const res = await verify(AP_GSTIN);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: object }>().data).toMatchObject({
      gstin: AP_GSTIN,
      businessName: 'Registered Legal Name',
      tradeName: 'Registered Trade Name',
      stateCode: '37',
      stateMatchesFarm: true,
    });
  });

  it('rejects a GSTIN registered in another state (ITC would be invalid)', async () => {
    const res = await verify(TS_GSTIN);
    expect(res.statusCode).toBe(200);
    const v = res.json<{ data: { verificationId: string; stateMatchesFarm: boolean } }>().data;
    expect(v.stateMatchesFarm).toBe(false);
    const bound = await bind(v.verificationId);
    expect(bound.statusCode).toBe(422);
    expect(bound.body).toContain('registered in state 36');
  });

  it('rejects a stale (> 24 h) GST check', async () => {
    const v = (await verify(AP_GSTIN)).json<{ data: { verificationId: string } }>().data;
    await app.diContainer.resolve('db').gstVerification.update({
      where: { id: v.verificationId },
      data: { checkedAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    const res = await bind(v.verificationId);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('older than 24 hours');
  });

  it('binds the GSTIN with portal names and emits farm.facts_changed.v1 with GST flags', async () => {
    const v = (await verify(AP_GSTIN)).json<{ data: { verificationId: string } }>().data;
    const res = await bind(v.verificationId);
    expect(res.statusCode).toBe(200);
    const billing = res.json<{ data: { billing: Billing } }>().data.billing;
    expect(billing).toMatchObject({
      gstin: AP_GSTIN,
      gstVerified: true,
      businessName: 'Registered Legal Name',
      tradeName: 'Registered Trade Name',
      invoiceName: 'Registered Trade Name',
    });
    expect(billing.gstVerifiedAt).not.toBeNull();

    const events = await app.diContainer.resolve('db').outboxEvent.findMany({
      where: {
        type: 'farm.facts_changed.v1',
        payload: { path: ['data', 'farmId'], equals: farmId },
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    const data = (events[0]?.payload as { data: Record<string, unknown> } | undefined)?.data;
    expect(data).toMatchObject({
      gstin: AP_GSTIN,
      gstVerified: true,
      gstBusinessName: 'Registered Legal Name',
      gstTradeName: 'Registered Trade Name',
      invoiceName: 'Registered Trade Name',
      stateCode: '37',
    });
    expect(data?.gstVerifiedAt).toBe(billing.gstVerifiedAt);
  });
});
