import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB_URL, buildTestApp, call, customer, data, errorOf, ledgerOf, post } from './harness.js';

let app: FastifyInstance;

interface Debit {
  status: string;
  journalNo: string | null;
  amountPaise: number;
  refundedPaise: number;
  balanceAfterPaise: number | null;
  replayed: boolean;
}

const debit = (userId: string, amountPaise: number, paymentId: string = randomUUID()) =>
  call(app, 'POST', '/internal/wallet/debits', {
    internal: true,
    payload: { paymentId, userId, orderId: randomUUID(), orderNo: 'ORD-26-0091857', amountPaise },
  });

const credit = (
  userId: string,
  paymentId: string,
  amountPaise: number,
  refundId: string = randomUUID(),
) =>
  call(app, 'POST', '/internal/wallet/credits', {
    internal: true,
    payload: { refundId, paymentId, userId, amountPaise, reason: 'Cold Box Damage Refund' },
  });

describe.skipIf(DB_URL === undefined)('orders paid from the wallet (internal, D-54)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('internal routes need the service token', async () => {
    const res = await call(app, 'GET', `/internal/wallet/balance/${randomUUID()}`);
    expect([401, 403]).toContain(res.statusCode);
  });

  it('debit: once per payment ("Used at Checkout"), replay moves nothing', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 300_000n });
    const paymentId = randomUUID();
    const first = data<Debit>(await debit(user, 125_000, paymentId));
    expect(first).toMatchObject({ status: 'DEBITED', balanceAfterPaise: 175_000, replayed: false });
    const again = data<Debit>(await debit(user, 125_000, paymentId));
    expect(again).toMatchObject({ journalNo: first.journalNo, replayed: true });
    expect((await ledgerOf(app, user)).balance).toBe(175_000n);

    const journal = await app.diContainer
      .resolve('db')
      .walletJournal.findUniqueOrThrow({ where: { idempotencyKey: `pay:${paymentId}` } });
    expect(journal).toMatchObject({
      kind: 'ORDER_DEBIT',
      category: 'PURCHASES',
      title: 'Used at Checkout',
      subtitle: 'ORD-26-0091857',
    });

    const status = data<Debit>(
      await call(app, 'GET', `/internal/wallet/debits/${paymentId}`, { internal: true }),
    );
    expect(status).toMatchObject({ status: 'DEBITED', amountPaise: 125_000, refundedPaise: 0 });
    const none = data<Debit>(
      await call(app, 'GET', `/internal/wallet/debits/${randomUUID()}`, { internal: true }),
    );
    expect(none.status).toBe('NONE');
  });

  it('debit above the balance: 409 INSUFFICIENT_BALANCE; frozen: 409 ACCOUNT_FROZEN', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 1_000n });
    const short = await debit(user, 1_001);
    expect(short.statusCode).toBe(409);
    expect(errorOf(short).details?.reason).toBe('INSUFFICIENT_BALANCE');

    await app.diContainer
      .resolve('db')
      .walletAccount.update({ where: { userId: user }, data: { status: 'FROZEN' } });
    expect(errorOf(await debit(user, 10)).details?.reason).toBe('ACCOUNT_FROZEN');
    const bal = data<{ balancePaise: number; status: string }>(
      await call(app, 'GET', `/internal/wallet/balance/${user}`, { internal: true }),
    );
    expect(bal).toEqual({ userId: user, balancePaise: 1_000, status: 'FROZEN' });
  });

  it('20 parallel checkouts against a balance for 5: exactly 5 orders are paid', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 500_000n });
    const results = await Promise.all(Array.from({ length: 20 }, () => debit(user, 100_000)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(
      results.filter((r) => errorOf(r).details?.reason === 'INSUFFICIENT_BALANCE'),
    ).toHaveLength(15);
    expect(await ledgerOf(app, user)).toMatchObject({
      balance: 0n,
      postingsSum: 0n,
      unbalanced: 0,
    });
  }, 30_000);

  it('refunds: partial + rest land in the wallet; never above the debit; replay is safe', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 200_000n });
    const paymentId = randomUUID();
    await debit(user, 150_000, paymentId);

    const refundId = randomUUID();
    const r1 = await credit(user, paymentId, 100_000, refundId);
    expect(data<{ balanceAfterPaise: number }>(r1).balanceAfterPaise).toBe(150_000);
    const replay = data<{ replayed: boolean }>(await credit(user, paymentId, 100_000, refundId));
    expect(replay.replayed).toBe(true);

    const over = await credit(user, paymentId, 50_001);
    expect(errorOf(over).details).toMatchObject({
      reason: 'EXCEEDS_DEBIT',
      debitedPaise: 150_000,
      refundedPaise: 100_000,
    });
    expect((await credit(user, paymentId, 50_000)).statusCode).toBe(200);
    expect((await ledgerOf(app, user)).balance).toBe(200_000n);

    const status = data<Debit>(
      await call(app, 'GET', `/internal/wallet/debits/${paymentId}`, { internal: true }),
    );
    expect(status.refundedPaise).toBe(150_000);
  });

  it('20 parallel refunds of ₹1,000 on a ₹10,000 wallet payment: exactly 10 land', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 1_000_000n });
    const paymentId = randomUUID();
    await debit(user, 1_000_000, paymentId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => credit(user, paymentId, 100_000)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(results.filter((r) => errorOf(r).details?.reason === 'EXCEEDS_DEBIT')).toHaveLength(10);
    expect(await ledgerOf(app, user)).toMatchObject({ balance: 1_000_000n, unbalanced: 0 });
  }, 30_000);

  it('a refund needs a wallet debit of the same customer', async () => {
    const user = customer();
    expect(errorOf(await credit(user, randomUUID(), 100)).details?.reason).toBe('NO_WALLET_DEBIT');
    await post(app, { userId: user, amountPaise: 10_000n });
    const paymentId = randomUUID();
    await debit(user, 5_000, paymentId);
    expect(errorOf(await credit(customer(), paymentId, 100)).details?.reason).toBe('USER_MISMATCH');
  });
});
