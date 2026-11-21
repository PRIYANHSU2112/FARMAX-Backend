import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  type OrderView,
  app,
  buyerWithCart,
  checkout,
  data,
  inventory,
  payment,
  reason,
  startOrdersApp,
  wallet,
} from './orders.harness.js';

/** Orders of one buyer in the DB (a refused wallet checkout must create nothing). */
const ordersOf = (userId: string) =>
  app.diContainer.resolve('db').order.count({ where: { userId } });

describe.skipIf(DB_URL === undefined)('wallet checkout (D-54, fake wallet / payment)', () => {
  beforeAll(async () => {
    await startOrdersApp();
    inventory.mode = 'ok';
  });

  afterAll(async () => {
    await app.close();
  });

  it('WALLET with enough balance: order placed, payment created with method WALLET', async () => {
    const b = await buyerWithCart();
    wallet.balances.set(b.user, { balancePaise: 20_000, status: 'ACTIVE' }); // order total ₹200
    const res = await checkout(b, `chk-${randomUUID()}`, 'WALLET');
    expect(res.statusCode, res.body).toBe(201);
    const { order } = data<{ order: OrderView & { paymentMethod: string } }>(res);
    expect(order.paymentMethod).toBe('WALLET');
    expect(payment.methods.get(order.id)).toBe('WALLET');
  });

  it('WALLET short by ₹0.01: 409 INSUFFICIENT_WALLET_BALANCE, nothing created', async () => {
    const b = await buyerWithCart();
    wallet.balances.set(b.user, { balancePaise: 19_999, status: 'ACTIVE' });
    const res = await checkout(b, `chk-${randomUUID()}`, 'WALLET');
    expect(res.statusCode).toBe(409);
    expect(reason(res)).toMatchObject({ reason: 'INSUFFICIENT_WALLET_BALANCE' });
    expect(res.json<{ error: { details: object } }>().error.details).toMatchObject({
      balancePaise: 19_999,
      requiredPaise: 20_000,
      shortPaise: 1,
    });
    expect(await ordersOf(b.user)).toBe(0);
  });

  it('WALLET on a frozen wallet: 409 WALLET_FROZEN, nothing created', async () => {
    const b = await buyerWithCart();
    wallet.balances.set(b.user, { balancePaise: 1_000_000, status: 'FROZEN' });
    const res = await checkout(b, `chk-${randomUUID()}`, 'WALLET');
    expect(reason(res)).toMatchObject({ reason: 'WALLET_FROZEN' });
    expect(await ordersOf(b.user)).toBe(0);
  });

  it('ONLINE is the default and never asks the wallet', async () => {
    const b = await buyerWithCart();
    const res = await checkout(b);
    expect(res.statusCode, res.body).toBe(201);
    const { order } = data<{ order: OrderView & { paymentMethod: string } }>(res);
    expect(order.paymentMethod).toBe('ONLINE');
    expect(payment.methods.get(order.id)).toBe('ONLINE');
  });
});
