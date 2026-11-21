import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  customer,
  data,
  deliver,
  errorOf,
  ledgerOf,
  payments,
  post,
} from './harness.js';

let app: FastifyInstance;
const db = () => app.diContainer.resolve('db');
const rewards = () => app.diContainer.resolve('rewardsService');

interface Summary {
  availablePts: number;
  valuePaise: number;
  pendingPts: number;
  debtPts: number;
  lifetimeEarned: number;
  expiringSoon: { points: number };
  conversion: { eligible: boolean };
}

const summary = async (user: string) => data<Summary>(await call(app, 'GET', '/rewards', { user }));

/** F1 says the order was delivered and the buyer finally paid `netPaidPaise`. */
const delivered = (userId: string, netPaidPaise: number, orderId: string = randomUUID()) =>
  deliver(app, 'order.delivered.v1', {
    orderId,
    orderNo: `ORD-26-${orderId.slice(0, 7)}`,
    userId,
    deliveredAt: new Date().toISOString(),
    lines: [],
    netPaidPaise,
  }).then(() => orderId);

const refunded = (orderId: string, amountPaise: number, refundId: string = randomUUID()) =>
  deliver(app, 'payment.refund_processed.v1', {
    refundId,
    sourceRef: `cancel:${refundId}`,
    paymentId: randomUUID(),
    orderId,
    amountPaise,
    arn: null,
    refundedPaise: amountPaise,
    capturedPaise: amountPaise,
  });

/** Ends the hold of every PENDING lot of the customer, then runs the maturing job. */
const mature = async (userId: string) => {
  await db().pointsLot.updateMany({
    where: { userId, status: 'PENDING' },
    data: { availableAt: new Date(Date.now() - 1_000) },
  });
  await rewards().matureDue();
};

/** `points` AVAILABLE for a new customer (earn on ₹points×10, then mature). */
const withPoints = async (points: number) => {
  const user = customer();
  await delivered(user, points * 1_000);
  await mature(user);
  return user;
};

const convert = (user: string, points: number, key = `cv-${randomUUID()}`) =>
  call(app, 'POST', '/rewards/convert', {
    user,
    payload: { points },
    headers: { 'idempotency-key': key },
  });

/** The DB view of one customer's points: buckets vs. what the postings and lots say. */
const pointsLedger = async (userId: string) => {
  const a = await db().pointsAccount.findUniqueOrThrow({ where: { userId } });
  const sums = await db().pointsPosting.groupBy({
    by: ['bucket'],
    where: { accountId: a.id },
    _sum: { points: true },
  });
  const sum = (b: string) => sums.find((s) => s.bucket === b)?._sum.points ?? 0n;
  const lots = await db().pointsLot.aggregate({
    where: { userId, status: 'AVAILABLE' },
    _sum: { remainingPts: true },
  });
  return {
    available: a.availablePts,
    pending: a.pendingPts,
    debt: a.debtPts,
    postingsAvailable: sum('AVAILABLE'),
    postingsPending: sum('PENDING'),
    postingsDebt: -sum('DEBT'),
    lotsAvailable: lots._sum.remainingPts ?? 0n,
  };
};

const expectConsistent = async (userId: string) => {
  const l = await pointsLedger(userId);
  expect(l.available).toBe(l.postingsAvailable);
  expect(l.pending).toBe(l.postingsPending);
  expect(l.debt).toBe(l.postingsDebt);
  expect(l.available).toBe(l.lotsAvailable);
  return l;
};

