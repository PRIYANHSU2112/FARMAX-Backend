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
const topups = () => app.diContainer.resolve('topupsService');

interface Topup {
  id: string;
  topupNo: string;
  status: string;
  paymentId: string | null;
  paymentNo: string | null;
  creditedPaise: number | null;
  balanceAfterPaise: number | null;
  instrument: string | null;
  cashback: { paise: number; points: number; status: string };
  failure: { code: string | null; reason: string | null; attempts: number } | null;
}
interface Created {
  topup: Topup;
  checkout: { paymentId: string; preferredMethod: string; amountPaise: number } | null;
}

const start = (user: string, body: object, key = `k-${randomUUID()}`) =>
  call(app, 'POST', '/wallet/topups', {
    user,
    payload: body,
    headers: { 'idempotency-key': key },
  });

const created = async (user: string, amountPaise = 1_000_000, method = 'UPI') => {
  const res = await start(user, { amountPaise, method });
  if (res.statusCode !== 200) throw new Error(res.body);
  return data<Created>(res);
};

const captured = (topupId: string, o: { amountPaise?: number; method?: string } = {}) => {
  const p = payments.capture(topupId, o);
  return deliver(app, 'payment.topup_captured.v1', {
    paymentId: p.id,
    paymentNo: p.paymentNo,
    topupId,
    userId: 'ignored-by-design',
    amountPaise: p.capturedPaise,
    expectedPaise: p.amountPaise,
    currency: 'INR',
    method: p.method,
    bank: p.bank,
    cardLast4: p.cardLast4,
    cardNetwork: p.cardNetwork,
    vpaMasked: p.vpaMasked,
    providerPaymentId: `pay_${p.id.slice(0, 8)}`,
  });
};

const view = async (user: string, id: string) => {
  const res = await call(app, 'GET', `/wallet/topups/${id}`, { user });
  if (res.statusCode !== 200) throw new Error(res.body);
  return data<Topup>(res);
};

/** Make a top-up look older and never checked (live-check / reconcile thresholds and order). */
const age = (id: string, ms: number) =>
  db().walletTopup.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - ms), updatedAt: new Date(Date.now() - 86_400_000) },
  });

