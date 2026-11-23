import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  deliver,
  newVariant,
  newWarehouse,
  randomPin,
  receive,
  staff,
} from './harness.js';

/** GET /internal/inventory/warehouse-stats (warehouse-service W2 numbers, D-56 P3). */
let app: FastifyInstance;
const boss = staff('inventory.view', 'inventory.configure', 'inventory.receive');

interface Stats {
  warehouseId: string;
  onHand: number;
  usedKg: string;
  unweighedSkus: number;
  weightKnownPct: number;
  categories: { rootCategoryId: string | null; onHand: number }[];
}

describe.skipIf(DB_URL === undefined)('warehouse stats against Postgres', () => {
  let w: string;
  const root = randomUUID();

  beforeAll(async () => {
    app = await buildTestApp();
    w = await newWarehouse(app, boss, randomPin());
    const feed = randomUUID();
    await deliver(app, 'product.variant_created.v1', {
      variantId: feed,
      productId: randomUUID(),
      sku: `IT-${feed.slice(0, 8)}`,
      productName: 'Layer feed',
      variantName: '25 kg',
      temperatureClass: 'AMB',
      isActive: true,
      categoryId: randomUUID(),
      categoryPath: [root, randomUUID()],
      weightGrams: 25_000,
      version: 1,
    });
    const noWeight = await newVariant(app);
    await receive(app, boss, w, [
      { variantId: feed, qty: 4 },
      { variantId: noWeight, qty: 1 },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('needs the internal service token', async () => {
    const res = await call(app, 'GET', '/internal/inventory/warehouse-stats', {});
    expect(res.statusCode).toBe(401);
  });

  it('returns kg from pack weights and stock by root category', async () => {
    const res = await call(app, 'GET', '/internal/inventory/warehouse-stats', { internal: true });
    expect(res.statusCode, res.body).toBe(200);
    const mine = data<Stats[]>(res).find((s) => s.warehouseId === w);
    expect(mine).toMatchObject({
      onHand: 5,
      usedKg: '100.00',
      unweighedSkus: 1,
      weightKnownPct: 80,
    });
    expect(mine?.categories).toContainEqual(
      expect.objectContaining({ rootCategoryId: root, onHand: 4 }),
    );
  });
});
