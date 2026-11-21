import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  customer,
  data,
  delivered,
  errorOf,
  ledgerOf,
  post,
  staff,
} from './harness.js';

let app: FastifyInstance;
const db = () => app.diContainer.resolve('db');

const ALL = ['wallet.view', 'wallet.adjust', 'wallet.approve', 'wallet.configure'];

interface Adjustment {
  id: string;
  status: string;
  journalId: string | null;
}

const request = (by: string, body: object, key = `adj-${randomUUID()}`) =>
  call(app, 'POST', '/admin/wallet/adjustments', {
    user: by,
    payload: body,
    headers: { 'idempotency-key': key },
  });

const credit = (userId: string, amount = 112_000) => ({
  userId,
  ledger: 'WALLET',
  direction: 'CREDIT',
  amount,
  category: 'DAMAGE_CLAIM',
  title: 'Cold Box Damage Refund',
  reason: 'Cold box arrived damaged at Tanuku C&F',
});

describe.skipIf(DB_URL === undefined)('wallet staff console (D-54 W5)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('default deny: customers and staff without the permission get 403', async () => {
    expect(
      (await call(app, 'GET', '/admin/wallet/accounts', { user: customer() })).statusCode,
    ).toBe(403);
    expect((await call(app, 'GET', '/admin/wallet/accounts', { user: staff() })).statusCode).toBe(
      403,
    );
    expect(
      (await call(app, 'GET', '/admin/wallet/accounts', { user: staff('wallet.view') })).statusCode,
    ).toBe(200);
    expect((await request(staff('wallet.view'), credit(customer()))).statusCode).toBe(403);
  });

  it('wallet credit adjustment: request → not by the requester → approved by another → posted once', async () => {
    const user = customer();
    const a = staff(...ALL);
    const b = staff('wallet.view', 'wallet.approve');
    const key = `adj-${randomUUID()}`;
    const created = await request(a, credit(user), key);
    expect(created.statusCode, created.body).toBe(201);
    const adj = data<Adjustment>(created);
    expect(adj.status).toBe('PENDING_APPROVAL');
    expect(data<Adjustment>(await request(a, credit(user), key)).id).toBe(adj.id); // replay
    expect(errorOf(await request(a, credit(user, 1), key)).details?.reason).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect((await ledgerOf(app, user)).balance).toBe(0n); // nothing moved yet

    const self = await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/approve`, {
      user: a,
      payload: {},
    });
    expect(self.statusCode).toBe(403);

    const ok = await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/approve`, {
      user: b,
      payload: { reason: 'Verified with depot photos' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<Adjustment>(ok).status).toBe('POSTED');
    const again = await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/approve`, {
      user: b,
      payload: {},
    });
    expect(errorOf(again).details?.reason).toBe('ALREADY_DECIDED');
    expect((await ledgerOf(app, user)).balance).toBe(112_000n);

    const [t] = data<{ category: string; title: string; statusLabel: string }[]>(
      await call(app, 'GET', '/wallet/transactions', { user }),
    );
    expect(t).toMatchObject({
      category: 'REFUNDS',
      title: 'Cold Box Damage Refund',
      statusLabel: 'Direct Credit',
    });
    const audit = await db().walletAuditLog.findMany({ where: { targetId: adj.id } });
    expect(audit.map((x) => x.action).sort()).toEqual([
      'wallet.adjustment.approve',
      'wallet.adjustment.request',
    ]);
  });

  it('a debit the customer cannot cover is refused and stays pending; reject needs a reason', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 1_000n });
    const a = staff(...ALL);
    const b = staff('wallet.approve');
    const adj = data<Adjustment>(
      await request(a, { ...credit(user, 5_000), direction: 'DEBIT', category: 'CORRECTION' }),
    );
    const refused = await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/approve`, {
      user: b,
      payload: {},
    });
    expect(errorOf(refused).details?.reason).toBe('INSUFFICIENT_BALANCE');
    expect((await db().walletAdjustment.findUniqueOrThrow({ where: { id: adj.id } })).status).toBe(
      'PENDING_APPROVAL',
    );
    expect(
      (
        await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/reject`, {
          user: b,
          payload: {},
        })
      ).statusCode,
    ).toBe(422);
    const rejected = await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/reject`, {
      user: b,
      payload: { reason: 'Customer already settled offline' },
    });
    expect(data<Adjustment>(rejected).status).toBe('REJECTED');
    expect((await ledgerOf(app, user)).balance).toBe(1_000n);
  });

  it('points adjustments: credit makes a spendable lot; a debit above the balance is refused', async () => {
    const user = customer();
    const a = staff(...ALL);
    const b = staff('wallet.approve');
    const adj = data<Adjustment>(
      await request(a, {
        ...credit(user, 2_500),
        ledger: 'POINTS',
        category: 'LOYALTY_BONUS',
        title: 'Gold Quarterly Bonus',
      }),
    );
    await call(app, 'POST', `/admin/wallet/adjustments/${adj.id}/approve`, {
      user: b,
      payload: {},
    });
    const points = data<{ availablePts: number }>(await call(app, 'GET', '/rewards', { user }));
    expect(points.availablePts).toBe(2_500);

    const debit = data<Adjustment>(
      await request(a, { ...credit(user, 3_000), ledger: 'POINTS', direction: 'DEBIT' }),
    );
    const refused = await call(app, 'POST', `/admin/wallet/adjustments/${debit.id}/approve`, {
      user: b,
      payload: {},
    });
    expect(errorOf(refused).details?.reason).toBe('INSUFFICIENT_POINTS');
  });

  it('the database refuses an adjustment decided by its requester', async () => {
    const a = staff(...ALL);
    const adj = data<Adjustment>(await request(a, credit(customer())));
    await expect(
      db().walletAdjustment.update({
        where: { id: adj.id },
        data: { status: 'REJECTED', decidedBy: a, decidedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('freeze blocks wallet checkout debits but not credits; unfreeze; audited', async () => {
    const user = customer();
    await post(app, { userId: user, amountPaise: 50_000n });
    const ops = staff('wallet.view', 'wallet.adjust');
    const frozen = await call(app, 'POST', `/admin/wallet/accounts/${user}/freeze`, {
      user: ops,
      payload: { reason: 'Chargeback dispute under investigation' },
    });
    expect(data<{ status: string }>(frozen).status).toBe('FROZEN');
    const debit = await call(app, 'POST', '/internal/wallet/debits', {
      internal: true,
      payload: {
        paymentId: randomUUID(),
        userId: user,
        orderId: randomUUID(),
        orderNo: 'ORD-26-FROZEN1',
        amountPaise: 100,
      },
    });
    expect(errorOf(debit).details?.reason).toBe('ACCOUNT_FROZEN');
    await post(app, { userId: user, amountPaise: 100n }); // credits still land

    await call(app, 'POST', `/admin/wallet/accounts/${user}/unfreeze`, {
      user: ops,
      payload: { reason: 'Dispute closed in the customer favour' },
    });
    const detail = data<{ wallet: { status: string; balancePaise: number } }>(
      await call(app, 'GET', `/admin/wallet/accounts/${user}`, { user: ops }),
    );
    expect(detail.wallet).toMatchObject({ status: 'ACTIVE', balancePaise: 50_100 });
    const audit = await db().walletAuditLog.findMany({ where: { targetId: user } });
    expect(audit.map((x) => x.action).sort()).toEqual(['wallet.freeze', 'wallet.unfreeze']);
  });

  it('settings: validated (incl. cross-field), audited, applied', async () => {
    const admin = staff('wallet.view', 'wallet.configure');
    const put = (key: string, value: unknown) =>
      call(app, 'PUT', `/admin/wallet/settings/${key}`, {
        user: admin,
        payload: { value, reason: 'Policy change approved by finance' },
      });
    expect((await put('pointsHoldDays', -1)).statusCode).toBe(422);
    expect((await put('noSuchRule', 1)).statusCode).toBe(404);
    expect((await put('pointsMinConvert', 1_050)).statusCode).toBe(422); // not a multiple of 100
    const ok = await put('pointsHoldDays', 5);
    expect(data<{ pointsHoldDays: number }>(ok).pointsHoldDays).toBe(5);
    await put('pointsHoldDays', 7); // restore
    const audit = await db().walletAuditLog.findMany({
      where: { targetType: 'settings', targetId: 'pointsHoldDays' },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    expect(audit).toHaveLength(2);
  });

  it("ledger check: finds a balance changed behind the ledger's back, then resolves it", async (ctx) => {
    // Tampering needs a superuser (session_replication_role): skipped as the least-privileged role.
    const su = await db().$queryRaw<{ s: boolean }[]>`
      SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`;
    if (su[0]?.s !== true) ctx.skip();
    const user = customer();
    await post(app, { userId: user, amountPaise: 7_000n });
    const ops = staff('wallet.view');
    // Simulate tampering that bypasses every trigger (replica role skips them).
    await app.diContainer.resolve('runInTransaction')(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE "wallet_accounts" SET "balancePaise" = 9000 WHERE "userId" = ${user}::uuid`;
    });
    await call(app, 'POST', '/admin/wallet/ledger-checks/run', { user: ops });
    const open = data<{ checkType: string; refId: string; expected: string; actual: string }[]>(
      await call(app, 'GET', '/admin/wallet/ledger-checks?status=OPEN&limit=100', { user: ops }),
    );
    expect(open.find((c) => c.refId === user)).toMatchObject({
      checkType: 'WALLET_BALANCE',
      expected: '7000',
      actual: '9000',
    });

    await app.diContainer.resolve('runInTransaction')(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`UPDATE "wallet_accounts" SET "balancePaise" = 7000 WHERE "userId" = ${user}::uuid`;
    });
    await call(app, 'POST', '/admin/wallet/ledger-checks/run', { user: ops });
    const row = await db().walletLedgerCheck.findUniqueOrThrow({
      where: { checkType_refId: { checkType: 'WALLET_BALANCE', refId: user } },
    });
    expect(row.status).toBe('RESOLVED');
  });

  it('points earned via delivery show in the staff account view', async () => {
    const user = customer();
    await delivered(app, user, 300_000);
    const detail = data<{ points: { pendingPts: number }; recentPoints: unknown[] }>(
      await call(app, 'GET', `/admin/wallet/accounts/${user}`, { user: staff('wallet.view') }),
    );
    expect(detail.points.pendingPts).toBe(300);
    expect(detail.recentPoints).toHaveLength(1);
  });
});