describe.skipIf(DB_URL === undefined)(
  'wallet top-ups against Postgres (fake payment-service)',
  () => {
    beforeAll(async () => {
      app = await buildTestApp();
    });

    beforeEach(() => {
      payments.down = false;
    });

    afterAll(async () => {
      await app.close();
    });

    it('options: limits, chips, methods, first-top-up cashback offer', async () => {
      const res = await call(app, 'GET', '/wallet/topups/options', { user: customer() });
      expect(res.statusCode).toBe(200);
      expect(data(res)).toMatchObject({
        balancePaise: 0,
        minPaise: 10_000,
        maxPaise: 5_000_000,
        availablePaise: 5_000_000,
        presetsPaise: [50_000, 70_000, 90_000, 100_000, 200_000, 500_000],
        cashbackOffer: { eligible: true, method: 'UPI', percent: '10', maxPaise: 5_000 },
      });
    });

    it('start: Idempotency-Key required; same key replays; same key + other body → 422', async () => {
      const user = customer();
      const noKey = await call(app, 'POST', '/wallet/topups', {
        user,
        payload: { amountPaise: 50_000, method: 'UPI' },
      });
      expect(noKey.statusCode).toBe(400);

      const key = `k-${randomUUID()}`;
      const a = data<Created>(await start(user, { amountPaise: 50_000, method: 'UPI' }, key));
      expect(a.topup.status).toBe('PENDING');
      expect(a.checkout).toMatchObject({ preferredMethod: 'upi', amountPaise: 50_000 });
      const b = data<Created>(await start(user, { amountPaise: 50_000, method: 'UPI' }, key));
      expect(b.topup.id).toBe(a.topup.id);
      expect(b.checkout?.paymentId).toBe(a.checkout?.paymentId);

      const other = await start(user, { amountPaise: 60_000, method: 'UPI' }, key);
      expect(other.statusCode).toBe(422);
      expect(errorOf(other).details?.reason).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('limits: amount range, wallet cap, daily cap', async () => {
      const user = customer();
      const small = await start(user, { amountPaise: 9_999, method: 'UPI' });
      expect(errorOf(small).details?.reason).toBe('AMOUNT_OUT_OF_RANGE');

      const rich = customer();
      await post(app, { userId: rich, amountPaise: 19_600_000n }); // ₹1,96,000
      const over = await start(rich, { amountPaise: 500_000, method: 'UPI' });
      expect(over.statusCode).toBe(422);
      expect(errorOf(over).details).toMatchObject({
        reason: 'MAX_BALANCE_EXCEEDED',
        availablePaise: 400_000,
      });

      const daily = customer();
      await created(daily, 5_000_000);
      await created(daily, 5_000_000);
      const third = await start(daily, { amountPaise: 10_000, method: 'UPI' });
      expect(errorOf(third).details).toMatchObject({
        reason: 'DAILY_LIMIT_EXCEEDED',
        remainingPaise: 0,
      });
    });

    it('10 parallel starts against the daily cap: only what fits is accepted', async () => {
      const user = customer();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => start(user, { amountPaise: 1_500_000, method: 'UPI' })),
      );
      const reasons = results
        .filter((r) => r.statusCode !== 200)
        .map((r) => errorOf(r).details?.reason);
      // ₹1,00,000 / ₹15,000 → 6 fit, the 7th would cross the cap.
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(6);
      expect(reasons).toEqual(Array.from({ length: 4 }, () => 'DAILY_LIMIT_EXCEEDED'));
    }, 30_000);

    it('capture → COMPLETED: credited once, modal data, first UPI cashback (10%, max ₹50)', async () => {
      const user = customer();
      const { topup } = await created(user, 1_000_000);
      await captured(topup.id);
      await captured(topup.id); // redelivered / replayed event

      const t = await view(user, topup.id);
      expect(t).toMatchObject({
        status: 'COMPLETED',
        creditedPaise: 1_000_000,
        balanceAfterPaise: 1_000_000,
        instrument: 'UPI ve***@okhdfc',
        cashback: { paise: 5_000, points: 500, status: 'CREDITED' },
      });
      expect(t.paymentNo).toMatch(/^TXN-IT-/);
      expect(await ledgerOf(app, user)).toMatchObject({ balance: 1_000_000n, journals: 1 });

      // Second top-up: no cashback any more.
      const second = await created(user, 50_000);
      await captured(second.topup.id);
      expect((await view(user, second.topup.id)).cashback.points).toBe(0);

      const wallet = data<{ balancePaise: number; week: { creditsPaise: number } }>(
        await call(app, 'GET', '/wallet', { user }),
      );
      expect(wallet).toMatchObject({ balancePaise: 1_050_000, week: { creditsPaise: 1_050_000 } });
    });

    it('a card top-up earns no UPI cashback', async () => {
      const user = customer();
      const { topup } = await created(user, 200_000, 'CARD');
      await captured(topup.id, { method: 'card' });
      expect(await view(user, topup.id)).toMatchObject({
        status: 'COMPLETED',
        instrument: 'Visa (**4821)',
        cashback: { points: 0, status: 'NONE' },
      });
    });

    it('event, live check and job racing on one capture: exactly one credit', async () => {
      const user = customer();
      const { topup } = await created(user, 300_000);
      await age(topup.id, 3 * 60_000);
      payments.capture(topup.id);
      await Promise.all([
        captured(topup.id),
        captured(topup.id),
        view(user, topup.id),
        view(user, topup.id),
        topups().reconcile(),
      ]);
      expect(await ledgerOf(app, user)).toMatchObject({
        balance: 300_000n,
        postingsSum: 300_000n,
        journals: 1,
        unbalanced: 0,
      });
    }, 30_000);

    it('credits what the gateway captured, never what the client asked for', async () => {
      const user = customer();
      const { topup } = await created(user, 500_000);
      await captured(topup.id, { amountPaise: 499_900 });
      expect((await view(user, topup.id)).creditedPaise).toBe(499_900);
      expect((await ledgerOf(app, user)).balance).toBe(499_900n);
    });

    it('failed attempt → FAILED (retry allowed) → capture → COMPLETED', async () => {
      const user = customer();
      const { topup } = await created(user);
      const p = payments.fail(topup.id);
      await deliver(app, 'payment.topup_failed.v1', {
        paymentId: p.id,
        topupId: topup.id,
        userId: user,
        errorCode: 'BAD_REQUEST_ERROR',
        errorReason: 'Payment declined',
      });
      expect(await view(user, topup.id)).toMatchObject({
        status: 'FAILED',
        failure: { code: 'BAD_REQUEST_ERROR', attempts: 1 },
      });
      await captured(topup.id);
      expect((await view(user, topup.id)).status).toBe('COMPLETED');
    });

    it('expired, then a late capture: the money is still credited', async () => {
      const user = customer();
      const { topup } = await created(user, 100_000);
      const p = payments.expire(topup.id);
      await deliver(app, 'payment.topup_expired.v1', {
        paymentId: p.id,
        topupId: topup.id,
        userId: user,
      });
      expect((await view(user, topup.id)).status).toBe('EXPIRED');
      await captured(topup.id);
      expect((await view(user, topup.id)).status).toBe('COMPLETED');
      expect((await ledgerOf(app, user)).balance).toBe(100_000n);
    });

    it('an outcome for another payment or another top-up is ignored', async () => {
      const user = customer();
      const { topup } = await created(user, 100_000);
      await deliver(app, 'payment.topup_captured.v1', {
        paymentId: randomUUID(),
        paymentNo: 'TXN-FAKE',
        topupId: topup.id,
        userId: user,
        amountPaise: 100_000,
        expectedPaise: 100_000,
        currency: 'INR',
        method: 'upi',
        bank: null,
        cardLast4: null,
        cardNetwork: null,
        vpaMasked: null,
        providerPaymentId: 'pay_fake',
      });
      expect((await view(user, topup.id)).status).toBe('PENDING');
      await deliver(app, 'payment.topup_captured.v1', {
        paymentId: randomUUID(),
        paymentNo: 'TXN-FAKE',
        topupId: randomUUID(), // a top-up this wallet never created: logged, not thrown
        userId: user,
        amountPaise: 100_000,
        expectedPaise: 100_000,
        currency: 'INR',
        method: 'upi',
        bank: null,
        cardLast4: null,
        cardNetwork: null,
        vpaMasked: null,
        providerPaymentId: 'pay_fake2',
      });
      expect((await ledgerOf(app, user)).balance).toBe(0n);
    });

    it('payment-service down at start → 503, CREATED; the job resumes and completes it', async () => {
      const user = customer();
      payments.down = true;
      const key = `k-${randomUUID()}`;
      const res = await start(user, { amountPaise: 200_000, method: 'UPI' }, key);
      expect(res.statusCode).toBe(503);
      const row = await db().walletTopup.findFirstOrThrow({
        where: { userId: user, idempotencyKey: key },
      });
      expect(row.status).toBe('CREATED');

      payments.down = false;
      await age(row.id, 3 * 60_000);
      await topups().reconcile(); // creates + links the payment (still open)
      expect((await view(user, row.id)).status).toBe('PENDING');
      payments.capture(row.id);
      await topups().reconcile();
      expect((await view(user, row.id)).status).toBe('COMPLETED');
      expect((await ledgerOf(app, user)).balance).toBe(200_000n);
    });

    it('own top-ups only: another customer gets 404', async () => {
      const owner = customer();
      const { topup } = await created(owner, 100_000);
      const res = await call(app, 'GET', `/wallet/topups/${topup.id}`, { user: customer() });
      expect(res.statusCode).toBe(404);
    });
  },
);
