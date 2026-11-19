import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

// pg connects lazily and Redis is replaced, so no running infrastructure is needed.
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const user = (userType: AuthUser['userType']) =>
  ({
    id: '01900000-0000-7000-8000-000000000001',
    sessionId: 's',
    jti: 'j',
    userType,
    roles: [],
    scope: 'full',
    expiresAt: 0,
  }) as unknown as AuthUser;
const auth = { authorization: 'Bearer test-token' };
const FARM_ID = '01900000-0000-7000-8000-0000000000aa';

/** Redis stub: rate-limit store "down" (requests are allowed), nothing cached. */
const redisDown = {
  eval: () => Promise.reject(new Error('down')),
  get: () => Promise.resolve(null),
  mget: () => Promise.resolve([null, null]),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (caller: AuthUser | null, allow = false) => {
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    accessClient: asValue({ hasPermission: () => Promise.resolve(allow) } as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return app;
};

describe('farm-service guards', () => {
  it('401 without a valid token (fails closed)', async () => {
    const a = await build(null);
    expect((await a.inject({ method: 'GET', url: '/farms', headers: auth })).statusCode).toBe(401);
  });

  it('serves the static categories to customers with cache headers', async () => {
    const a = await build(user('CUSTOMER'));
    const res = await a.inject({ method: 'GET', url: '/farms/categories', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.json<{ data: { category: string }[] }>().data.map((c) => c.category)).toEqual([
      'POULTRY_FARM',
      'HATCHERY',
      'FEED_MILL',
      'BACKYARD',
    ]);
  });

  it('403 for customers on admin routes and for staff without the permission', async () => {
    const asCustomer = await build(user('CUSTOMER'));
    expect(
      (await asCustomer.inject({ method: 'GET', url: '/admin/farms', headers: auth })).statusCode,
    ).toBe(403);
    await asCustomer.close();
    const asStaff = await build(user('INTERNAL'), false);
    expect(
      (await asStaff.inject({ method: 'GET', url: '/admin/farms/stats', headers: auth }))
        .statusCode,
    ).toBe(403);
  });

  it('403 for staff on customer routes', async () => {
    const a = await build(user('INTERNAL'));
    expect((await a.inject({ method: 'GET', url: '/farms', headers: auth })).statusCode).toBe(403);
  });

  it('422 lists every invalid field (location outside India, bad accuracy)', async () => {
    const a = await build(user('CUSTOMER'));
    const res = await a.inject({
      method: 'PUT',
      url: `/farms/${FARM_ID}/location`,
      headers: auth,
      payload: {
        latitude: 51.5,
        longitude: 0.1,
        accuracyM: 500,
        capturedAt: '2026-11-01T10:00:00Z',
        village: 'Denduluru',
        pinCode: '534432',
      },
    });
    expect(res.statusCode).toBe(422);
    const paths = res
      .json<{ error: { details: { issues: { path: string }[] } } }>()
      .error.details.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.latitude', 'body.longitude', 'body.accuracyM']),
    );
  });

  it('rejects an invalid Aadhaar before any provider call', async () => {
    const a = await build(user('CUSTOMER'));
    const res = await a.inject({
      method: 'POST',
      url: `/farms/${FARM_ID}/kyc/aadhaar/otp`,
      headers: auth,
      payload: { aadhaarNumber: '123412341234', consent: true },
    });
    expect(res.statusCode).toBe(422);
  });

  it('public pass verification answers 404 for a bad signature (no lookup)', async () => {
    const a = await build(null);
    const res = await a.inject({
      method: 'GET',
      url: `/farms/verify/FX-WG-L-00418?sig=${'0'.repeat(64)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('internal routes are not mounted without INTERNAL_SERVICE_TOKEN', async () => {
    const a = await build(null);
    expect((await a.inject({ method: 'GET', url: `/internal/farms/${FARM_ID}` })).statusCode).toBe(
      404,
    );
  });
});

describe('OpenAPI spec', () => {
  interface Spec {
    tags: { name: string }[];
    paths: Record<
      string,
      Record<string, { tags?: string[]; security?: unknown[]; description?: string }>
    >;
    components: { schemas: Record<string, unknown> };
  }

  it('documents every customer and admin route with tags, auth and permissions', async () => {
    const a = await build(null);
    const spec = (await a.inject({ method: 'GET', url: '/api-docs.json' })).json<Spec>();
    const paths = Object.keys(spec.paths);
    for (const p of [
      '/farms',
      '/farms/categories',
      '/farms/quick',
      '/farms/{id}/details',
      '/farms/{id}/location',
      '/farms/{id}/submit',
      '/farms/{id}/pass',
      '/farms/{id}/verification',
      '/farms/{id}/kyc/aadhaar/otp',
      '/farms/{id}/kyc/gstin/verify',
      '/farms/geo/pincodes/{pin}',
      '/admin/farms',
      '/admin/farms/{id}/suspend',
      '/admin/farms/review-queue',
      '/admin/farms/review-cases/{caseId}/decision',
      '/admin/farms/{id}/kyc/documents/{docId}/decision',
      '/admin/farms/geo/pincodes/{pin}',
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths.some((p) => p.startsWith('/internal'))).toBe(false);
    expect(spec.paths['/admin/farms/{id}/suspend']?.post?.description).toContain(
      'customers.suspend',
    );
    expect(spec.paths['/farms/verify/{farmCode}']?.get?.security).toBeUndefined();
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['Farm', 'FarmPass', 'DuplicateCase', 'KycDocument', 'PinCodeInfo']),
    );
  });
});
