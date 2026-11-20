import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * Against a REAL Postgres with the order migration applied (local dev DB, never Neon):
 *   ORDER_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/order-service test
 * Skipped when the variable is not set. Redis, permissions and token verification are stubbed.
 */
const DB_URL = process.env.ORDER_IT_DATABASE_URL;

const user = (id: string, userType: 'INTERNAL' | 'CUSTOMER') =>
  ({
    id,
    sessionId: 's',
    jti: 'j',
    userType,
    roles: [],
    scope: 'full',
    expiresAt: 0,
  }) as unknown as AuthUser;

const staff = user(randomUUID(), 'INTERNAL');
const owner = user(randomUUID(), 'CUSTOMER');
const stranger = user(randomUUID(), 'CUSTOMER');
const farmId = randomUUID();
const vaccine = randomUUID();
const disinfectant = randomUUID();
const catVaccines = randomUUID();
const catBio = randomUUID();
const suffix = randomUUID().slice(0, 6).toUpperCase();
const CODE = `SHED${suffix}`;
const auth = { authorization: 'Bearer t' };

let app: FastifyInstance;
let caller: AuthUser = staff;
const created: string[] = [];

const envelope = (type: string, data: object, occurredAt = new Date()): EventEnvelope => ({
  id: randomUUID(),
  type,
  version: 1,
  occurredAt: occurredAt.toISOString(),
  source: 'test',
  correlationId: 'it',
  data,
});

const deliver = async (event: EventEnvelope) => {
  const handlers = app.diContainer.resolve('projectionEventHandlers');
  const handler = handlers[event.type];
  if (handler === undefined) throw new Error(`no handler for ${event.type}`);
  await app.diContainer.resolve('runInTransaction')((tx) => handler(event, tx));
};

const farmFacts = (version: number, gstin: string | null) => ({
  farmId,
  farmCode: 'FX-WG-L-00418',
  ownerUserId: owner.id,
  name: 'Sri Lakshmi Poultry',
  category: 'POULTRY_FARM',
  productionTypes: ['LAYER'],
  gstin,
  stateCode: '37',
  territoryCode: 'WG',
  pinCode: '534211',
  status: 'ACTIVE',
  version,
});

const variantFacts = (
  variantId: string,
  categoryId: string,
  name: string,
  temperatureClass: string,
  gstRate: string,
) => ({
  variantId,
  productId: variantId,
  sku: `IT-${variantId.slice(0, 8)}`,
  barcode: null,
  productName: name,
  variantName: '1 unit',
  manufacturerName: null,
  packSize: '1',
  packUnit: 'PCS',
  isPrescriptionRequired: false,
  temperatureClass,
  shelfLifeMonths: null,
  isActive: true,
  categoryId,
  categoryPath: [categoryId],
  brandId: randomUUID(),
  hsnCode: '3002',
  gstRate,
  version: 1,
});

