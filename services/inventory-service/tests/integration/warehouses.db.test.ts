import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  errorOf,
  randomCode,
  randomPin,
  staff,
} from './harness.js';

interface Warehouse {
  id: string;
  code: string;
  version: number;
  isActive: boolean;
  priority: number;
}

let app: FastifyInstance;
const created: string[] = [];
const configurer = staff('inventory.view', 'inventory.configure');
const viewer = staff('inventory.view');

const newWarehouse = async (overrides: object = {}) => {
  const res = await call(app, 'POST', '/admin/inventory/warehouses', {
    user: configurer,
    payload: {
      code: randomCode('it').toLowerCase(),
      name: 'IT Warehouse',
      type: 'DEPOT',
      addressLine: 'Plot 1, Test Estate',
      city: 'Tanuku',
      stateCode: '37',
      pinCode: '534211',
      ...overrides,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const w = data<Warehouse>(res);
  created.push(w.id);
  return w;
};

describe.skipIf(DB_URL === undefined)('warehouses + settings against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.warehouse.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it('creates a warehouse with an UPPERCASE code and refuses a duplicate', async () => {
    const w = await newWarehouse();
    expect(w.code).toBe(w.code.toUpperCase());
    expect(w.version).toBe(0);
    const dup = await call(app, 'POST', '/admin/inventory/warehouses', {
      user: configurer,
      payload: {
        code: w.code,
        name: 'Dup',
        type: 'DEPOT',
        addressLine: 'Plot 2, Test',
        city: 'Tanuku',
        stateCode: '37',
        pinCode: '534211',
      },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('denies writes without inventory.configure and every call without a token', async () => {
    // Body validation runs before the auth preHandler (Fastify order), so send a valid body.
    const res = await call(app, 'POST', '/admin/inventory/warehouses', {
      user: viewer,
      payload: {
        code: randomCode('it'),
        name: 'Viewer cannot',
        type: 'DEPOT',
        addressLine: 'Plot 3, Test',
        city: 'Tanuku',
        stateCode: '37',
        pinCode: '534211',
      },
    });
    expect(res.statusCode).toBe(403);
    expect((await call(app, 'GET', '/admin/inventory/warehouses')).statusCode).toBe(401);
  });

  it('edits with expectedVersion and rejects a stale version', async () => {
    const w = await newWarehouse();
    const ok = await call(app, 'PATCH', `/admin/inventory/warehouses/${w.id}`, {
      user: configurer,
      payload: { expectedVersion: 0, priority: 5 },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<Warehouse>(ok)).toMatchObject({ priority: 5, version: 1 });
    const stale = await call(app, 'PATCH', `/admin/inventory/warehouses/${w.id}`, {
      user: configurer,
      payload: { expectedVersion: 0, priority: 6 },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).details?.reason).toBe('VERSION_CONFLICT');
  });

  it('replaces coverage and serves allocation candidates in priority order', async () => {
    const pin = randomPin();
    const a = await newWarehouse({ priority: 50 });
    const b = await newWarehouse({ priority: 10 });
    for (const [w, priority] of [
      [a, 10],
      [b, 20],
    ] as const) {
      const res = await call(app, 'PUT', `/admin/inventory/warehouses/${w.id}/coverage`, {
        user: configurer,
        payload: { expectedVersion: 0, entries: [{ pinCode: pin, priority }], reason: 'IT coverage' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(data<{ version: number }>(res).version).toBe(1);
    }
    const svc = app.diContainer.resolve('warehousesService');
    expect((await svc.candidatesForPin(pin)).map((c) => c.warehouseId)).toEqual([a.id, b.id]);

    // Deactivating b removes it at once (coverage cache version bumped).
    const off = await call(app, 'POST', `/admin/inventory/warehouses/${b.id}/status`, {
      user: configurer,
      payload: { expectedVersion: 1, isActive: false, reason: 'IT closed for audit' },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await svc.candidatesForPin(pin)).map((c) => c.warehouseId)).toEqual([a.id]);
  });

  it('rejects duplicate PINs in one coverage list', async () => {
    const w = await newWarehouse();
    const pin = randomPin();
    const res = await call(app, 'PUT', `/admin/inventory/warehouses/${w.id}/coverage`, {
      user: configurer,
      payload: {
        expectedVersion: 0,
        entries: [{ pinCode: pin }, { pinCode: pin }],
        reason: 'IT duplicate pins',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('reads settings and refuses an out-of-range TTL', async () => {
    const res = await call(app, 'GET', '/admin/inventory/settings', { user: viewer });
    expect(res.statusCode).toBe(200);
    expect(data(res)).toMatchObject({ reservationTtlSeconds: expect.any(Number) as number });
    const bad = await call(app, 'PATCH', '/admin/inventory/settings', {
      user: configurer,
      payload: { reservationTtlSeconds: 5, reason: 'IT too short a hold' },
    });
    expect(bad.statusCode).toBe(422);
  });
});