describe.skipIf(DB_URL === undefined)('reward points against Postgres (D-54 W4)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    payments.down = false;
  });

  afterAll(async () => {
    await app.close();
  });

  it('delivered order → PENDING points (1 per ₹10), once per order; hold over → AVAILABLE', async () => {
    const user = customer();
    const orderId = await delivered(user, 4_805_000); // ₹48,050
    await delivered(user, 4_805_000, orderId); // redelivered event
    expect(await summary(user)).toMatchObject({
      availablePts: 0,
      pendingPts: 4_805,
      lifetimeEarned: 4_805,
    });
    await mature(user);
    expect(await summary(user)).toMatchObject({
      availablePts: 4_805,
      valuePaise: 48_050,
      pendingPts: 0,
      conversion: { eligible: true },
    });
    const ledger = data<{ kind: string; deltaPts: number; availableAfter: number }[]>(
      await call(app, 'GET', '/rewards/ledger', { user }),
    );
    expect(ledger.map((e) => [e.kind, e.deltaPts, e.availableAfter])).toEqual([
      ['MATURE', 0, 4_805],
      ['EARN', 4_805, 0],
    ]);
    await expectConsistent(user);
  });

  it('convert: points → wallet in one transaction; replay; key reuse; rules', async () => {
    const user = await withPoints(6_000);
    const key = `cv-${randomUUID()}`;
    const res = await convert(user, 5_000, key);
    expect(res.statusCode, res.body).toBe(200);
    expect(data(res)).toMatchObject({
      points: 5_000,
      creditedPaise: 50_000,
      availablePtsAfter: 1_000,
      walletBalanceAfterPaise: 50_000,
      replayed: false,
    });
    expect(data(await convert(user, 5_000, key))).toMatchObject({ replayed: true });
    expect(errorOf(await convert(user, 1_000, key)).details?.reason).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(errorOf(await convert(user, 2_000)).details?.reason).toBe('INSUFFICIENT_POINTS');
    // (5 conversions per minute per customer: the step rules on another customer)
    const other = customer();
    expect(errorOf(await convert(other, 900)).details?.reason).toBe('BELOW_MINIMUM');
    expect(errorOf(await convert(other, 1_050)).details?.reason).toBe('NOT_A_MULTIPLE');

    const wallet = await db().walletJournal.findFirstOrThrow({
      where: { userId: user, kind: 'POINTS_CONVERSION' },
    });
    expect(wallet).toMatchObject({
      category: 'REWARDS',
      title: 'Points Redeemed to Cash',
      subtitle: '5000 Pts',
      amountPaise: 50_000n,
    });
    expect(await ledgerOf(app, user)).toMatchObject({ balance: 50_000n, unbalanced: 0 });
    await expectConsistent(user);
  });

  it('10 parallel conversions of 1,000 against 3,000 points: exactly 3 land', async () => {
    const user = await withPoints(3_000);
    const results = await Promise.all(Array.from({ length: 10 }, () => convert(user, 1_000)));
    // 5 per minute rate limit: the rest answer 429 before touching the ledger.
    const ok = results.filter((r) => r.statusCode === 200);
    const refused = results.filter((r) => errorOf(r).details?.reason === 'INSUFFICIENT_POINTS');
    const limited = results.filter((r) => r.statusCode === 429);
    expect(ok).toHaveLength(3);
    expect(ok.length + refused.length + limited.length).toBe(10);
    expect((await ledgerOf(app, user)).balance).toBe(30_000n);
    expect((await expectConsistent(user)).available).toBe(0n);
  }, 30_000);

  it('spends the soonest-expiring points first', async () => {
    const user = customer();
    const late = await delivered(user, 1_000_000); // 1,000 pts
    const early = await delivered(user, 1_000_000);
    await mature(user);
    await db().pointsLot.update({
      where: { sourceType_sourceRef: { sourceType: 'ORDER', sourceRef: early } },
      data: { expiresAt: new Date(Date.now() + 86_400_000) },
    });
    expect((await convert(user, 1_000)).statusCode).toBe(200);
    const lots = await db().pointsLot.findMany({ where: { userId: user } });
    const by = (ref: string) => lots.find((l) => l.sourceRef === ref);
    expect(by(early)).toMatchObject({ remainingPts: 0n, status: 'EXHAUSTED' });
    expect(by(late)).toMatchObject({ remainingPts: 1_000n, status: 'AVAILABLE' });
  });

  it('expiry: one notice, then the remaining points expire', async () => {
    const user = await withPoints(1_200);
    await db().pointsLot.updateMany({
      where: { userId: user },
      data: { expiresAt: new Date(Date.now() + 2 * 86_400_000) },
    });
    await rewards().noticeDue();
    await rewards().noticeDue();
    const notices = await db().outboxEvent.findMany({ where: { type: 'points.expiring_soon.v1' } });
    expect(notices.filter((n) => JSON.stringify(n.payload).includes(user))).toHaveLength(1);
    expect((await summary(user)).expiringSoon.points).toBe(1_200);

    await db().pointsLot.updateMany({
      where: { userId: user },
      data: {
        availableAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    await rewards().expireDue();
    expect(await summary(user)).toMatchObject({ availablePts: 0 });
    const kinds = await db().pointsJournal.findMany({
      where: { userId: user },
      select: { kind: true },
    });
    expect(kinds.map((k) => k.kind)).toContain('EXPIRE');
    await expectConsistent(user);
  });

  it('refund reversal: pro-rata from the pending lot, once per refund', async () => {
    const user = customer();
    const orderId = await delivered(user, 1_000_000); // 1,000 pts pending
    const refundId = randomUUID();
    await refunded(orderId, 500_000, refundId); // half
    await refunded(orderId, 500_000, refundId); // redelivered
    expect(await summary(user)).toMatchObject({ pendingPts: 500, debtPts: 0 });
    await refunded(orderId, 500_000); // the rest
    const lot = await db().pointsLot.findUniqueOrThrow({
      where: { sourceType_sourceRef: { sourceType: 'ORDER', sourceRef: orderId } },
    });
    expect(lot).toMatchObject({ remainingPts: 0n, reversedPts: 1_000n, status: 'REVERSED' });
    expect((await summary(user)).pendingPts).toBe(0);
    await expectConsistent(user);
  });

  it('points already converted, then refunded → DEBT; the next earn settles it first', async () => {
    const user = customer();
    const orderId = await delivered(user, 1_000_000);
    await mature(user);
    expect((await convert(user, 1_000)).statusCode).toBe(200);
    await refunded(orderId, 1_000_000);
    expect(await summary(user)).toMatchObject({ availablePts: 0, debtPts: 1_000 });

    await delivered(user, 1_500_000); // 1,500 pts: 1,000 settle the debt, 500 pending
    expect(await summary(user)).toMatchObject({ debtPts: 0, pendingPts: 500 });
    await expectConsistent(user);
  });

  it('first UPI top-up cashback is credited as points at once (CREDITED); the sweep is idempotent', async () => {
    const user = customer();
    const res = await call(app, 'POST', '/wallet/topups', {
      user,
      payload: { amountPaise: 1_000_000, method: 'UPI' },
      headers: { 'idempotency-key': `k-${randomUUID()}` },
    });
    const { topup } = data<{ topup: { id: string } }>(res);
    const p = payments.capture(topup.id);
    await deliver(app, 'payment.topup_captured.v1', {
      paymentId: p.id,
      paymentNo: p.paymentNo,
      topupId: topup.id,
      userId: user,
      amountPaise: p.capturedPaise,
      expectedPaise: p.amountPaise,
      currency: 'INR',
      method: 'upi',
      bank: null,
      cardLast4: null,
      cardNetwork: null,
      vpaMasked: 've***@okhdfc',
      providerPaymentId: 'pay_x',
    });
    const view = data<{ cashback: { points: number; status: string } }>(
      await call(app, 'GET', `/wallet/topups/${topup.id}`, { user }),
    );
    expect(view.cashback).toEqual({ paise: 5_000, points: 500, status: 'CREDITED' });
    expect((await summary(user)).availablePts).toBe(500);

    // A crash between grant and flag (simulated): the sweep must not grant twice.
    await db().walletTopup.update({ where: { id: topup.id }, data: { cashbackGrantedAt: null } });
    await app.diContainer.resolve('topupsService').grantPendingCashback();
    expect((await summary(user)).availablePts).toBe(500);
    await expectConsistent(user);
  });

  it('a conversion racing a wallet checkout debit: both serialise, nothing is lost', async () => {
    const user = await withPoints(2_000);
    await post(app, { userId: user, amountPaise: 10_000n }); // ₹100
    const [conv, debit] = await Promise.all([
      convert(user, 2_000),
      call(app, 'POST', '/internal/wallet/debits', {
        internal: true,
        payload: {
          paymentId: randomUUID(),
          userId: user,
          orderId: randomUUID(),
          orderNo: 'ORD-26-RACE001',
          amountPaise: 25_000, // ₹250: only fits after the conversion
        },
      }),
    ]);
    expect(conv.statusCode).toBe(200);
    expect([200, 409]).toContain(debit.statusCode);
    const expected = debit.statusCode === 200 ? 10_000n + 20_000n - 25_000n : 30_000n;
    expect(await ledgerOf(app, user)).toMatchObject({ balance: expected, unbalanced: 0 });
    await expectConsistent(user);
  });

  it('the database refuses a bucket that does not match its postings', async () => {
    const user = await withPoints(1_000);
    await expect(
      db().pointsAccount.update({ where: { userId: user }, data: { availablePts: 999_999n } }),
    ).rejects.toThrow(/does not match its ledger/);
    const j = await db().pointsJournal.findFirstOrThrow({ where: { userId: user } });
    await expect(
      db().pointsJournal.update({ where: { id: j.id }, data: { title: 'edited' } }),
    ).rejects.toThrow();
  });
});