describe.skipIf(DB_URL === undefined)('order-service against Postgres', () => {
  beforeAll(async () => {
    app = await buildApp({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: DB_URL });
    app.diContainer.register({
      redis: asValue({
        eval: () => Promise.reject(new Error('down')),
        mget: () => Promise.resolve([null, null]),
      } as never),
      accessClient: asValue({ hasPermission: () => Promise.resolve(true) } as never),
      tokenVerifier: asValue(() => Promise.resolve(caller)),
    });
    await app.ready();

    // Projections through the real event handlers. [R4] the older farm snapshot (v2, gstin null)
    // arrives AFTER v3 and must be ignored.
    await deliver(envelope('farm.facts_changed.v1', farmFacts(3, '37ABCDE1234F1Z5')));
    await deliver(envelope('farm.facts_changed.v1', farmFacts(2, null)));
    await deliver(
      envelope(
        'product.variant_created.v1',
        variantFacts(vaccine, catVaccines, 'ND Lasota', 'CC_REF', '5.00'),
      ),
    );
    await deliver(
      envelope(
        'product.variant_created.v1',
        variantFacts(disinfectant, catBio, 'Virkon S', 'AMB', '18.00'),
      ),
    );
    await deliver(
      envelope('pricing.price_changed.v1', {
        variantId: vaccine,
        sellingPrice: '8400.00',
        currency: 'INR',
        effectiveFrom: new Date().toISOString(),
        sequence: 2,
      }),
    );
    // Older price (sequence 1) after the newer one → ignored.
    await deliver(
      envelope('pricing.price_changed.v1', {
        variantId: vaccine,
        sellingPrice: '1.00',
        currency: 'INR',
        effectiveFrom: new Date().toISOString(),
        sequence: 1,
      }),
    );
    await deliver(
      envelope('pricing.price_changed.v1', {
        variantId: disinfectant,
        sellingPrice: '5200.00',
        currency: 'INR',
        effectiveFrom: new Date().toISOString(),
        sequence: 1,
      }),
    );
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.promotion.deleteMany({ where: { id: { in: created } } });
    await db.orderVariantProjection.deleteMany({
      where: { variantId: { in: [vaccine, disinfectant] } },
    });
    await db.orderFarmProjection.deleteMany({ where: { farmId } });
    await app.close();
  });

  it('[R4] projections keep the newest snapshot', async () => {
    const farm = await app.diContainer.resolve('projectionsService').farm(farmId);
    expect(farm?.gstin).toBe('37ABCDE1234F1Z5');
    const [v] = await app.diContainer.resolve('projectionsService').variants([vaccine]);
    expect(v?.sellingPrice).toBe('8400.00');
  });

  it('admin creates a DRAFT coupon, activates it; the same code in another case → 409 [R1]', async () => {
    caller = staff;
    const body = {
      code: CODE.toLowerCase(),
      title: '₹500 off biosecurity over ₹10,000',
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      flatAmount: 500,
      freeShipping: true,
      scope: 'CATEGORY',
      targets: [{ targetType: 'CATEGORY', targetId: catBio }],
      rules: [{ ruleType: 'PRODUCTION_TYPE', value: 'layer' }],
      minOrderAmount: 10_000,
      perFarmLimit: 1,
      isStackable: true,
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/admin/promotions',
      headers: auth,
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const promo = res.json<{
      data: { id: string; code: string; status: string; rules: { value: string }[] };
    }>().data;
    created.push(promo.id);
    expect(promo).toMatchObject({ code: CODE, status: 'DRAFT', rules: [{ value: 'LAYER' }] });

    const dup = await app.inject({
      method: 'POST',
      url: '/admin/promotions',
      headers: auth,
      payload: { ...body, code: ` ${CODE} ` },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'PROMO_CODE_TAKEN',
    );

    const act = await app.inject({
      method: 'POST',
      url: `/admin/promotions/${promo.id}/status`,
      headers: auth,
      payload: { to: 'ACTIVE', reason: 'Monsoon campaign approved' },
    });
    expect(act.statusCode).toBe(200);
    expect(
      act.json<{ data: { status: string; usage: { usedCount: number } } }>().data,
    ).toMatchObject({ status: 'ACTIVE', usage: { usedCount: 0 } });

    const locked = await app.inject({
      method: 'PATCH',
      url: `/admin/promotions/${promo.id}`,
      headers: auth,
      payload: { version: 1, flatAmount: 600 },
    });
    expect(locked.statusCode).toBe(422);
  });

  it('usedCount and status are not accepted in a PATCH body', async () => {
    caller = staff;
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/promotions/${created[0] ?? ''}`,
      headers: auth,
      payload: { version: 1, usedCount: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('owner previews the cart with the coupon: invoice ties out', async () => {
    caller = owner;
    const res = await app.inject({
      method: 'POST',
      url: '/orders/preview',
      headers: auth,
      payload: {
        farmId,
        lines: [
          { variantId: disinfectant, qty: 2 },
          { variantId: vaccine, qty: 2 },
        ],
        couponCode: CODE.toLowerCase(),
        paymentMethod: 'UPI',
        billToGst: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: {
        couponStatus: { applied: boolean };
        invoice: Record<string, string>;
        billing: { itcEligible: boolean };
      };
    }>().data;
    expect(data.couponStatus.applied).toBe(true);
    expect(data.billing.itcEligible).toBe(true);
    expect(data.invoice).toMatchObject({
      itemSubtotal: '27200.00',
      couponDiscount: '500.00',
      freight: '495.00',
      freightDiscount: '495.00',
    });
  });

  it('offers: the new coupon is applied for the owner', async () => {
    caller = owner;
    const res = await app.inject({
      method: 'POST',
      url: '/orders/offers',
      headers: auth,
      payload: {
        farmId,
        lines: [
          { variantId: disinfectant, qty: 2 },
          { variantId: vaccine, qty: 2 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: { applied: { code: string } | null; alsoEligible: { code: string }[] };
    }>().data;
    const codes = [data.applied?.code, ...data.alsoEligible.map((o) => o.code)];
    expect(codes).toContain(CODE);
  });

  it("[R5] another customer's farm → 404", async () => {
    caller = stranger;
    const res = await app.inject({
      method: 'POST',
      url: '/orders/preview',
      headers: auth,
      payload: { farmId, lines: [{ variantId: vaccine, qty: 1 }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('an unknown variant → 422 VARIANT_NOT_SELLABLE', async () => {
    caller = owner;
    const res = await app.inject({
      method: 'POST',
      url: '/orders/preview',
      headers: auth,
      payload: { farmId, lines: [{ variantId: randomUUID(), qty: 1 }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'VARIANT_NOT_SELLABLE',
    );
  });

  it('staff cannot call the customer preview; customers cannot call admin', async () => {
    caller = staff;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/orders/offers',
          headers: auth,
          payload: { farmId, lines: [{ variantId: vaccine, qty: 1 }] },
        })
      ).statusCode,
    ).toBe(403);
    caller = owner;
    expect(
      (await app.inject({ method: 'GET', url: '/admin/promotions', headers: auth })).statusCode,
    ).toBe(403);
  });
});
